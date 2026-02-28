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
import * as publicIp from 'public-ip'; // PERBAIKAN: gunakan * as

const execPromise = util.promisify(exec);

// ============= KONFIGURASI =============
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSION_DIR = 'sessions';
const OLLAMA_MODEL = 'Qwen3:0.6b'; // Model 0.5B (ringan)

// Cache
const msgRetryCounterCache = new NodeCache();
const logger = pino({ level: 'silent' });
const contactCache = new Map();
const ipCache = new Map();

// Anti-block configuration
const CONFIG = {
    MESSAGE_DELAY: 2000,
    GROUP_MESSAGE_DELAY: 3000,
    MAX_MESSAGES_PER_MINUTE: 30,
    USER_COOLDOWN: 5000,
    AUTO_READ: true,
    MARK_ONLINE: false,
    RECONNECT_DELAY: 5000
};

// Cache untuk cooldown
const userCooldown = new Map();
const messageCounter = {
    count: 0,
    resetTime: Date.now() + 60000
};

// ============= FUNGSI DAPATKAN IP PUBLIK =============
async function getPublicIP() {
    try {
        // PERBAIKAN: publicIp.v4() bukan default export
        const ip = await publicIp.v4();
        return ip;
    } catch (error) {
        // Fallback ke API lain jika public-ip gagal
        try {
            const response = await axios.get('https://api.ipify.org?format=json');
            return response.data.ip;
        } catch {
            try {
                const response = await axios.get('https://api.myip.com');
                return response.data.ip;
            } catch {
                return 'Unknown IP';
            }
        }
    }
}

// ============= FUNGSI DAPATKAN GEOLOKASI DARI IP =============
async function getGeoLocation(ip) {
    try {
        if (ip === 'Unknown IP') return null;
        
        if (ipCache.has(ip)) {
            return ipCache.get(ip);
        }

        // Gunakan ipapi.co (gratis)
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

// ============= FUNGSI FORMAT GEOLOKASI =============
function formatGeoLocation(geo) {
    if (!geo) return '🌍 Geolokasi: Tidak tersedia';
    
    return `🌍 GEOLOKASI:
   • Negara: ${geo.country}
   • Kota: ${geo.city}
   • Region: ${geo.region}
   • ISP: ${geo.isp}
   • Timezone: ${geo.timezone}
   • Koordinat: ${geo.latitude}, ${geo.longitude}`;
}

// ============= FUNGSI DAPATKAN NAMA KONTAK =============
async function getContactName(sock, jid) {
    try {
        if (contactCache.has(jid)) {
            return contactCache.get(jid);
        }

        let name = 'Unknown';
        
        if (jid.endsWith('@s.whatsapp.net')) {
            const [number] = jid.split('@');
            try {
                // Coba dapatkan contact name
                const contact = await sock.fetchContact(jid);
                name = contact?.name || contact?.notify || contact?.verifiedName || number;
            } catch {
                name = number;
            }
        }
        else if (jid.endsWith('@g.us')) {
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
    
    let date = '';
    let time = '';
    
    for (const part of parts) {
        if (part.type === 'year') date += part.value;
        if (part.type === 'month') date += '-' + part.value;
        if (part.type === 'day') date += '-' + part.value;
        if (part.type === 'hour') time += part.value;
        if (part.type === 'minute') time += ':' + part.value;
        if (part.type === 'second') time += ':' + part.value;
    }
    
    return {
        full: `${date} ${time} WIB`,
        date,
        time
    };
}

// ============= FUNGSI LOG PESAN LENGKAP =============
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
            console.log(`\n${formatGeoLocation(geoLocation)}`);
        }
        
        if (response) {
            console.log(`\n🤖 RESPON AI:`);
            console.log(`   • ${response.substring(0, 100)}${response.length > 100 ? '...' : ''}`);
            console.log(`   • Panjang: ${response.length} karakter`);
        }
        
        console.log('\n' + '═'.repeat(80) + '\n');
        
        return { contactName, waktu, botIP, geoLocation };
        
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

// ============= FUNGSI GENERATE AI DENGAN EXEC =============
async function generateAIResponse(prompt) {
    try {
        console.log(`🤔 AI Memproses: "${prompt.substring(0, 50)}..."`);
        
        const escapedPrompt = prompt.replace(/"/g, '\\"');
        
        const { stdout, stderr } = await execPromise(
            `ollama run ${OLLAMA_MODEL} "${escapedPrompt}"`,
            { timeout: 30000 }
        );
        
        if (stderr) {
            console.error('⚠️ Ollama stderr:', stderr);
        }
        
        return stdout.trim() || '❌ Tidak ada respons dari AI';
        
    } catch (error) {
        console.error('❌ Error Ollama:', error.message);
        
        if (error.message.includes('timeout')) {
            return '❌ AI terlalu lama merespons. Coba pertanyaan yang lebih sederhana.';
        }
        if (error.message.includes('not found')) {
            return '❌ Ollama tidak ditemukan. Pastikan Ollama sudah terinstall.';
        }
        return '❌ Maaf, terjadi error. Coba lagi nanti.';
    }
}

// ============= FUNGSI CEK COOLDOWN =============
function checkCooldown(userId) {
    const now = Date.now();
    const lastCommand = userCooldown.get(userId) || 0;
    
    if (now - lastCommand < CONFIG.USER_COOLDOWN) {
        const remaining = Math.ceil((CONFIG.USER_COOLDOWN - (now - lastCommand)) / 1000);
        return { allowed: false, remaining };
    }
    
    userCooldown.set(userId, now);
    return { allowed: true, remaining: 0 };
}

// ============= FUNGSI CEK RATE LIMIT =============
function checkRateLimit() {
    const now = Date.now();
    
    if (now > messageCounter.resetTime) {
        messageCounter.count = 0;
        messageCounter.resetTime = now + 60000;
    }
    
    if (messageCounter.count >= CONFIG.MAX_MESSAGES_PER_MINUTE) {
        return false;
    }
    
    messageCounter.count++;
    return true;
}

// ============= FUNGSI DELAY =============
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============= FUNGSI KONEKSI WHATSAPP =============
async function connectToWhatsApp() {
    console.log('\n🔄 Memulai koneksi WhatsApp...');
    
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
        browser: ['Bot AI Logger', 'Chrome', '1.0.0'],
        version: version,
        syncFullHistory: false,
        msgRetryCounterCache,
        defaultQueryTimeoutMs: 60000,
        markOnlineOnConnect: CONFIG.MARK_ONLINE
    });

    // Handle QR Code
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
            
            if (shouldReconnect) {
                console.log(`❌ Koneksi terputus, reconnect dalam ${CONFIG.RECONNECT_DELAY/1000} detik...`);
                setTimeout(() => connectToWhatsApp(), CONFIG.RECONNECT_DELAY);
            }
        } else if (connection === 'open') {
            console.log('\n✅ BOT AI LOGGER BERHASIL TERHUBUNG!');
            console.log(`🤖 Model AI: ${OLLAMA_MODEL}`);
            console.log('📝 Command: .ai [pertanyaan]');
            console.log('📝 Setiap pesan akan dilog dengan detail lengkap\n');
            
            const botIP = await getPublicIP();
            const geo = await getGeoLocation(botIP);
            console.log('🖥️  INFORMASI SERVER:');
            console.log(`   • IP: ${botIP}`);
            if (geo) {
                console.log(`   • Lokasi: ${geo.city}, ${geo.country}`);
                console.log(`   • ISP: ${geo.isp}`);
            }
            console.log('');
        }
    });

    sock.ev.on('creds.update', saveCreds);
    
    // Handler pesan
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (let msg of messages) {
            try {
                if (!msg.message || msg.key?.remoteJid === 'status@broadcast') continue;
                if (msg.key?.fromMe) continue;

                let messageContent = '';
                if (msg.message?.conversation) {
                    messageContent = msg.message.conversation;
                } else if (msg.message?.extendedTextMessage?.text) {
                    messageContent = msg.message.extendedTextMessage.text;
                }

                const jid = msg.key.remoteJid;
                const isGroup = jid.endsWith('@g.us');

                // Auto-read
                if (CONFIG.AUTO_READ && !msg.key.fromMe) {
                    await sock.readMessages([msg.key]);
                }

                // Log pesan masuk
                if (messageContent) {
                    await logMessageDetails(sock, msg, messageContent, isGroup);
                }

                // Proses command
                if (messageContent && messageContent.startsWith('.')) {
                    
                    if (!checkRateLimit()) {
                        console.log('⚠️ Rate limit exceeded');
                        continue;
                    }

                    const command = messageContent.split(' ')[0].toLowerCase();
                    const args = messageContent.substring(command.length).trim();

                    // Command .ai
                    if (command === '.ai') {
                        const cooldown = checkCooldown(jid);
                        if (!cooldown.allowed) {
                            await sock.sendMessage(jid, { 
                                text: `⏳ Tunggu ${cooldown.remaining} detik` 
                            });
                            continue;
                        }

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
                        await delay(1000);
                        
                        await sock.sendMessage(jid, { text: '⏳ Memproses...' });

                        const startTime = Date.now();
                        const aiResponse = await generateAIResponse(args);
                        const processTime = ((Date.now() - startTime) / 1000).toFixed(1);

                        await delay(1000);

                        const responseText = `*🧠 AI ${OLLAMA_MODEL}* (${processTime}s)\n\n${aiResponse}`;
                        await sock.sendMessage(jid, { text: responseText });

                        console.log(`✅ Respon AI terkirim (${processTime}s)`);
                        
                        await logMessageDetails(sock, msg, messageContent, isGroup, aiResponse);
                    }

                    // Command .help
                    if (command === '.help') {
                        const helpText = `*🤖 BOT AI LOGGER*\n\n` +
                            `*Model:* ${OLLAMA_MODEL}\n` +
                            `*Command:*\n` +
                            `• .ai [tanya] - Tanya AI\n` +
                            `• .ai status - Cek status\n` +
                            `• .help - Bantuan\n\n` +
                            `*Fitur:*\n` +
                            `• Log nama kontak\n` +
                            `• Log waktu & tanggal\n` +
                            `• Log IP server\n` +
                            `• Log geolokasi`;
                        
                        await sock.sendMessage(jid, { text: helpText });
                    }
                }

            } catch (error) {
                console.error('❌ Error handler:', error.message);
            }
        }
    });

    return sock;
}

// ============= FUNGSI UTAMA =============
async function main() {
    console.log('='.repeat(80));
    console.log('🤖 BOT WHATSAPP AI + LOGGER LENGKAP');
    console.log('='.repeat(80));
    
    console.log('\n📋 FITUR:');
    console.log('   ✓ AI Qwen2.5 0.5B');
    console.log('   ✓ Log nama kontak');
    console.log('   ✓ Log isi pesan');
    console.log('   ✓ Log waktu (jam & tanggal)');
    console.log('   ✓ Log IP server');
    console.log('   ✓ Log geolokasi dari IP');
    console.log('   ✓ Anti-block system\n');
    
    console.log('🔍 Memeriksa Ollama...');
    const ollamaStatus = await checkOllama();
    console.log(ollamaStatus.message);
    
    if (!ollamaStatus.status) {
        console.log('\n⚠️  Install Ollama dan model:');
        console.log('   curl -fsSL https://ollama.com/install.sh | sh');
        console.log(`   ollama pull ${OLLAMA_MODEL}\n`);
    }

    console.log('\n🔄 Menghubungkan ke WhatsApp...\n');
    
    try {
        await connectToWhatsApp();
    } catch (error) {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    }
}

// Handle shutdown
process.on('SIGINT', () => {
    console.log('\n\n👋 Bot dimatikan');
    process.exit(0);
});

main();
