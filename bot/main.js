import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_DIR = 'sessions';
const MODEL_NAME = "qwen2.5:0.5b";
const DEVELOPER = "WayanGledy";

const contactCache = new Map();
const messageQueue = [];

// ========================
// Helper: Session
// ========================
function fixSession() {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR);
    const files = fs.readdirSync(SESSION_DIR);
    for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(SESSION_DIR, file);
        try {
            JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
            fs.unlinkSync(filePath);
            console.log(`🧹 Hapus session rusak: ${file}`);
        }
    }
}

// ========================
// Helper: Ollama
// ========================
async function askAI(question) {
    try {
        const prompt = `Jawab pertanyaan ini: ${question}`;
        const { stdout, stderr } = await execPromise(
            `ollama run ${MODEL_NAME} "${prompt.replace(/"/g, '\\"')}"`,
            { timeout: 30000 }
        );
        if (stderr) console.log('⚠️ Ollama stderr:', stderr);
        return stdout.trim() || '✅ OK';
    } catch (error) {
        console.log('❌ Ollama exec error:', error.message);
        return `❌ Error: ${error.message}`;
    }
}

// ========================
// Helper: Contacts
// ========================
async function getContactName(sock, jid) {
    if (contactCache.has(jid)) return contactCache.get(jid);
    let name = 'Unknown';
    try {
        if (jid.endsWith('@s.whatsapp.net')) {
            const contact = await sock.fetchContact(jid);
            name = contact?.name || contact?.notify || jid.split('@')[0];
        } else if (jid.endsWith('@g.us')) {
            const group = await sock.groupMetadata(jid);
            name = group.subject || 'Unknown Group';
        }
    } catch {}
    contactCache.set(jid, name);
    return name;
}

// ========================
// WhatsApp Connection
// ========================
async function connectWhatsApp() {
    fixSession();
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    const sock = makeWASocket({
        auth: state,
        version: version,
        printQRInTerminal: false,
        browser: ['LionaAI', 'Chrome', '1.0.0'],
        syncFullHistory: false
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('📱 SCAN QR CODE:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('🔄 Reconnect...');
                setTimeout(connectWhatsApp, 5000);
            } else console.log('❌ Logged out');
        }
        if (connection === 'open') console.log('✅ WhatsApp connected!');
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', ({ messages }) => {
        for (const msg of messages) {
            if (!msg.key.fromMe && msg.message?.conversation) {
                messageQueue.push(msg);
            }
        }
    });

    // Loop proses queue mirip Python main loop
    setInterval(async () => {
        if (!messageQueue.length) return;
        const msg = messageQueue.shift();
        const jid = msg.key.remoteJid;
        const sender = msg.key.participant || jid;
        const nama = await getContactName(sock, jid);
        const text = msg.message.conversation;
        console.log(`💬 ${nama}: ${text}`);

        if (text.startsWith('.ai')) {
            const question = text.slice(4).trim();
            if (!question) {
                await sock.sendMessage(jid, { text: '❌ Contoh: .ai apa itu AI?' });
                return;
            }
            await sock.sendPresenceUpdate('composing', jid);
            await sock.sendMessage(jid, { text: '⏳ LionaAI sedang berpikir...' });

            const start = Date.now();
            const answer = await askAI(question);
            const waktuProses = ((Date.now() - start) / 1000).toFixed(1);

            await sock.sendMessage(jid, { text: `*🧠 LionaAI* (${waktuProses}s)\n\n${answer}` });
            console.log(`✅ Jawaban terkirim (${waktuProses}s)`);
        }

        await sock.readMessages([msg.key]);
    }, 2000);

    return sock;
}

// ========================
// Main
// ========================
async function main() {
    console.log(`🤖 LionaAI - ${MODEL_NAME} siap`);
    try {
        await connectWhatsApp();
    } catch (e) {
        console.error('❌ Fatal:', e);
    }
}

process.on('SIGINT', () => { console.log('\n👋 Sampai jumpa!'); process.exit(0); });
main();
