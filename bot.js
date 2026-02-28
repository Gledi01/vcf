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

// Cache untuk performa lebih baik
const msgRetryCounterCache = new NodeCache();

// Logger minimal
const logger = pino({ level: 'silent' });

// ============= FUNGSI MEMBUAT VCARD FORMAT WA =============
function createWhatsAppVcard() {
    // Buat vCard dengan format yang benar untuk WhatsApp
    const vcard = [
        'BEGIN:VCARD',
        'VERSION:3.0',  // PAKAI VERSION 3.0 (bukan 2.1)
        'N:FNL;;;',
        'FN:FNL',
        'TEL;type=CELL;type=VOICE;waid=628123456789:+62 812-3456-789', // Format dengan waid
        'END:VCARD'
    ].join('\n');
    
    return {
        content: vcard,
        displayName: 'FNL'
    };
}

// ============= FUNGSI MEMBACA VCARD DARI FILE =============
function readVcardFile() {
    try {
        if (!fs.existsSync(VCARD_PATH)) {
            console.log('📝 File vcard.vcf tidak ditemukan, menggunakan vCard default');
            return createWhatsAppVcard();
        }

        let vcardContent = fs.readFileSync(VCARD_PATH, 'utf8');
        
        // Perbaiki typo umum
        vcardContent = vcardContent
            .replace('BEGIN:VCDAR', 'BEGIN:VCARD')
            .replace('VERSION:2.1', 'VERSION:3.0'); // PAKSA JADI VERSION 3.0
        
        // Validasi format
        if (!vcardContent.includes('BEGIN:VCARD') || !vcardContent.includes('END:VCARD')) {
            console.log('❌ Format file vcard.vcf tidak valid, menggunakan vCard default');
            return createWhatsAppVcard();
        }

        // Pastikan ada FN: (ini penting untuk display name)
        if (!vcardContent.includes('FN:')) {
            // Tambahkan FN jika tidak ada
            const lines = vcardContent.split('\n');
            const insertIndex = lines.findIndex(l => l.includes('BEGIN:VCARD')) + 1;
            lines.splice(insertIndex, 0, 'FN:FNL');
            vcardContent = lines.join('\n');
        }

        // Pastikan format TEL benar untuk WhatsApp
        if (!vcardContent.includes('waid=')) {
            // Extract nomor dan tambahkan waid
            const telMatch = vcardContent.match(/TEL[^:]*:[\+]?([0-9]+)/);
            if (telMatch) {
                const phone = telMatch[1];
                vcardContent = vcardContent.replace(
                    /TEL[^:]*:([^\n]+)/,
                    `TEL;type=CELL;type=VOICE;waid=${phone}:$1`
                );
            }
        }

        // Ekstrak display name
        let displayName = 'Kontak';
        const fnMatch = vcardContent.match(/FN:([^\n\r]+)/i);
        if (fnMatch) {
            displayName = fnMatch[1].trim();
        }

        console.log('✅ File vcard.vcf berhasil dibaca');
        console.log('📇 Nama kontak:', displayName);
        
        return {
            content: vcardContent,
            displayName: displayName
        };
    } catch (error) {
        console.error('❌ Error membaca file:', error.message);
        return createWhatsAppVcard();
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
            console.log('📝 Kirim perintah .vcf di chat untuk mengirim kontak');
            console.log('💡 Kontak akan muncul sebagai card yang bisa di-save\n');
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

        if (messageContent.toLowerCase().startsWith('.vcf')) {
            console.log(`📇 Menerima perintah .vcf dari ${jid}`);
            
            try {
                // Baca vCard
                const vcardData = readVcardFile();
                
                console.log('📤 Mengirim kontak:', vcardData.displayName);
                console.log('📄 Format vCard:', vcardData.content.substring(0, 100) + '...');

                // KIRIM KONTAK - INI YANG AKAN MUNCUL SEBAGAI CARD
                await sock.sendMessage(jid, {
                    contacts: {
                        displayName: vcardData.displayName,
                        contacts: [{
                            vcard: vcardData.content
                        }]
                    }
                });

                console.log(`✅ Kontak ${vcardData.displayName} berhasil dikirim`);

            } catch (error) {
                console.error('❌ Error:', error);
                await sock.sendMessage(jid, {
                    text: '❌ Gagal mengirim kontak'
                });
            }
        }
    }
}

// ============= FUNGSI UTAMA =============
async function main() {
    console.log('='.repeat(60));
    console.log('🤖 BOT WHATSAPP VCF - KIRIM KONTAK CARD');
    console.log('='.repeat(60));
    
    // Test vCard
    console.log('\n📁 Memeriksa konfigurasi vCard...');
    const testVcard = createWhatsAppVcard();
    console.log('✅ Format vCard siap digunakan');
    console.log('📇 Nama kontak:', testVcard.displayName);
    console.log('📄 Preview:', testVcard.content.replace(/\n/g, ' • '));

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
