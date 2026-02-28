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
const OLLAMA_MODEL = 'qwen2.5';

// Anti-block configuration
const CONFIG = {
    // Delay antar pesan (dalam ms)
    MESSAGE_DELAY: 2000, // 2 detik
    
    // Delay untuk grup
    GROUP_MESSAGE_DELAY: 3000, // 3 detik untuk grup
    
    // Maksimal pesan per menit
    MAX_MESSAGES_PER_MINUTE: 30,
    
    // Jeda antar command dari user yang sama
    USER_COOLDOWN: 5000, // 5 detik
    
    // Auto-read pesan
    AUTO_READ: true,
    
    // Mark online/offline
    MARK_ONLINE: false, // Jangan selalu online
    
    // Reconnect delay
    RECONNECT_DELAY: 5000
};

// Cache untuk cooldown
const userCooldown = new Map();
const messageCounter = {
    count: 0,
    resetTime: Date.now() + 60000
};

// Cache untuk performa
const msgRetryCounterCache = new NodeCache();
const logger = pino({ level: 'silent' }); // Minimal logging untuk keamanan

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
    
    // Reset counter setiap menit
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
            message: '❌ Ollama tidak terinstall atau tidak berjalan\nInstall: https://ollama.com' 
        };
    }
}

// ============= FUNGSI GENERATE AI DENGAN EXEC =============
async function generateAIResponse(prompt) {
    try {
        console.log(`🤔 Memproses pertanyaan...`);
        
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
        return '❌ Maaf, terjadi error. Coba lagi nanti.';
    }
}

// ============= FUNGSI KONEKSI WHATSAPP =============
async function connectToWhatsApp() {
    console.log('\n🔄 Memulai koneksi WhatsApp (mode stabil)...');
    
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
        browser: ['Chrome', 'Windows', '10.0'], // Browser umum untuk fingerprint
        version: version,
        syncFullHistory: false,
        msgRetryCounterCache,
        defaultQueryTimeoutMs: 60000,
        
        // Pengaturan untuk stabilitas
        emitOwnEvents: false,
        fireInitQueries: false,
        markOnlineOnConnect: CONFIG.MARK_ONLINE,
        
        // Transaction receipt
        shouldIgnoreJid: (jid) => {
            // Abaikan jid tertentu jika perlu
            return false;
        }
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
            
            console.log(`❌ Koneksi terputus (${statusCode})`);
            
            if (statusCode === 429) {
                console.log('⚠️  Terdeteksi spam/rate limit! Menunggu lebih lama...');
                await delay(CONFIG.RECONNECT_DELAY * 3);
            } else if (statusCode === 401) {
                console.log('⚠️  Session expired, hapus folder sessions');
            }
            
            if (shouldReconnect) {
                console.log(`🔄 Reconnect dalam ${CONFIG.RECONNECT_DELAY/1000} detik...`);
                setTimeout(() => connectToWhatsApp(), CONFIG.RECONNECT_DELAY);
            }
        } else if (connection === 'open') {
            console.log('\n✅ BOT STABIL BERHASIL TERHUBUNG!');
            console.log('📝 Mode anti-block aktif');
            console.log('📝 Delay antar pesan:', CONFIG.MESSAGE_DELAY, 'ms');
            console.log('📝 Max pesan/menit:', CONFIG.MAX_MESSAGES_PER_MINUTE);
            console.log('\n📝 Command: .ai [pertanyaan]\n');
        }
    });

    sock.ev.on('creds.update', saveCreds);
    
    // Handler pesan dengan auto-read
    sock.ev.on('messages.upsert', async ({ messages }) => {
        // Auto-read pesan
        if (CONFIG.AUTO_READ) {
            for (let msg of messages) {
                if (msg.key && !msg.key.fromMe) {
                    await sock.readMessages([msg.key]);
                }
            }
        }
        
        // Proses pesan setelah delay kecil
        await delay(500);
        await handleMessages(sock, messages);
    });

    return sock;
}

// ============= HANDLER PESAN =============
async function handleMessages(sock, messages) {
    for (let msg of messages) {
        try {
            // Skip pesan status dan pesan dari bot sendiri
            if (!msg.message || msg.key?.remoteJid === 'status@broadcast') continue;
            if (msg.key?.fromMe) continue;

            // Ambil teks pesan
            let messageContent = '';
            if (msg.message?.conversation) {
                messageContent = msg.message.conversation;
            } else if (msg.message?.extendedTextMessage?.text) {
                messageContent = msg.message.extendedTextMessage.text;
            } else {
                continue; // Skip pesan non-teks untuk keamanan
            }

            const jid = msg.key.remoteJid;
            const sender = msg.key.participant || jid;
            const isGroup = jid.endsWith('@g.us');

            // Skip jika bukan command
            if (!messageContent.startsWith('.')) continue;

            // Log internal saja (tidak terlalu detail)
            console.log(`📨 Command: ${messageContent.split(' ')[0]}`);

            // Cek rate limit global
            if (!checkRateLimit()) {
                console.log('⚠️ Rate limit exceeded, skip command');
                return;
            }

            // Cek cooldown per user
            const cooldown = checkCooldown(sender);
            if (!cooldown.allowed) {
                await sock.sendMessage(jid, { 
                    text: `⏳ Mohon tunggu ${cooldown.remaining} detik sebelum menggunakan command lagi.` 
                });
                return;
            }

            const command = messageContent.split(' ')[0].toLowerCase();
            const args = messageContent.substring(command.length).trim();
            
            // ============= COMMAND .AI =============
            if (command === '.ai') {
                // Delay untuk grup
                if (isGroup) {
                    await delay(CONFIG.GROUP_MESSAGE_DELAY);
                } else {
                    await delay(CONFIG.MESSAGE_DELAY);
                }

                // Cek apakah ada pertanyaan
                if (!args) {
                    await sock.sendMessage(jid, { 
                        text: '❌ Format: .ai [pertanyaan]\nContoh: .ai apa itu AI?' 
                    });
                    return;
                }

                // Cek status
                if (args.toLowerCase() === 'status') {
                    const ollamaStatus = await checkOllama();
                    await sock.sendMessage(jid, { 
                        text: `📊 *STATUS*\n\n${ollamaStatus.message}` 
                    });
                    return;
                }

                // Kirim typing indicator sebentar saja
                await sock.sendPresenceUpdate('composing', jid);
                await delay(1000);
                
                // Kirim pesan proses
                await sock.sendMessage(jid, { 
                    text: '⏳ Memproses...' 
                });

                console.log(`🤖 Memproses pertanyaan`);

                // Generate response
                const startTime = Date.now();
                const aiResponse = await generateAIResponse(args);
                const processTime = ((Date.now() - startTime) / 1000).toFixed(1);

                // Delay sebelum kirim balasan
                await delay(1000);

                // Kirim response
                const responseText = `*🧠 AI* (${processTime}s)\n\n${aiResponse}`;
                await sock.sendMessage(jid, { text: responseText });

                console.log(`✅ Respon terkirim (${processTime}s)`);
            }

            // ============= COMMAND .HELP =============
            if (command === '.help') {
                await delay(CONFIG.MESSAGE_DELAY);
                
                const helpText = `*🤖 BOT AI STABIL*\n\n` +
                    `*Command:*\n` +
                    `• .ai [pertanyaan] - Tanya AI\n` +
                    `• .ai status - Cek status\n` +
                    `• .help - Bantuan\n\n` +
                    `*Mode:* Anti-block aktif\n` +
                    `*Delay:* ${CONFIG.MESSAGE_DELAY/1000}s\n` +
                    `*Max/min:* ${CONFIG.MAX_MESSAGES_PER_MINUTE}`;
                
                await sock.sendMessage(jid, { text: helpText });
            }

        } catch (error) {
            console.error('❌ Error handler:', error.message);
            // Jangan kirim error ke user untuk keamanan
        }
    }
}

// ============= FUNGSI UTAMA =============
async function main() {
    console.log('='.repeat(60));
    console.log('🤖 BOT WHATSAPP STABIL + OLLAMA');
    console.log('='.repeat(60));
    
    console.log('\n🔧 KONFIGURASI ANTI-BLOCK:');
    console.log(`📌 Delay pesan: ${CONFIG.MESSAGE_DELAY}ms`);
    console.log(`📌 Delay grup: ${CONFIG.GROUP_MESSAGE_DELAY}ms`);
    console.log(`📌 Max pesan/menit: ${CONFIG.MAX_MESSAGES_PER_MINUTE}`);
    console.log(`📌 Cooldown user: ${CONFIG.USER_COOLDOWN/1000}s`);
    console.log(`📌 Auto-read: ${CONFIG.AUTO_READ ? 'Ya' : 'Tidak'}`);
    console.log(`📌 Mark online: ${CONFIG.MARK_ONLINE ? 'Ya' : 'Tidak'}`);
    
    console.log('\n🔍 Memeriksa Ollama...');
    const ollamaStatus = await checkOllama();
    console.log(ollamaStatus.message);
    
    if (!ollamaStatus.status) {
        console.log('\n⚠️  PERINGATAN: Ollama bermasalah!\n');
    }

    console.log('\n🔄 Menghubungkan ke WhatsApp...\n');
    
    try {
        await connectToWhatsApp();
    } catch (error) {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    }
}

// Handle shutdown dengan graceful
process.on('SIGINT', async () => {
    console.log('\n\n👋 Mematikan bot secara graceful...');
    await delay(1000);
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error.message);
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled Rejection:', error.message);
});

main();
