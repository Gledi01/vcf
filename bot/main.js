import makeWASocket, { 
    DisconnectReason, 
    useMultiFileAuthState 
} from '@whiskeysockets/baileys';
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
const OLLAMA_MODEL = 'Qwen3:0.6b';

const contactCache = new Map();

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

async function showMessage(sock, msg, text, isGroup) {
    try {
        const sender = msg.key.participant || msg.key.remoteJid;
        const nomor = sender.split('@')[0];
        const nama = await getContactName(sock, msg.key.remoteJid);
        const waktu = new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' });
        const tipe = isGroup ? '👥 GROUP' : '👤 PC';
        console.log(`\n${tipe} | ${waktu}`);
        console.log(`📌 ${nama} (${nomor})`);
        console.log(`💬 ${text}`);
    } catch (e) {}
}

async function askAI(question) {
    try {
        const { stdout } = await execPromise(
            `ollama run ${OLLAMA_MODEL} "${question.replace(/"/g, '\\"')}"`,
            { timeout: 180000 }
        );
        return stdout.trim() || '🤖 Done.';
    } catch (error) {
        return '❌ Error: ' + (error.message.includes('timeout') ? 'Timeout 3 menit' : 'Coba lagi');
    }
}

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

async function startBot() {
    console.log('🤖 QWEN3 0.6B - FIX BANGSAT');
    console.log('='.repeat(40));
    
    fixSession();
    
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // LOE BILANG GABISA PAKE INI
        browser: ['Qwen3 Bot', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false
    });

    // INI YANG LOE MINTA - QR MANUAL!
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // ========== INI DIA QR NYA BANGSAT ==========
        if (qr) {
            console.log('\n' + '='.repeat(50));
            console.log('📱 SCAN QR CODE INI GOBLOK!');
            console.log('='.repeat(50));
            qrcode.generate(qr, { small: true });
            console.log('\n' + '='.repeat(50));
            console.log('1. Buka WhatsApp');
            console.log('2. Titik 3 (Android) / Settings (iPhone)');
            console.log('3. Perangkat Tertaut');
            console.log('4. Tautkan Perangkat');
            console.log('5. Scan QR Code di ATAS');
            console.log('='.repeat(50) + '\n');
        }
        // ===========================================

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code === 515 || code === 440) {
                console.log('🧹 Session rusak, dibersihin...');
                fixSession();
            }
            if (code !== DisconnectReason.loggedOut) {
                console.log('🔄 Reconnect 5 detik...');
                setTimeout(startBot, 5000);
            }
        } else if (connection === 'open') {
            console.log('\n✅ BOT SIAP! .ai [tanya]\n');
        }
    });

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            try {
                if (msg.key?.fromMe) continue;
                if (msg.messageStubType === 'ERROR_DECRYPT') continue;
                
                let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
                if (!text) continue;
                
                const jid = msg.key.remoteJid;
                const isGroup = jid.endsWith('@g.us');
                
                await showMessage(sock, msg, text, isGroup);
                await sock.readMessages([msg.key]);
                
                if (text.startsWith('.ai')) {
                    const question = text.substring(4).trim();
                    if (!question) {
                        await sock.sendMessage(jid, { text: '❌ Contoh: .ai apa itu AI?' });
                        continue;
                    }
                    
                    await sock.sendPresenceUpdate('composing', jid);
                    await sock.sendMessage(jid, { text: '⏳ 3 menit...' });
                    
                    const answer = await askAI(question);
                    await sock.sendMessage(jid, { text: `*Qwen3:*\n\n${answer}` });
                }
            } catch (e) {}
        }
    });
}

startBot();
