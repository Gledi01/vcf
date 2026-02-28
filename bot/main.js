import makeWASocket, { 
    DisconnectReason, 
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import NodeCache from 'node-cache';
import { exec } from 'child_process';
import util from 'util';
import axios from 'axios';
import * as publicIp from 'public-ip';

const execPromise = util.promisify(exec);

// ============= KONFIGURASI =============
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSION_DIR = 'sessions';
const OLLAMA_MODEL = 'Qwen3:0.6b';

// Cache
const msgRetryCounterCache = new NodeCache();
const logger = pino({ level: 'silent' });
const contactCache = new Map();
const ipCache = new Map();

// ============= FUNGSI HAPUS SESSION CORRUPT =============
function cleanupCorruptedSessions() {
    try {
        if (!fs.existsSync(SESSION_DIR)) return;
        
        const files = fs.readdirSync(SESSION_DIR);
        let deletedCount = 0;
        
        for (const file of files) {
            // Hapus file session yang mencurigakan (ukuran 0 bytes atau corrupted)
            if (file.startsWith('session-') && file.endsWith('.json')) {
                const filePath = path.join(SESSION_DIR, file);
                const stats = fs.statSync(filePath);
                
                // Hapus jika ukuran terlalu kecil (< 100 bytes) atau terlalu besar (> 10MB)
                if (stats.size < 100 || stats.size > 10 * 1024 * 1024) {
                    fs.unlinkSync(filePath);
                    console.log(`🗑️  Hapus session corrupt: ${file}`);
                    deletedCount++;
                }
            }
        }
        
        if (deletedCount > 0) {
            console.log(`✅ Berhasil hapus ${deletedCount} session corrupt`);
        }
        
        // Simpan timestamp cleanup
        fs.writeFileSync(
            path.join(SESSION_DIR, 'last_cleanup.txt'), 
            new Date().toISOString()
        );
        
    } catch (error) {
        console.error('❌ Error cleanup sessions:', error.message);
    }
}

// ============= FUNGSI DETEKSI BAD MAC LOOP =============
const badMacTracker = new Map();

function isBadMacLoop(sessionId) {
    const now = Date.now();
    const records = badMacTracker.get(sessionId) || [];
    
    // Filter records dalam 5 menit terakhir
    const recent = records.filter(time => now - time < 5 * 60 * 1000);
    
    if (recent.length >= 10) { // Jika 10+ error dalam 5 menit
        return true;
    }
    
    recent.push(now);
    badMacTracker.set(sessionId, recent);
    return false;
}

// ============= FUNGSI GET IP =============
async function getPublicIP() {
    try {
        const ip = await publicIp.v4();
        return ip;
    } catch (error) {
        try {
            const response = await axios.get('https://api.ipify.org?format=json');
            return response.data.ip;
        } catch {
            return 'Unknown IP';
        }
    }
}

// ============= FUNGSI GET GEOLOKASI =============
async function getGeoLocation(ip) {
    try {
        if (ip === 'Unknown IP') return null;
        if (ipCache.has(ip)) return ipCache.get(ip);

        const response = await axios.get(`https://ipapi.co/${ip}/json/`);
        
        if (response.data && !response.data.error) {
            const geoData = {
                country: response.data.country_name || 'Unknown',
                city: response.data.city || 'Unknown',
                region: response.data.region || 'Unknown',
                latitude: response.data.latitude || 'Unknown',
                longitude: response.data.longitude || 'Unknown',
                isp: response.data.org || 'Unknown',
                timezone: response.data.timezone || 'Unknown'
            };
            ipCache.set(ip, geoData);
            return geoData;
        }
        return null;
    } catch (error) {
        return null;
    }
}

// ============= FUNGSI GET NAMA KONTAK =============
async function getContactName(sock, jid) {
    try {
        if (contactCache.has(jid)) return contactCache.get(jid);

        let name = 'Unknown';
        if (jid.endsWith('@s.whatsapp.net')) {
            const [number] = jid.split('@');
            try {
                const contact = await sock.fetchContact(jid);
                name = contact?.name || contact?.notify || contact?.verifiedName || number;
            } catch {
                name = number;
            }
        } else if (jid.endsWith('@g.us')) {
            try {
                const groupMetadata = await sock.groupMetadata(jid);
                name = groupMetadata.subject || 'Unknown Group';
            } catch {
                name = 'Unknown Group';
            }
        }
        
        contactCache.set(jid, name);
        return name;
    } catch (error) {
        return jid.split('@')[0];
    }
}

// ============= FUNGSI FORMAT WAKTU =============
function getFormattedTime() {
    const now = new Date();
    const options = {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    };
    
    const formatter = new Intl.DateTimeFormat('id-ID', options);
    const parts = formatter.formatToParts(now);
    
    let date = '', time = '';
    for (const part of parts) {
        if (part.type === 'year') date += part.value;
        if (part.type === 'month') date += '-' + part.value;
        if (part.type === 'day') date += '-' + part.value;
        if (part.type === 'hour') time += part.value;
        if (part.type === 'minute') time += ':' + part.value;
        if (part.type === 'second') time += ':' + part.value;
    }
    
    return { full: `${date} ${time} WIB`, date, time };
}

// ============= FUNGSI LOG PESAN =============
async function logMessageDetails(sock, msg, messageContent, isGroup, response = null) {
    try {
        const jid = msg.key.remoteJid;
        const sender = msg.key.participant || jid;
        const senderNumber = sender.split('@')[0];
        
        const contactName = await getContactName(sock, jid);
        const waktu = getFormattedTime();
        const botIP = await getPublicIP();
        const geoLocation = await getGeoLocation(botIP);
        
        console.log('\n' + '═'.repeat(80));
        console.log(`📱 DETAIL PESAN MASUK [${waktu.full}]`);
        console.log('═'.repeat(80));
        
        console.log(`👤 KONTAK:`);
        console.log(`   • Nama: ${contactName}`);
        console.log(`   • Nomor: ${senderNumber}`);
        console.log(`   • Tipe: ${isGroup ? 'Grup' : 'Personal'}`);
        
        console.log(`\n💬 PESAN:`);
        console.log(`   • Isi: ${messageContent || '[Media/Non-text]'}`);
        console.log(`   • Waktu: ${waktu.time}`);
        console.log(`   • Tanggal: ${waktu.date}`);
        
        console.log(`\n🖥️  SERVER:`);
        console.log(`   • IP Publik: ${botIP}`);
        
        if (geoLocation) {
            console.log(`\n🌍 GEOLOKASI:`);
            console.log(`   • Negara: ${geoLocation.country}`);
            console.log(`   • Kota: ${geoLocation.city}`);
            console.log(`   • ISP: ${geoLocation.isp}`);
        }
        
        if (response) {
            console.log(`\n🤖 RESPON AI:`);
            console.log(`   • ${response.substring(0, 100)}${response.length > 100 ? '...' : ''}`);
        }
        
        console.log('\n' + '═'.repeat(80) + '\n');
        
    } catch (error) {
        console.error('❌ Error logging:', error.message);
    }
}

// ============= FUNGSI CEK OLLAMA =============
async function checkOllama() {
    try {
        const { stdout } = await execPromise('ollama list');
        if (stdout.includes(OLLAMA_MODEL)) {
            return { status: true, message: `✅ Model ${OLLAMA_MODEL} tersedia` };
        } else {
            return { 
                status: false, 
                message: `❌ Model ${OLLAMA_MODEL} tidak ditemukan\nInstall: ollama pull ${OLLAMA_MODEL}` 
            };
        }
    } catch (error) {
        return { 
            status: false, 
            message: '❌ Ollama tidak terinstall atau tidak berjalan' 
        };
    }
}

// ============= FUNGSI GENERATE AI =============
async function generateAIResponse(prompt) {
    try {
        console.log(`🤔 AI Memproses: "${prompt.substring(0, 50)}..."`);
        
        const escapedPrompt = prompt.replace(/"/g, '\\"');
        
        const { stdout, stderr } = await execPromise(
            `ollama run ${OLLAMA_MODEL} "${escapedPrompt}"`,
            { timeout: 30000 }
        );
        
        if (stderr) console.error('⚠️ Ollama stderr:', stderr);
        
        return stdout.trim() || '❌ Tidak ada respons dari AI';
        
    } catch (error) {
        console.error('❌ Error Ollama:', error.message);
        return '❌ Maaf, terjadi error. Coba lagi nanti.';
    }
}

// ============= FUNGSI KONEKSI WHATSAPP =============
async function connectToWhatsApp(retryCount = 0) {
    console.log('\n🔄 Memulai koneksi WhatsApp...');
    
    // Bersihkan session corrupt sebelum connect
    cleanupCorruptedSessions();

    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR);
    }

    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    
    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        printQRInTerminal: false,
        logger: logger,
        browser: ['Bot AI', 'Chrome', '1.0.0'],
        version: version,
        syncFullHistory: false,
        msgRetryCounterCache,
        defaultQueryTimeoutMs: 60000,
        markOnlineOnConnect: false,
        
        // PENTING: Handle error decrypt
        shouldIgnoreJid: (jid) => {
            // Ignore error untuk ID tertentu jika perlu
            return false;
        }
    });

    // HANDLE ERROR DECRYPT - SOLUSI UTAMA
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (let msg of messages) {
            try {
                // Skip pesan dari bot sendiri
                if (msg.key?.fromMe) continue;
                
                // Cek apakah ini pesan decrypt error
                if (msg.messageStubType === 'ERROR_DECRYPT') {
                    console.log('⚠️  Pesan tidak bisa didekripsi (BAD MAC), melewatkan...');
                    
                    // Catat session ID yang error
                    const sessionId = msg.key?.remoteJid;
                    if (sessionId && isBadMacLoop(sessionId)) {
                        console.log(`🔄 Deteksi loop BAD MAC untuk ${sessionId}, membersihkan session...`);
                        
                        // Hapus file session yang bermasalah
                        const files = fs.readdirSync(SESSION_DIR);
                        for (const file of files) {
                            if (file.includes(sessionId.replace(/[^0-9]/g, ''))) {
                                fs.unlinkSync(path.join(SESSION_DIR, file));
                                console.log(`🗑️  Hapus session: ${file}`);
                            }
                        }
                    }
                    
                    continue; // Skip proses lebih lanjut
                }

                // Proses pesan normal
                let messageContent = '';
                if (msg.message?.conversation) {
                    messageContent = msg.message.conversation;
                } else if (msg.message?.extendedTextMessage?.text) {
                    messageContent = msg.message.extendedTextMessage.text;
                } else {
                    continue; // Skip non-text
                }

                const jid = msg.key.remoteJid;
                const isGroup = jid.endsWith('@g.us');

                // Auto-read
                await sock.readMessages([msg.key]);

                // Log pesan
                await logMessageDetails(sock, msg, messageContent, isGroup);

                // Process command
                if (messageContent.startsWith('.ai')) {
                    const args = messageContent.substring(4).trim();
                    
                    if (!args) {
                        await sock.sendMessage(jid, { 
                            text: '❌ Format: .ai [pertanyaan]' 
                        });
                        continue;
                    }

                    if (args.toLowerCase() === 'status') {
                        const ollamaStatus = await checkOllama();
                        await sock.sendMessage(jid, { 
                            text: `📊 *STATUS AI*\n\n${ollamaStatus.message}` 
                        });
                        continue;
                    }

                    await sock.sendPresenceUpdate('composing', jid);
                    
                    const startTime = Date.now();
                    const aiResponse = await generateAIResponse(args);
                    const processTime = ((Date.now() - startTime) / 1000).toFixed(1);

                    const responseText = `*🧠 AI* (${processTime}s)\n\n${aiResponse}`;
                    await sock.sendMessage(jid, { text: responseText });

                    await logMessageDetails(sock, msg, messageContent, isGroup, aiResponse);
                }

            } catch (error) {
                // Ignore Bad MAC error - jangan tampilkan ke user
                if (error.message?.includes('Bad MAC')) {
                    console.log('⚠️  Bad MAC error (diabaikan)');
                } else {
                    console.error('❌ Error:', error.message);
                }
            }
        }
    });

    // Handle connection update
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n' + '='.repeat(50));
            console.log('📱 SCAN QR CODE INI DENGAN WHATSAPP ANDA');
            console.log('='.repeat(50));
            qrcode.generate(qr, { small: true });
            console.log('\n⏳ Menunggu scan...\n');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            if (statusCode === 440 || statusCode === 515) {
                console.log('⚠️  Session expired/corrupt, membersihkan...');
                cleanupCorruptedSessions();
            }
            
            if (shouldReconnect) {
                const nextRetry = Math.min(5000 * (retryCount + 1), 30000);
                console.log(`❌ Koneksi terputus, reconnect dalam ${nextRetry/1000} detik...`);
                setTimeout(() => connectToWhatsApp(retryCount + 1), nextRetry);
            }
        } else if (connection === 'open') {
            console.log('\n✅ BOT AI BERHASIL TERHUBUNG!');
            console.log('🤖 Fitur anti-BAD MAC aktif');
            
            const botIP = await getPublicIP();
            const geo = await getGeoLocation(botIP);
            console.log(`🖥️  IP: ${botIP} | Lokasi: ${geo?.city || 'Unknown'}, ${geo?.country || 'Unknown'}\n`);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    return sock;
}

// ============= FUNGSI UTAMA =============
async function main() {
    console.log('='.repeat(80));
    console.log('🤖 BOT WHATSAPP AI - FIX BAD MAC ERROR');
    console.log('='.repeat(80));
    
    // Bersihkan session sebelum mulai
    console.log('\n🧹 Membersihkan session corrupt...');
    cleanupCorruptedSessions();
    
    console.log('\n🔍 Memeriksa Ollama...');
    const ollamaStatus = await checkOllama();
    console.log(ollamaStatus.message);
    
    console.log('\n🔄 Menghubungkan ke WhatsApp...\n');
    
    try {
        await connectToWhatsApp();
    } catch (error) {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    }
}

process.on('SIGINT', () => {
    console.log('\n\n👋 Bot dimatikan');
    process.exit(0);
});

main();
