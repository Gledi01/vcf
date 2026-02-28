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
const OLLAMA_MODEL = 'qwen3:0.6b';
const LOG_FILE = 'bot-errors.log';

// TIMEOUT 3 MENIT
const OLLAMA_TIMEOUT = 180000; // 3 menit dalam milidetik

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

// Cache
const msgRetryCounterCache = new NodeCache();
const logger = pino({ level: 'silent' });
const contactCache = new Map();

// Cooldown tracker
const userCooldown = new Map();
const messageCounter = {
    count: 0,
    resetTime: Date.now() + 60000
};

// Error stats
const errorStats = {
    badMac: 0,
    connection: 0,
    ollama: 0,
    total: 0,
    lastReset: Date.now()
};

// ============= FUNGSI LOG ERROR =============
function logError(errorType, details, jid = null) {
    const waktu = new Date().toLocaleString('id-ID', { 
        timeZone: 'Asia/Jakarta' 
    });
    
    const logEntry = `[${waktu}] ${errorType}: ${details} ${jid ? `| JID: ${jid}` : ''}`;
    
    // Tampilkan di konsol dengan warna merah
    console.log('\x1b[31m%s\x1b[0m', '❌ ' + logEntry);
    
    // Simpan ke file
    fs.appendFileSync(LOG_FILE, logEntry + '\n');
}

// ============= FUNGSI LOG INFO =============
function logInfo(message) {
    const waktu = new Date().toLocaleString('id-ID', { 
        timeZone: 'Asia/Jakarta' 
    });
    
    console.log('\x1b[32m%s\x1b[0m', `✅ [${waktu}] ${message}`);
}

// ============= FUNGSI LOG WARNING =============
function logWarning(message) {
    const waktu = new Date().toLocaleString('id-ID', { 
        timeZone: 'Asia/Jakarta' 
    });
    
    console.log('\x1b[33m%s\x1b[0m', `⚠️ [${waktu}] ${message}`);
}

// ============= FUNGSI TAMPIL STATS =============
function showErrorStats() {
    console.log('\n' + '='.repeat(60));
    console.log('📊 STATISTIK ERROR');
    console.log('='.repeat(60));
    console.log(`🔴 Bad MAC Error    : ${errorStats.badMac}`);
    console.log(`🔴 Connection Error : ${errorStats.connection}`);
    console.log(`🔴 Ollama Error     : ${errorStats.ollama}`);
    console.log(`📊 Total Error      : ${errorStats.total}`);
    console.log(`⏱️  Timeout Ollama   : 3 menit`);
    console.log(`🕐 Periode          : ${new Date(errorStats.lastReset).toLocaleString('id-ID')}`);
    console.log('='.repeat(60) + '\n');
}

// ============= FUNGSI RESET STATS =============
function resetStatsIfNeeded() {
    const now = Date.now();
    if (now - errorStats.lastReset > 3600000) {
        errorStats.badMac = 0;
        errorStats.connection = 0;
        errorStats.ollama = 0;
        errorStats.total = 0;
        errorStats.lastReset = now;
        logInfo('Stats error direset');
    }
}

// ============= FUNGSI HAPUS SESSION CORRUPT =============
function cleanCorruptedSessions() {
    try {
        if (!fs.existsSync(SESSION_DIR)) {
            fs.mkdirSync(SESSION_DIR);
            return;
        }
        
        const files = fs.readdirSync(SESSION_DIR);
        let deleted = 0;
        
        for (const file of files) {
            if (file.endsWith('.json')) {
                const filePath = path.join(SESSION_DIR, file);
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    JSON.parse(content);
                } catch {
                    fs.unlinkSync(filePath);
                    deleted++;
                    logWarning(`File session corrupt dihapus: ${file}`);
                }
            }
        }
        
        if (deleted > 0) {
            logInfo(`Bersihkan ${deleted} file session corrupt`);
        }
    } catch (error) {
        logError('CLEANUP_ERROR', error.message);
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
        if (part.type === 'year') date = part.value;
        if (part.type === 'month') date = date + '-' + part.value;
        if (part.type === 'day') date = date + '-' + part.value;
        if (part.type === 'hour') time = part.value;
        if (part.type === 'minute') time = time + ':' + part.value;
        if (part.type === 'second') time = time + ':' + part.value;
    }
    
    return {
        full: `${date} ${time} WIB`,
        date,
        time
    };
}

// ============= FUNGSI LOG PESAN LENGKAP =============
async function logMessageDetails(sock, msg, messageContent, isGroup, response = null, processTime = null) {
    try {
        const jid = msg.key.remoteJid;
        const sender = msg.key.participant || jid;
        const senderNumber = sender.split('@')[0];
        
        const contactName = await getContactName(sock, jid);
        const waktu = getFormattedTime();
        
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
        
        if (processTime) {
            console.log(`   • ⏱️  Proses AI: ${processTime} detik`);
        }
        
        if (response) {
            console.log(`\n🤖 RESPON AI:`);
            console.log(`   • ${response.substring(0, 150)}${response.length > 150 ? '...' : ''}`);
            console.log(`   • Panjang: ${response.length} karakter`);
        }
        
        console.log('\n' + '═'.repeat(80) + '\n');
        
    } catch (error) {
        logError('LOG_ERROR', error.message);
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
                message: `❌ Model ${OLLAMA_MODEL} tidak ditemukan` 
            };
        }
    } catch (error) {
        errorStats.ollama++;
        errorStats.total++;
        logError('OLLAMA_CHECK_ERROR', error.message);
        return { 
            status: false, 
            message: '❌ Ollama tidak berjalan' 
        };
    }
}

// ============= FUNGSI AI DENGAN TIMEOUT 3 MENIT =============
async function generateAIResponse(prompt) {
    const startTime = Date.now();
    
    try {
        logInfo(`AI memproses: "${prompt.substring(0, 50)}..." (timeout 3 menit)`);
        
        const escapedPrompt = prompt.replace(/"/g, '\\"');
        
        const { stdout, stderr } = await execPromise(
            `ollama run ${OLLAMA_MODEL} "${escapedPrompt}"`,
            { timeout: OLLAMA_TIMEOUT }
        );
        
        const processTime = ((Date.now() - startTime) / 1000).toFixed(1);
        
        if (stderr) {
            logWarning(`Ollama stderr: ${stderr}`);
        }
        
        logInfo(`AI selesai dalam ${processTime} detik`);
        
        return {
            answer: stdout.trim() || '❌ Tidak ada respons',
            time: processTime
        };
        
    } catch (error) {
        errorStats.ollama++;
        errorStats.total++;
        
        const processTime = ((Date.now() - startTime) / 1000).toFixed(1);
        
        if (error.message.includes('timeout')) {
            logError('OLLAMA_TIMEOUT', `Timeout setelah 3 menit!`);
            return {
                answer: '❌ Maaf, pertanyaan terlalu kompleks. Timeout setelah 3 menit. Coba pertanyaan yang lebih sederhana.',
                time: processTime
            };
        }
        
        logError('OLLAMA_RUN_ERROR', error.message);
        return {
            answer: '❌ Error: ' + error.message.substring(0, 100),
            time: processTime
        };
    }
}

// ============= FUNGSI KONEKSI WHATSAPP =============
async function connectToWhatsApp() {
    console.log('\n🔄 Memulai koneksi WhatsApp...');
    
    cleanCorruptedSessions();

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
        defaultQueryTimeoutMs: 60000,
        markOnlineOnConnect: CONFIG.MARK_ONLINE,
        shouldSyncHistoryMessage: () => false
    });

    // Handle QR Code
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n' + '='.repeat(50));
            console.log('📱 SCAN QR CODE');
            console.log('='.repeat(50));
            qrcode.generate(qr, { small: true });
            console.log('\n⏳ Menunggu scan...\n');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            
            if (statusCode === 440 || statusCode === 515) {
                logWarning('Session expired/corrupt, membersihkan...');
                cleanCorruptedSessions();
            }
            
            errorStats.connection++;
            errorStats.total++;
            logError('CONNECTION_CLOSE', `Status code: ${statusCode}`);
            
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                logWarning(`Reconnect dalam ${CONFIG.RECONNECT_DELAY/1000} detik...`);
                setTimeout(() => connectToWhatsApp(), CONFIG.RECONNECT_DELAY);
            }
        } else if (connection === 'open') {
            logInfo('Bot berhasil terhubung ke WhatsApp');
            console.log('\n📝 FITUR:');
            console.log('   • .ai [pertanyaan] - Tanya AI (timeout 3 menit)');
            console.log('   • .ai status - Cek status AI');
            console.log('   • .stats - Lihat statistik error');
            console.log('   • .help - Bantuan\n');
            
            // Tampilkan info timeout
            console.log(`⏱️  TIMEOUT AI: 3 MENIT (${OLLAMA_TIMEOUT/1000} detik)`);
            console.log(`📁 Log error: ${LOG_FILE}\n`);
        }
    });

    sock.ev.on('creds.update', saveCreds);
    
    // Handler pesan
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (let msg of messages) {
            try {
                // Skip pesan bot sendiri
                if (msg.key?.fromMe) continue;
                
                // Handle error decrypt
                if (msg.messageStubType === 'ERROR_DECRYPT') {
                    errorStats.badMac++;
                    errorStats.total++;
                    
                    const jid = msg.key?.remoteJid || 'unknown';
                    logWarning(`Bad MAC Error #${errorStats.badMac} dari ${jid}`);
                    
                    if (errorStats.badMac % 5 === 0) {
                        logWarning(`⚠️  Total Bad MAC: ${errorStats.badMac}`);
                    }
                    
                    continue;
                }
                
                // Skip status
                if (msg.key?.remoteJid === 'status@broadcast') continue;

                // Ambil teks
                let messageContent = '';
                if (msg.message?.conversation) {
                    messageContent = msg.message.conversation;
                } else if (msg.message?.extendedTextMessage?.text) {
                    messageContent = msg.message.extendedTextMessage.text;
                } else {
                    continue;
                }

                const jid = msg.key.remoteJid;
                const isGroup = jid.endsWith('@g.us');

                // Auto-read
                if (CONFIG.AUTO_READ) {
                    await sock.readMessages([msg.key]);
                }

                // Reset stats
                resetStatsIfNeeded();

                // Proses command
                if (messageContent.startsWith('.')) {
                    
                    // Cek rate limit
                    if (!checkRateLimit()) {
                        logWarning('Rate limit exceeded');
                        continue;
                    }

                    const command = messageContent.split(' ')[0].toLowerCase();
                    const args = messageContent.substring(command.length).trim();

                    // Log command
                    await logMessageDetails(sock, msg, messageContent, isGroup);

                    // ===== COMMAND .AI =====
                    if (command === '.ai') {
                        
                        // Cek cooldown
                        const cooldown = checkCooldown(jid);
                        if (!cooldown.allowed) {
                            await sock.sendMessage(jid, { 
                                text: `⏳ Tunggu ${cooldown.remaining} detik` 
                            });
                            continue;
                        }

                        if (!args) {
                            await sock.sendMessage(jid, { 
                                text: '❌ Format: .ai [pertanyaan]\nContoh: .ai apa itu AI?' 
                            });
                            continue;
                        }

                        // Cek status
                        if (args.toLowerCase() === 'status') {
                            const ollamaStatus = await checkOllama();
                            await sock.sendMessage(jid, { 
                                text: `📊 *STATUS AI*\n\n${ollamaStatus.message}\n⏱️ Timeout: 3 menit` 
                            });
                            continue;
                        }

                        // Delay untuk grup
                        if (isGroup) {
                            await delay(CONFIG.GROUP_MESSAGE_DELAY);
                        } else {
                            await delay(CONFIG.MESSAGE_DELAY);
                        }

                        // Kasih tau sedang proses
                        await sock.sendPresenceUpdate('composing', jid);
                        await sock.sendMessage(jid, { 
                            text: `⏳ Memproses pertanyaan...\n⏱️ Maksimal waktu: 3 menit` 
                        });

                        // Generate AI response
                        const result = await generateAIResponse(args);

                        // Kirim response
                        const responseText = `*🧠 Qwen3 AI* (${result.time} detik)\n\n${result.answer}`;
                        await sock.sendMessage(jid, { text: responseText });

                        // Log dengan response
                        await logMessageDetails(sock, msg, messageContent, isGroup, result.answer, result.time);
                    }

                    // ===== COMMAND .STATS =====
                    if (command === '.stats') {
                        let statsMessage = `📊 *STATISTIK ERROR*\n\n`;
                        statsMessage += `🔴 Bad MAC: ${errorStats.badMac}\n`;
                        statsMessage += `🔴 Connection: ${errorStats.connection}\n`;
                        statsMessage += `🔴 Ollama: ${errorStats.ollama}\n`;
                        statsMessage += `📊 Total: ${errorStats.total}\n`;
                        statsMessage += `⏱️ Timeout AI: 3 menit\n`;
                        statsMessage += `🕐 Periode: ${new Date(errorStats.lastReset).toLocaleString('id-ID')}\n\n`;
                        statsMessage += `📁 Log file: ${LOG_FILE}`;
                        
                        await sock.sendMessage(jid, { text: statsMessage });
                    }

                    //                    // ===== COMMAND .HELP =====
                    if (command === '.help') {
                        const helpText = `*🤖 BOT QWEN3 AI*\n\n` +
                            `*Model:* ${OLLAMA_MODEL}\n` +
                            `*Timeout:* 3 menit\n\n` +
                            `*Commands:*\n` +
                            `• .ai [pertanyaan] - Tanya AI\n` +
                            `• .ai status - Cek status AI\n` +
                            `• .stats - Statistik error\n` +
                            `• .help - Bantuan ini\n\n` +
                            `*Fitur:*\n` +
                            `✓ Log nama kontak\n` +
                            `✓ Log waktu\n` +
                            `✓ Anti-spam cooldown\n` +
                            `✓ Anti-block system\n` +
                            `✓ Monitoring error`;
                        
                        await sock.sendMessage(jid, { text: helpText });
                    }
                }

            } catch (error) {
                if (error.message?.includes('Bad MAC')) {
                    errorStats.badMac++;
                    errorStats.total++;
                    logWarning(`Bad MAC di handler: ${error.message}`);
                } else {
                    logError('HANDLER_ERROR', error.message);
                }
            }
        }
    });

    return sock;
}

// ============= FUNGSI UTAMA =============
async function main() {
    console.log('='.repeat(80));
    console.log('🤖 BOT WHATSAPP + QWEN3 0.6B - VERSI LENGKAP');
    console.log('='.repeat(80));
    
    console.log('\n📋 KONFIGURASI:');
    console.log(`   • Model AI: ${OLLAMA_MODEL}`);
    console.log(`   • Timeout AI: 3 menit (${OLLAMA_TIMEOUT/1000} detik)`);
    console.log(`   • Delay pesan: ${CONFIG.MESSAGE_DELAY}ms`);
    console.log(`   • Cooldown user: ${CONFIG.USER_COOLDOWN/1000}s`);
    console.log(`   • Max pesan/menit: ${CONFIG.MAX_MESSAGES_PER_MINUTE}`);
    console.log(`   • Auto-read: ${CONFIG.AUTO_READ ? 'Ya' : 'Tidak'}`);
    console.log(`   • Log file: ${LOG_FILE}\n`);
    
    console.log('🔍 Memeriksa Ollama...');
    const ollamaStatus = await checkOllama();
    console.log(ollamaStatus.message);
    
    if (!ollamaStatus.status) {
        console.log('\n⚠️  PERINGATAN: Ollama bermasalah!');
        console.log(`📥 Install: ollama pull ${OLLAMA_MODEL}\n`);
    }

    console.log('\n🔄 Menghubungkan ke WhatsApp...\n');
    
    try {
        await connectToWhatsApp();
        
        // Tampilkan stats setiap 30 menit
        setInterval(() => {
            if (errorStats.total > 0) {
                showErrorStats();
            }
        }, 1800000);
        
    } catch (error) {
        logError('FATAL_ERROR', error.message);
        process.exit(1);
    }
}

// Handle shutdown
process.on('SIGINT', () => {
    console.log('\n\n' + '='.repeat(60));
    console.log('📊 STATISTIK ERROR FINAL');
    console.log('='.repeat(60));
    console.log(`🔴 Bad MAC Error    : ${errorStats.badMac}`);
    console.log(`🔴 Connection Error : ${errorStats.connection}`);
    console.log(`🔴 Ollama Error     : ${errorStats.ollama}`);
    console.log(`📊 Total Error      : ${errorStats.total}`);
    console.log(`⏱️  Timeout AI       : 3 menit`);
    console.log('='.repeat(60));
    console.log('\n📁 Log error:', LOG_FILE);
    console.log('👋 Bot dimatikan\n');
    process.exit(0);
});

main();
