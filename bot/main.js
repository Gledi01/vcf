import makeWASocket, { 
    DisconnectReason, 
    useMultiFileAuthState,
    fetchLatestBaileysVersion // PENTING!
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
const OLLAMA_MODEL = 'Qwen3:0.6b';

// Logger
const logger = pino({ level: 'silent' });

// Cache nama kontak
const contactCache = new Map();

// ============= FUNGSI DAPATKAN NAMA KONTAK =============
async function getContactName(sock, jid) {
    try {
        if (contactCache.has(jid)) return contactCache.get(jid);

        let name = 'Unknown';
        
        if (jid.endsWith('@s.whatsapp.net')) {
            const [number] = jid.split('@');
            try {
                const contact = await sock.fetchContact(jid);
                name = contact?.name || contact?.notify || number;
            } catch {
                name = number;
            }
        } else if (jid.endsWith('@g.us')) {
            try {
                const group = await sock.groupMetadata(jid);
                name = group.subject || 'Unknown Group';
            } catch {
                name = 'Unknown Group';
            }
        }
        
        contactCache.set(jid, name);
        return name;
    } catch {
        return jid.split('@')[0];
    }
}

// ============= FUNGSI AI =============
async function askAI(question) {
    try {
        const { stdout } = await execPromise(
            `ollama run ${OLLAMA_MODEL} "${question.replace(/"/g, '\\"')}"`,
            { timeout: 180000 }
        );
        return stdout.trim() || '✅ Selesai.';
    } catch (error) {
        if (error.message.includes('timeout')) return '⏱️ Timeout 3 menit';
        return '❌ Error AI';
    }
}

// ============= FUNGSI CEK OLLAMA =============
async function checkOllama() {
    try {
        const { stdout } = await execPromise('ollama list');
        return stdout.includes(OLLAMA_MODEL);
    } catch {
        return false;
    }
}

// ============= FUNGSI FIX SESSION =============
function fixSession() {
    try {
        if (!fs.existsSync(SESSION_DIR)) {
            fs.mkdirSync(SESSION_DIR);
            return;
        }
        
        const files = fs.readdirSync(SESSION_DIR);
        for (const file of files) {
            if (file.endsWith('.json')) {
                const filePath = path.join(SESSION_DIR, file);
                try {
                    JSON.parse(fs.readFileSync(filePath, 'utf8'));
                } catch {
                    fs.unlinkSync(filePath);
                    console.log(`🧹 Hapus session: ${file}`);
                }
            }
        }
    } catch (e) {}
}

// ============= FUNGSI KONEKSI WHATSAPP =============
async function connectToWhatsApp() {
    console.log('🔄 Menghubungkan ke WhatsApp...');
    
    fixSession();

    // ===== PENTING: AMBIL VERSI TERBARU =====
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📦 Versi Baileys: ${version.join('.')} ${isLatest ? '(latest)' : ''}`);

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    
    const sock = makeWASocket({
        auth: state,
        version: version, // PAKAI VERSI TERBARU!
        printQRInTerminal: false,
        logger: logger,
        browser: ['Chrome', 'Windows', '10'], // Browser umum
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        defaultQueryTimeoutMs: 60000
    });

    // HANDLE KONEKSI
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // QR CODE
        if (qr) {
            console.log('\n' + '='.repeat(50));
            console.log('📱 SCAN QR CODE');
            console.log('='.repeat(50));
            qrcode.generate(qr, { small: true });
            console.log('\n' + '='.repeat(50));
            console.log('1. Buka WhatsApp');
            console.log('2. Titik 3 > Perangkat Tertaut');
            console.log('3. Scan QR di atas');
            console.log('='.repeat(50) + '\n');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ Koneksi terputus. Kode: ${statusCode}`);
            
            // HANDLE ERROR 405
            if (statusCode === 405) {
                console.log('⚠️  Error 405 Method Not Allowed');
                console.log('🔄 Mencoba versi berbeda...');
                
                // Hapus session & coba lagi
                fixSession();
                setTimeout(() => connectToWhatsApp(), 3000);
            }
            else if (statusCode !== DisconnectReason.loggedOut) {
                console.log('🔄 Reconnect 5 detik...');
                setTimeout(() => connectToWhatsApp(), 5000);
            }
        } else if (connection === 'open') {
            console.log('\n✅ BOT AI TERHUBUNG!');
            console.log('📝 .ai [pertanyaan]');
            console.log('⏱️ Timeout: 3 menit\n');
        }
    });

    // Simpan kredensial
    sock.ev.on('creds.update', saveCreds);

    // HANDLER PESAN
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (let msg of messages) {
            try {
                if (msg.key?.fromMe) continue;
                if (msg.messageStubType === 'ERROR_DECRYPT') continue;
                if (msg.key?.remoteJid === 'status@broadcast') continue;

                let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
                if (!text) continue;

                const jid = msg.key.remoteJid;
                const isGroup = jid.endsWith('@g.us');
                const sender = msg.key.participant || jid;
                const nomor = sender.split('@')[0];
                
                const nama = await getContactName(sock, jid);
                const waktu = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' });
                
                // TAMPIL DI KONSOL
                const tipe = isGroup ? '👥 GROUP' : '👤 PC';
                console.log(`\n${tipe} | ${waktu}`);
                console.log(`📌 ${nama} (${nomor})`);
                console.log(`💬 ${text}`);

                await sock.readMessages([msg.key]);

                // COMMAND .AI
                if (text.startsWith('.ai')) {
                    const question = text.substring(4).trim();
                    
                    if (!question) {
                        await sock.sendMessage(jid, { text: '❌ Contoh: .ai apa itu AI?' });
                        continue;
                    }

                    if (question.toLowerCase() === 'status') {
                        const status = await checkOllama();
                        await sock.sendMessage(jid, { 
                            text: status ? '✅ AI siap' : '❌ AI tidak tersedia' 
                        });
                        continue;
                    }

                    await sock.sendPresenceUpdate('composing', jid);
                    await sock.sendMessage(jid, { text: '⏳ Proses 3 menit...' });

                    const start = Date.now();
                    const answer = await askAI(question);
                    const waktuProses = ((Date.now() - start) / 1000).toFixed(1);

                    await sock.sendMessage(jid, { 
                        text: `*🧠 Qwen3* (${waktuProses}s)\n\n${answer}` 
                    });

                    console.log(`✅ Jawaban terkirim (${waktuProses}s)`);
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
    console.log('='.repeat(50));
    console.log('🤖 BOT AI - FIX ERROR 405');
    console.log('='.repeat(50));
    
    // Cek Ollama
    console.log('\n🔍 Memeriksa Ollama...');
    const ollamaReady = await checkOllama();
    
    if (!ollamaReady) {
        console.log('⚠️  Model tidak ditemukan');
        console.log(`📥 Install: ollama pull ${OLLAMA_MODEL}\n`);
    } else {
        console.log(`✅ Model ${OLLAMA_MODEL} siap\n`);
    }

    try {
        await connectToWhatsApp();
    } catch (error) {
        console.error('❌ Fatal:', error);
    }
}

process.on('SIGINT', () => {
    console.log('\n\n👋 Bye');
    process.exit(0);
});

main();
