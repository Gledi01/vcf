import makeWASocket, { 
    DisconnectReason, 
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
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
const MODEL_NAME = "qwen2.5:0.5b"; // Ganti sesuai model lo
const DEVELOPER = "WayanGledy";
const WA_SESSION_FILE = 'wa_sesi.json';

// Cache
const contactCache = new Map();

// ============= SESI MANAGEMENT (NGIKUTIN PYTHON) =============
function loadSesi() {
    try {
        if (fs.existsSync(WA_SESSION_FILE)) {
            const data = JSON.parse(fs.readFileSync(WA_SESSION_FILE, 'utf-8'));
            if (data && Array.isArray(data.history)) {
                return data;
            }
        }
        return { history: [] };
    } catch {
        return { history: [] };
    }
}

function saveSesi(sesi) {
    fs.writeFileSync(WA_SESSION_FILE, JSON.stringify(sesi, null, 2), 'utf-8');
}

// ============= FUNGSI AI INTENT (NGIKUTIN PYTHON) =============
async function aiIntent(userInput, sesi) {
    const systemPrompt = 
        `Kamu adalah AI bernama LionaAI. Model: ${MODEL_NAME}, Developer: ${DEVELOPER}.\n` +
        `Kamu adalah asisten yang membantu dan ramah. Jawab pertanyaan dengan jelas dan ringkas.\n` +
        `Gunakan bahasa Indonesia yang baik dan benar.`;

    // Format history seperti di Python
    const historyMsgs = [];
    for (let i = 0; i < sesi.history.length; i += 2) {
        if (sesi.history[i]) {
            historyMsgs.push({ role: "user", content: sesi.history[i] });
        }
        if (sesi.history[i + 1]) {
            historyMsgs.push({ role: "assistant", content: sesi.history[i + 1] });
        }
    }
    // Ambil 10 terakhir
    const recentHistory = historyMsgs.slice(-10);

    try {
        // Panggil Ollama via CLI (karena di JS pake exec)
        const messages = [
            { role: "system", content: systemPrompt },
            ...recentHistory,
            { role: "user", content: userInput }
        ];

        // Convert ke format prompt
        let prompt = "";
        for (const msg of messages) {
            if (msg.role === "system") prompt += `System: ${msg.content}\n`;
            else if (msg.role === "user") prompt += `User: ${msg.content}\n`;
            else if (msg.role === "assistant") prompt += `Assistant: ${msg.content}\n`;
        }
        prompt += "Assistant: ";

        const { stdout } = await execPromise(
            `ollama run ${MODEL_NAME} "${prompt.replace(/"/g, '\\"')}"`,
            { timeout: 180000 }
        );

        return stdout.trim();
    } catch (error) {
        console.error('❌ Error AI:', error.message);
        return "Maaf, aku mengalami gangguan. Coba lagi ya.";
    }
}

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

// ============= FUNGSI CEK OLLAMA =============
async function checkOllama() {
    try {
        const { stdout } = await execPromise('ollama list');
        return stdout.includes(MODEL_NAME);
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

    const { version } = await fetchLatestBaileysVersion();

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    
    const sock = makeWASocket({
        auth: state,
        version: version,
        printQRInTerminal: false,
        browser: ['LionaAI', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        defaultQueryTimeoutMs: 60000
    });

    // HANDLE KONEKSI
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
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
            
            if (statusCode === 405) {
                console.log('⚠️  Error 405, coba lagi...');
                fixSession();
                setTimeout(() => connectToWhatsApp(), 3000);
            }
            else if (statusCode !== DisconnectReason.loggedOut) {
                console.log('🔄 Reconnect 5 detik...');
                setTimeout(() => connectToWhatsApp(), 5000);
            }
        } else if (connection === 'open') {
            console.log('\n✅ BOT LIONA SIAP!');
            console.log(`🤖 Model: ${MODEL_NAME}`);
            console.log(`👤 Developer: ${DEVELOPER}`);
            console.log('📝 .ai [pertanyaan]\n');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // LOAD SESI
    let sesi = loadSesi();
    console.log(`📁 History: ${sesi.history.length} pesan`);

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

                // COMMAND .AI - NGIKUTIN PYTHON
                if (text.startsWith('.ai')) {
                    const question = text.substring(4).trim();
                    
                    if (!question) {
                        await sock.sendMessage(jid, { 
                            text: '❌ Contoh: .ai apa itu AI?' 
                        });
                        continue;
                    }

                    // Kaya di Python: loading dulu
                    await sock.sendPresenceUpdate('composing', jid);
                    await sock.sendMessage(jid, { 
                        text: '⏳ LionaAI sedang berpikir...' 
                    });

                    // PANGGIL AI INTENT (kaya di Python)
                    const start = Date.now();
                    const answer = await aiIntent(question, sesi);
                    const waktuProses = ((Date.now() - start) / 1000).toFixed(1);

                    // KIRIM JAWABAN
                    await sock.sendMessage(jid, { 
                        text: `*🧠 LionaAI* (${waktuProses}s)\n\n${answer}` 
                    });

                    // SIMPAN KE SESI (kaya di Python)
                    sesi.history.push(question);
                    sesi.history.push(answer);
                    saveSesi(sesi);

                    console.log(`✅ Jawaban terkirim (${waktuProses}s)`);
                    console.log(`📁 History: ${sesi.history.length} pesan`);
                }

                // COMMAND .RESET - reset history
                if (text === '.reset') {
                    sesi = { history: [] };
                    saveSesi(sesi);
                    await sock.sendMessage(jid, { 
                        text: '✅ History percakapan direset!' 
                    });
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
    console.log(`🤖 LIONA AI - ${MODEL_NAME}`);
    console.log(`👤 Developer: ${DEVELOPER}`);
    console.log('='.repeat(50));
    
    // Cek Ollama
    console.log('\n🔍 Memeriksa Ollama...');
    const ollamaReady = await checkOllama();
    
    if (!ollamaReady) {
        console.log('⚠️  Model tidak ditemukan!');
        console.log(`📥 Install: ollama pull ${MODEL_NAME}\n`);
    } else {
        console.log(`✅ Model ${MODEL_NAME} siap\n`);
    }

    // Load sesi
    const sesi = loadSesi();
    console.log(`📁 History tersimpan: ${sesi.history.length} pesan\n`);

    try {
        await connectToWhatsApp();
    } catch (error) {
        console.error('❌ Fatal:', error);
    }
}

process.on('SIGINT', () => {
    console.log('\n\n👋 Sampai jumpa!');
    process.exit(0);
});

main();
