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

// ============= KONFIGURASI =============
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VCARD_PATH = path.join(__dirname, 'vcard.vcf');
const SESSION_DIR = 'sessions';
const THUMB_PATH = path.join(__dirname, 'thumb.jpg'); // Letakkan file gambar thumbnail

// Global variables
global.ownername = 'FNL';
global.owner = '628123456789'; // Nomor tanpa +

// Cache untuk performa
const msgRetryCounterCache = new NodeCache();
const logger = pino({ level: 'silent' });

// ============= FUNGSI STYLES (CONTOH) =============
function Styles(text) {
    return text; // Anda bisa menambahkan styling di sini
}

// ============= FUNGSI MEMBACA VCARD DARI FILE =============
function readVcardFile() {
    try {
        if (!fs.existsSync(VCARD_PATH)) {
            return null;
        }

        let vcardContent = fs.readFileSync(VCARD_PATH, 'utf8');
        
        // Fix umum
        vcardContent = vcardContent
            .replace('BEGIN:VCDAR', 'BEGIN:VCARD')
            .replace('VERSION:2.1', 'VERSION:3.0');
        
        // Ekstrak display name
        let displayName = 'Kontak';
        const fnMatch = vcardContent.match(/FN:([^\n\r]+)/i);
        if (fnMatch) {
            displayName = fnMatch[1].trim();
        }

        return {
            content: vcardContent,
            displayName: displayName
        };
    } catch (error) {
        console.error('Error reading vcard:', error);
        return null;
    }
}

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
        browser: ['Bot VCF', 'Chrome', '1.0.0'],
        version: version,
        syncFullHistory: false,
        msgRetryCounterCache,
        defaultQueryTimeoutMs: 60000
    });

    // Handle QR Code
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n' + '='.repeat(50));
            console.log('📱 SCAN QR CODE INI DENGAN WHATSAPP ANDA');
            console.log('='.repeat(50));
            qrcode.generate(qr, { small: true });
            console.log('\n⏳ Menunggu scan...\n');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('❌ Koneksi terputus, reconnect dalam 3 detik...');
                setTimeout(() => connectToWhatsApp(), 3000);
            }
        } else if (connection === 'open') {
            console.log('\n✅ BOT WHATSAPP VCF BERHASIL TERHUBUNG!');
            console.log('📝 Commands: .vcf, .owner, .addprem');
        }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async ({ messages }) => {
        await handleMessages(sock, messages);
    });

    return sock;
}

// ============= HANDLER PESAN =============
async function handleMessages(sock, messages) {
    for (let msg of messages) {
        if (!msg.message || msg.key?.remoteJid === 'status@broadcast') continue;

        const messageContent = msg.message?.conversation || 
                              msg.message?.extendedTextMessage?.text || 
                              '';

        const jid = msg.key.remoteJid;
        const sender = msg.key.participant || jid;
        const isGroup = jid.endsWith('@g.us');

        if (!messageContent.startsWith('.')) continue;

        const command = messageContent.split(' ')[0].toLowerCase();
        const args = messageContent.substring(command.length).trim();
        
        console.log(`📨 Command: ${command} dari ${jid}`);

        // ============= COMMAND .VCF (DARI FILE) =============
        if (command === '.vcf') {
            try {
                const vcardData = readVcardFile();
                
                if (!vcardData) {
                    await sock.sendMessage(jid, { 
                        text: '❌ File vcard.vcf tidak ditemukan!' 
                    });
                    return;
                }

                const kontak = {
                    displayName: vcardData.displayName,
                    vcard: vcardData.content
                };

                await sock.sendMessage(jid, {
                    contacts: {
                        contacts: [kontak]
                    },
                    contextInfo: {
                        forwardingScore: 999,
                        isForwarded: false,
                        mentionedJid: [sender],
                        externalAdReply: {
                            showAdAttribution: true,
                            renderLargerThumbnail: true,
                            title: Styles(`📇 Kontak dari file vcard.vcf`),
                            containsAutoReply: true,
                            mediaType: 1,
                            jpegThumbnail: fs.existsSync(THUMB_PATH) ? fs.readFileSync(THUMB_PATH) : null,
                            mediaUrl: `https://youtube.com/@KayyOffc`,
                            sourceUrl: `https://youtube.com/@KayyOffc`
                        }
                    }
                }, { quoted: msg });

                console.log(`✅ Kontak ${vcardData.displayName} terkirim`);

            } catch (error) {
                console.error('Error:', error);
                await sock.sendMessage(jid, { 
                    text: '❌ Gagal mengirim kontak: ' + error.message 
                });
            }
        }

        // ============= COMMAND .OWNER =============
        if (command === '.owner') {
            try {
                const kontak = {
                    displayName: 'My Owner',
                    vcard: `BEGIN:VCARD
VERSION:3.0
N:;;;; 
FN:${global.ownername}
item1.TEL;waid=${global.owner}:+${global.owner}
item1.X-ABLabel:Owner
URL;Email Owner:${global.ownername}@gmail.com
ORG:INI OWNER
END:VCARD`
                };

                await sock.sendMessage(jid, {
                    contacts: {
                        contacts: [kontak]
                    },
                    contextInfo: {
                        forwardingScore: 999,
                        isForwarded: false,
                        mentionedJid: [sender],
                        externalAdReply: {
                            showAdAttribution: true,
                            renderLargerThumbnail: true,
                            title: Styles(`My Owner ${global.ownername}`),
                            containsAutoReply: true,
                            mediaType: 1,
                            jpegThumbnail: fs.existsSync(THUMB_PATH) ? fs.readFileSync(THUMB_PATH) : null,
                            mediaUrl: `https://youtube.com/@KayyOffc`,
                            sourceUrl: `https://youtube.com/@KayyOffc`
                        }
                    }
                }, { quoted: msg });

                console.log(`✅ Kontak owner terkirim ke ${jid}`);

            } catch (error) {
                console.error('Error owner:', error);
                await sock.sendMessage(jid, { 
                    text: '❌ Gagal mengirim kontak owner' 
                });
            }
        }

        // ============= COMMAND .ADDPREM =============
        if (command === '.addprem') {
            // Cek apakah pengirim adalah owner
            const senderNumber = sender.split('@')[0];
            if (senderNumber !== global.owner) {
                await sock.sendMessage(jid, { 
                    text: '❌ Perintah ini hanya untuk owner!' 
                });
                return;
            }

            const targetNumber = args.split(' ')[0];
            const duration = args.split(' ')[1] || '30';

            if (!targetNumber) {
                await sock.sendMessage(jid, { 
                    text: '❌ Format: .addprem [nomor] [hari]\nContoh: .addprem 628123456789 30' 
                });
                return;
            }

            // Simulasi add premium (sesuaikan dengan database Anda)
            await sock.sendMessage(jid, {
                text: `✅ Berhasil menambahkan premium untuk @${targetNumber} selama ${duration} hari`,
                mentions: [targetNumber + '@s.whatsapp.net']
            });

            console.log(`➕ Premium added: ${targetNumber} (${duration} hari)`);
        }
    }
}

// ============= FUNGSI UTAMA =============
async function main() {
    console.log('='.repeat(60));
    console.log('🤖 BOT WHATSAPP VCF - VERSI TERBARU');
    console.log('='.repeat(60));
    
    // Cek file thumbnail
    if (!fs.existsSync(THUMB_PATH)) {
        console.log('⚠️  File thumb.jpg tidak ditemukan, buat file dummy');
        // Buat dummy thumbnail 1x1 pixel (optional)
        const dummyThumb = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        fs.writeFileSync(THUMB_PATH, dummyThumb);
    }

    console.log('\n📁 Konfigurasi:');
    console.log(`👤 Owner: ${global.ownername} (${global.owner})`);
    console.log(`🖼️  Thumbnail: ${fs.existsSync(THUMB_PATH) ? 'Ada' : 'Tidak ada'}`);
    
    // Cek file vcard
    if (fs.existsSync(VCARD_PATH)) {
        console.log(`📇 File vcard.vcf: Ada`);
    } else {
        console.log(`📇 File vcard.vcf: Tidak ada (buat jika perlu)`);
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
