import makeWASocket, { 
    DisconnectReason, 
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

// ============= KONFIGURASI =============
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSION_DIR = 'sessions';
const OLLAMA_MODEL = 'qwen3:0.6b';
const LOG_FILE = 'bot-errors.log';

// TIMEOUT 3 MENIT (180000 ms)
const OLLAMA_TIMEOUT = 180000; // 3 menit dalam milidetik

// Logger
const logger = pino({ level: 'error' });

// Cache
const contactCache = new Map();

// ============= FUNGSI LOG ERROR =============
function logError(errorType, details, jid = null) {
    const waktu = new Date().toLocaleString('id-ID', { 
        timeZone: 'Asia/Jakarta' 
    });
    
    const logEntry = `[${waktu}] ${errorType}: ${details} ${jid ? `| JID: ${jid}` : ''}`;
    
    console.log('\x1b[31m%s\x1b[0m', '❌ ' + logEntry);
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

// ============= COUNTER ERROR =============
const errorStats = {
    badMac: 0,
    connection: 0,
    ollama: 0,
    total: 0,
    lastReset: Date.now()
};

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

// ============= FUNGSI TAMPIL STATS =============
function showErrorStats() {
    console.log('\n' + '='.repeat(50));
    console.log('📊 STATISTIK ERROR');
    console.log('='.repeat(50));
    console.log(`🔴 Bad MAC Error    : ${errorStats.badMac}`);
    console.log(`🔴 Connection Error : ${errorStats.connection}`);
    console.log(`🔴 Ollama Error     : ${errorStats.ollama}`);
    console.log(`📊 Total Error      : ${errorStats.total}`);
    console.log(`⏱️  Timeout Ollama   : 3 menit`);
    console.log(`🕐 Periode          : ${new Date(errorStats.lastReset).toLocaleString('id-ID')}`);
    console.log('='.repeat(50) + '\n');
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
                const profile = await sock.profilePictureUrl(jid, 'image');
                name = number;
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
function getTime() {
    const now = new Date();
    return now.toLocaleString('id-ID', { 
        timeZone: 'Asia/Jakarta',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });
}

// ============= FUNGSI LOG PESAN =============
async function logMessage(sock, msg, text, processingTime = null) {
    try {
        const jid = msg.key.remoteJid;
        const sender = msg.key.participant || jid;
        const nomor = sender.split('@')[0];
        const nama = await getContactName(sock, jid);
        const waktu = getTime();
        
        console.log('\n' + '─'.repeat(70));
        console.log(`🕐 ${waktu}`);
        console.log(`👤 ${nama} (${nomor})`);
        console.log(`💬 ${text}`);
        if (processingTime) {
            console.log(`⏱️  Proses: ${processingTime} detik`);
        }
        console.log('─'.repeat(70));
    } catch (error) {
        logError('LOG_ERROR', error.message);
    }
}

// ============= FUNGSI CEK OLLAMA =============
async function checkOllama() {
    try {
        const { stdout } = await execPromise('ollama list');
        return stdout.includes(OLLAMA_MODEL);
    } catch (error) {
        errorStats.ollama++;
        errorStats.total++;
        logError('OLLAMA_CHECK_ERROR', error.message);
        return false;
    }
}

// ============= FUNGSI AI DENGAN TIMEOUT 3 MENIT =============
async function askAI(question) {
    const startTime = Date.now();
    
    try {
        logInfo(`Memproses pertanyaan (timeout 3 menit): "${question.substring(0, 50)}..."`);
        
        const { stdout, stderr } = await execPromise(
            `ollama run ${OLLAMA_MODEL} "${question.replace(/"/g, '\\"')}"`,
            { timeout: OLLAMA_TIMEOUT } // 3 MENIT!
        );
        
        const processTime = ((Date.now() - startTime) / 1000).toFixed(1);
        
        if (stderr) {
            logWarning(`Ollama stderr: ${stderr}`);
        }
        
        logInfo(`Selesai dalam ${processTime} detik`);
        
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

// ============= FUNGSI UTAMA =============
async function startBot() {
    console.log('='.repeat(70));
    console.log('🤖 BOT QWEN3 0.6B - TIMEOUT 3 MENIT');
    console.log('='.repeat(70));
    
    // Bersihkan session corrupt
    cleanCorruptedSessions();
    
    // Cek Ollama
    logInfo('Memeriksa Ollama...');
    const ollamaReady = await checkOllama();
    if (!ollamaReady) {
        logWarning(`Model ${OLLAMA_MODEL} tidak ditemukan`);
        console.log(`📥 Jalankan: ollama pull ${OLLAMA_MODEL}`);
        process.exit(1);
    }
    logInfo(`Model ${OLLAMA_MODEL} siap`);
    logInfo(`⏱️  Timeout AI: 3 menit`);
    
    // Koneksi WhatsApp
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    
    const sock = makeWASocket({
        auth: state,
        version,
        logger,
        printQRInTerminal: true,
        browser: ['Qwen3 Bot', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        emitOwnEvents: false,
        shouldSyncHistoryMessage: () => false
    });

    // Handler koneksi
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n' + '='.repeat(50));
            console.log('📱 SCAN QR CODE');
            console.log('='.repeat(50));
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            errorStats.connection++;
            errorStats.total++;
            
            logError('CONNECTION_CLOSE', `Status code: ${statusCode}`, null);
            
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                logWarning('Mencoba reconnect dalam 5 detik...');
                setTimeout(() => startBot(), 5000);
            } else {
                logError('LOGGED_OUT', 'Session expired, hapus folder sessions');
                process.exit(1);
            }
        } else if (connection === 'open') {
            logInfo('Bot berhasil terhubung ke WhatsApp');
            console.log('\n📝 Kirim .ai [pertanyaan] (timeout 3 menit)');
            console.log('📊 Ketik .stats untuk lihat statistik\n');
        }
    });

    // Handler pesan
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            try {
                // Skip pesan bot sendiri
                if (msg.key?.fromMe) continue;
                
                // DETEKSI ERROR DECRYPT
                if (msg.messageStubType === 'ERROR_DECRYPT') {
                    errorStats.badMac++;
                    errorStats.total++;
                    
                    const jid = msg.key?.remoteJid || 'unknown';
                    logWarning(`Bad MAC Error #${errorStats.badMac} dari ${jid}`);
                    
                    if (errorStats.badMac % 5 === 0) {
                        logWarning(`Sudah ${errorStats.badMac} kali Bad MAC error`);
                    }
                    
                    continue;
                }
                
                // Skip status broadcast
                if (msg.key?.remoteJid === 'status@broadcast') continue;
                
                // Ambil teks
                let text = '';
                if (msg.message?.conversation) {
                    text = msg.message.conversation;
                } else if (msg.message?.extendedTextMessage?.text) {
                    text = msg.message.extendedTextMessage.text;
                } else {
                    continue;
                }
                
                const jid = msg.key.remoteJid;
                
                // Log semua pesan
                await logMessage(sock, msg, text);
                
                // Reset stats jika perlu
                resetStatsIfNeeded();
                
                // Proses command .ai
                if (text.startsWith('.ai')) {
                    const question = text.substring(4).trim();
                    
                    if (!question) {
                        await sock.sendMessage(jid, { 
                            text: '❌ Contoh: .ai apa itu AI?' 
                        });
                        continue;
                    }
                    
                    // Kasih tau sedang proses dengan info timeout
                    await sock.sendPresenceUpdate('composing', jid);
                    await sock.sendMessage(jid, { 
                        text: `⏳ Memproses pertanyaan Anda...\n⏱️  Maksimal waktu: 3 menit` 
                    });
                    
                    // Minta AI dengan timeout 3 menit
                    const result = await askAI(question);
                    
                    // Kirim jawaban dengan info waktu
                    await sock.sendMessage(jid, { 
                        text: `*🧠 Qwen3 AI* (${result.time} detik)\n\n${result.answer}` 
                    });
                    
                    logInfo(`Jawaban untuk "${question.substring(0,30)}..." terkirim (${result.time}s)`);
                }
                
                // Command .stats
                if (text === '.stats') {
                    let statsMessage = `📊 *STATISTIK ERROR*\n\n`;
                    statsMessage += `🔴 Bad MAC: ${errorStats.badMac}\n`;
                    statsMessage += `🔴 Connection: ${errorStats.connection}\n`;
                    statsMessage += `🔴 Ollama: ${errorStats.ollama}\n`;
                    statsMessage += `📊 Total: ${errorStats.total}\n`;
                    statsMessage += `⏱️  Timeout: 3 menit\n`;
                    statsMessage += `🕐 Periode: ${new Date(errorStats.lastReset).toLocaleString('id-ID')}\n\n`;
                    statsMessage += `📁 Log file: ${LOG_FILE}`;
                    
                    await sock.sendMessage(jid, { text: statsMessage });
                }
                
            } catch (error) {
                if (error.message?.includes('Bad MAC')) {
                    errorStats.badMac++;
                    errorStats.total++;
                    logWarning(`Bad MAC Error di handler: ${error.message}`);
                } else {
                    logError('HANDLER_ERROR', error.message);
                }
            }
        }
    });

    // Simpan kredensial
    sock.ev.on('creds.update', saveCreds);
    
    // Tampilkan stats setiap 30 menit
    setInterval(() => {
        if (errorStats.total > 0) {
            showErrorStats();
        }
    }, 1800000);
}

// ============= JALANKAN =============
startBot().catch(error => {
    logError('FATAL_ERROR', error.message);
    process.exit(1);
});

// Handle shutdown
process.on('SIGINT', () => {
    console.log('\n\n' + '='.repeat(50));
    console.log('📊 STATISTIK ERROR FINAL');
    console.log('='.repeat(50));
    console.log(`🔴 Bad MAC Error    : ${errorStats.badMac}`);
    console.log(`🔴 Connection Error : ${errorStats.connection}`);
    console.log(`🔴 Ollama Error     : ${errorStats.ollama}`);
    console.log(`📊 Total Error      : ${errorStats.total}`);
    console.log(`⏱️  Timeout Ollama   : 3 menit`);
    console.log('='.repeat(50));
    console.log('\n👷 Log error tersimpan di:', LOG_FILE);
    console.log('👋 Bot dimatikan\n');
    process.exit(0);
});
