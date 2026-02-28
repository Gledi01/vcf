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

const execPromise = util.promisify(exec);

// ============= KONFIGURASI =============
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSION_DIR = 'sessions';
const OLLAMA_MODEL = 'qwen3:0.6b'; // Model Qwen3 0.6B

// Cache
const msgRetryCounterCache = new NodeCache();
const logger = pino({ level: 'silent' });
const contactCache = new Map();

// Anti-block config
const CONFIG = {
    MESSAGE_DELAY: 1000,
    USER_COOLDOWN: 1000,
    AUTO_READ: true
};

// Cooldown tracker
const userCooldown = new Map();

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
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    };
    
    const formatter = new Intl.DateTimeFormat('id-ID', options);
    const parts = formatter.formatToParts(now);
    
    let date = '', time = '';
    for (const part of parts) {
        if (part.type === 'year') date = part.value + '-' + date;
        if (part.type === 'month') date = date + part.value + '-';
        if (part.type === 'day') date = part.value;
        if (part.type === 'hour') time = part.value;
        if (part.type === 'minute') time = time + ':' + part.value;
        if (part.type === 'second') time = time + ':' + part.value;
    }
    
    return { full: `${date} ${time} WIB`, date, time };
}

// ============= FUNGSI LOG PESAN =============
async function logMessage(sock, msg, messageContent, isGroup, response = null) {
    try {
        const jid = msg.key.remoteJid;
        const sender = msg.key.participant || jid;
        const senderNumber = sender.split('@')[0];
        
        const contactName = await getContactName(sock, jid);
        const waktu = getFormattedTime();
        
        // Tampilkan di konsol
        console.log('\n' + '─'.repeat(60));
        console.log(`🕐 ${waktu.full}`);
        console.log(`👤 Nama: ${contactName}`);
        console.log(`📞 Nomor: ${senderNumber}`);
        console.log(`💬 Chat: ${messageContent || '[Media]'}`);
        console.log(`📌 Tipe: ${isGroup ? 'Grup' : 'Personal'}`);
        
        if (response) {
            console.log(`🤖 AI: ${response.substring(0, 100)}${response.length > 100 ? '...' : ''}`);
        }
        console.log('─'.repeat(60));
        
    } catch (error) {
        console.error('❌ Error logging:', error.message);
    }
}

// ============= FUNGSI CEK OLLAMA =============
async function checkOllama() {
    try {
        const { stdout } = await execPromise('ollama list');
        if (stdout.includes(OLLAMA_MODEL)) {
            console.log(`✅ Model ${OLLAMA_MODEL} tersedia`);
            return true;
        } else {
            console.log(`❌ Model ${OLLAMA_MODEL} tidak ditemukan`);
            console.log(`📥 Install: ollama pull ${OLLAMA_MODEL}`);
            return false;
        }
    } catch (error) {
        console.log('❌ Ollama tidak berjalan');
        console.log('🚀 Jalankan: ollama serve');
        return false;
    }
}

// ============= FUNGSI GENERATE AI =============
async function generateAIResponse(prompt) {
    try {
        console.log(`🤔 AI memproses: "${prompt.substring(0, 50)}..."`);
        
        const escapedPrompt = prompt.replace(/"/g, '\\"');
        
        const { stdout, stderr } = await execPromise(
            `ollama run ${OLLAMA_MODEL} "${escapedPrompt}"`,
            { timeout: 30000 }
        );
        
        if (stderr) {
            console.error('⚠️ Ollama stderr:', stderr);
        }
        
        return stdout.trim() || '❌ Tidak ada respons';
        
    } catch (error) {
        console.error('❌ Error Ollama:', error.message);
        
        if (error.message.includes('timeout')) {
            return '❌ AI terlalu lama merespons';
        }
        return '❌ Error, coba lagi nanti';
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

// ============= FUNGSI DELAY =============
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============= FUNGSI KONEKSI WHATSAPP =============
async function connectToWhatsApp() {
    console.log('\n🔄 Menghubungkan ke WhatsApp...');
    
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
        browser: ['Qwen3 Bot', 'Chrome', '1.0.0'],
        version: version,
        syncFullHistory: false,
        msgRetryCounterCache,
        defaultQueryTimeoutMs: 60000
    });

    // QR Code
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n' + '='.repeat(50));
            console.log('📱 SCAN QR CODE');
            console.log('='.repeat(50));
            qrcode.generate(qr, { small: true });
            console.log('\n⏳ Scan dengan WhatsApp Anda...\n');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('❌ Koneksi terputus, reconnect dalam 3 detik...');
                setTimeout(() => connectToWhatsApp(), 3000);
            }
        } else if (connection === 'open') {
            console.log('\n✅ BOT QWEN3 SIAP!');
            console.log(`🤖 Model: ${OLLAMA_MODEL}`);
            console.log('📝 Command: .ai [pertanyaan]\n');
        }
    });

    sock.ev.on('creds.update', saveCreds);
    
    // Handler pesan
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (let msg of messages) {
            try {
                if (!msg.message || msg.key?.remoteJid === 'status@broadcast') continue;
                if (msg.key?.fromMe) continue;

                // Ambil teks
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
                if (CONFIG.AUTO_READ) {
                    await sock.readMessages([msg.key]);
                }

                // Log pesan masuk
                await logMessage(sock, msg, messageContent, isGroup);

                // Proses command .ai
                if (messageContent.startsWith('.ai')) {
                    
                    // Cek cooldown
                    const cooldown = checkCooldown(jid);
                    if (!cooldown.allowed) {
                        await sock.sendMessage(jid, { 
                            text: `⏳ Tunggu ${cooldown.remaining} detik` 
                        });
                        continue;
                    }

                    const args = messageContent.substring(4).trim();
                    
                    if (!args) {
                        await sock.sendMessage(jid, { 
                            text: '❌ Format: .ai [pertanyaan]\nContoh: .ai apa itu AI?' 
                        });
                        continue;
                    }

                    // Cek status
                    if (args.toLowerCase() === 'status') {
                        const modelReady = await checkOllama();
                        await sock.sendMessage(jid, { 
                            text: modelReady ? 
                                `✅ AI ${OLLAMA_MODEL} siap digunakan` : 
                                `❌ AI ${OLLAMA_MODEL} tidak tersedia` 
                        });
                        continue;
                    }

                    // Proses AI
                    await sock.sendPresenceUpdate('composing', jid);
                    await delay(1000);
                    
                    await sock.sendMessage(jid, { text: '⏳ Memproses...' });

                    const startTime = Date.now();
                    const aiResponse = await generateAIResponse(args);
                    const processTime = ((Date.now() - startTime) / 1000).toFixed(1);

                    await delay(1000);

                    const responseText = `*🧠 Qwen3 AI* (${processTime}s)\n\n${aiResponse}`;
                    await sock.sendMessage(jid, { text: responseText });

                    // Log dengan response
                    await logMessage(sock, msg, messageContent, isGroup, aiResponse);
                }

            } catch (error) {
                if (!error.message?.includes('Bad MAC')) {
                    console.error('❌ Error:', error.message);
                }
            }
        }
    });

    return sock;
}

// ============= FUNGSI UTAMA =============
async function main() {
    console.log('='.repeat(60));
    console.log('🤖 BOT WHATSAPP + QWEN3 0.6B');
    console.log('='.repeat(60));
    
    console.log('\n🔍 Memeriksa Ollama...');
    await checkOllama();
    
    console.log('\n📋 FITUR:');
    console.log('   ✓ AI Qwen3 0.6B');
    console.log('   ✓ Log Nama Kontak');
    console.log('   ✓ Log Isi Chat');
    console.log('   ✓ Log Jam');
    console.log('   ✓ Anti-spam cooldown\n');
    
    try {
        await connectToWhatsApp();
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

// Handle shutdown
process.on('SIGINT', () => {
    console.log('\n\n👋 Bot dimatikan');
    process.exit(0);
});

main();
