import makeWASocket, { 
    DisconnectReason, 
    useMultiFileAuthState 
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

// Logger silent
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

// ============= FUNGSI AI QWEN3 =============
async function askAI(question) {
    try {
        console.log(`🤔 AI: "${question.substring(0, 50)}..."`);
        
        const { stdout } = await execPromise(
            `ollama run ${OLLAMA_MODEL} "${question.replace(/"/g, '\\"')}"`,
            { timeout: 180000 }
        );
        
        return stdout.trim() || '✅ Selesai.';
    } catch (error) {
        console.error('❌ Error AI:', error.message);
        if (error.message.includes('timeout')) return '⏱️ Timeout 3 menit';
        if (error.message.includes('not found')) return '❌ Model tidak ada';
        return '❌ Error, coba lagi';
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

// ============= FUNGSI KONEKSI WHATSAPP =============
async function connectToWhatsApp() {
    console.log('🔄 Menghubungkan ke WhatsApp...');
    
    // Buat folder sessions
    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR);
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // QR MANUAL
        logger: logger,
        browser: ['AI Bot', 'Chrome', '1.0.0'],
        syncFullHistory: false
    });

    // HANDLE QR CODE MANUAL
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // QR CODE MUNCUL DISINI
        if (qr) {
            console.log('\n' + '='.repeat(50));
            console.log('📱 SCAN QR CODE INI');
            console.log('='.repeat(50));
            qrcode.generate(qr, { small: true });
            console.log('\n' + '='.repeat(50));
            console.log('1. Buka WhatsApp');
            console.log('2. Titik 3 > Perangkat Tertaut');
            console.log('3. Tautkan Perangkat');
            console.log('4. Scan QR code di atas');
            console.log('='.repeat(50) + '\n');
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log('❌ Koneksi terputus. Kode:', code);
            
            if (code !== DisconnectReason.loggedOut) {
                console.log('🔄 Reconnect 5 detik...');
                setTimeout(connectToWhatsApp, 5000);
            }
        } else if (connection === 'open') {
            console.log('\n✅ BOT AI TERHUBUNG!');
            console.log('📝 Command: .ai [pertanyaan]');
            console.log('⏱️ Timeout: 3 menit\n');
        }
    });

    // Simpan kredensial
    sock.ev.on('creds.update', saveCreds);

    // HANDLER PESAN
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (let msg of messages) {
            try {
                // Skip pesan bot sendiri
                if (msg.key?.fromMe) continue;
                
                // Skip error decrypt
                if (msg.messageStubType === 'ERROR_DECRYPT') continue;
                
                // Skip status
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
                const isGroup = jid.endsWith('@g.us');
                const sender = msg.key.participant || jid;
                const nomor = sender.split('@')[0];
                
                // Dapatkan nama kontak
                const nama = await getContactName(sock, jid);
                const waktu = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' });
                
                // TAMPILKAN DI KONSOL
                const tipe = isGroup ? '👥 GROUP' : '👤 PC';
                console.log(`\n${tipe} | ${waktu}`);
                console.log(`📌 ${nama} (${nomor})`);
                console.log(`💬 ${text}`);

                // Auto-read
                await sock.readMessages([msg.key]);

                // COMMAND .AI
                if (text.startsWith('.ai')) {
                    const question = text.substring(4).trim();
                    
                    if (!question) {
                        await sock.sendMessage(jid, { 
                            text: '❌ Contoh: .ai apa itu AI?' 
                        });
                        continue;
                    }

                    // Cek status
                    if (question.toLowerCase() === 'status') {
                        const status = await checkOllama();
                        await sock.sendMessage(jid, { 
                            text: status ? 
                                `✅ Model ${OLLAMA_MODEL} siap` : 
                                `❌ Model ${OLLAMA_MODEL} tidak tersedia` 
                        });
                        continue;
                    }

                    // Proses AI
                    await sock.sendPresenceUpdate('composing', jid);
                    await sock.sendMessage(jid, { 
                        text: '⏳ Memproses (maks 3 menit)...' 
                    });

                    const start = Date.now();
                    const answer = await askAI(question);
                    const waktuProses = ((Date.now() - start) / 1000).toFixed(1);

                    await sock.sendMessage(jid, { 
                        text: `*🧠 Qwen3 AI* (${waktuProses}s)\n\n${answer}` 
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
    console.log('🤖 BOT AI QWEN3 0.6B');
    console.log('='.repeat(50));
    
    // Cek Ollama
    console.log('\n🔍 Memeriksa Ollama...');
    const ollamaReady = await checkOllama();
    
    if (!ollamaReady) {
        console.log('❌ Model tidak ditemukan!');
        console.log(`📥 Install: ollama pull ${OLLAMA_MODEL}\n`);
    } else {
        console.log(`✅ Model ${OLLAMA_MODEL} siap\n`);
    }

    console.log('🔄 Memulai koneksi...\n');
    
    try {
        await connectToWhatsApp();
    } catch (error) {
        console.error('❌ Fatal error:', error);
    }
}

// Handle shutdown
process.on('SIGINT', () => {
    console.log('\n\n👋 Bot dimatikan');
    process.exit(0);
});

main();
