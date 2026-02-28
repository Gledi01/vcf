import makeWASocket, { 
    DisconnectReason, 
    useMultiFileAuthState 
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ============= KONFIGURASI =============
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VCARD_PATH = path.join(__dirname, 'vcard.vcf');
const SESSION_DIR = 'sessions';

// Logger configuration (minimal logging)
const logger = pino({ level: 'silent' });

// ============= FUNGSI MEMBACA VCARD =============
function readVcardFile() {
    try {
        if (!fs.existsSync(VCARD_PATH)) {
            console.error('❌ File vcard.vcf tidak ditemukan di:', VCARD_PATH);
            return null;
        }

        const vcardContent = fs.readFileSync(VCARD_PATH, 'utf8');
        
        if (!vcardContent.includes('BEGIN:VCARD') || !vcardContent.includes('END:VCARD')) {
            console.error('❌ Format file vcard.vcf tidak valid');
            return null;
        }

        // Ekstrak display name
        let displayName = 'Kontak';
        const fnMatch = vcardContent.match(/FN[^:]*:([^\n\r]+)/i);
        if (fnMatch) {
            displayName = fnMatch[1].trim().replace(/[;]/g, ' ').trim();
        }

        console.log('✅ File vcard.vcf berhasil dibaca');
        console.log('📇 Nama kontak:', displayName);
        
        return {
            content: vcardContent,
            displayName: displayName || 'Kontak'
        };
    } catch (error) {
        console.error('❌ Error membaca file vcard.vcf:', error.message);
        return null;
    }
}

// ============= FUNGSI KONEKSI WHATSAPP =============
async function connectToWhatsApp() {
    console.log('\n🔄 Memulai koneksi WhatsApp...');
    
    // Buat folder sessions jika belum ada
    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR);
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    
    const sock = makeWASocket({
        auth: state,
        logger: logger,
        browser: ['Bot VCF', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        generateHighQualityLinkPreview: false
    });

    // Handle QR Code MANUAL (karena printQRInTerminal sudah deprecated)
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // TAMPILKAN QR CODE SECARA MANUAL
        if (qr) {
            console.log('\n' + '='.repeat(50));
            console.log('📱 SCAN QR CODE INI DENGAN WHATSAPP ANDA');
            console.log('='.repeat(50));
            console.log('Cara scan:');
            console.log('1. Buka WhatsApp di HP');
            console.log('2. Tap titik 3 (atau Settings)');
            console.log('3. Pilih "Perangkat Tertaut"');
            console.log('4. Tap "Tautkan Perangkat"');
            console.log('5. Scan QR code di bawah ini:\n');
            
            // Generate QR code di terminal
            qrcode.generate(qr, { small: true });
            
            console.log('\n⏳ Menunggu scan...\n');
        }

        if (connection === 'close') {
            const shouldReconnect = 
                lastDisconnect?.error?.output?.statusCode !== 
                DisconnectReason.loggedOut;
            
            console.log('❌ Koneksi terputus...', 
                shouldReconnect ? 'Mencoba reconnect dalam 5 detik...' : 'Silakan jalankan ulang bot');
            
            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(), 5000);
            }
        } else if (connection === 'open') {
            console.log('\n✅ BOT WHATSAPP VCF BERHASIL TERHUBUNG!');
            console.log('📝 Kirim perintah .vcf di chat untuk mengirim kontak dari file vcard.vcf');
            console.log('💡 Contoh: .vcf\n');
        }
    });

    // Save credentials automatically
    sock.ev.on('creds.update', saveCreds);

    return sock;
}

// ============= HANDLER PESAN =============
async function handleMessages(sock, messages) {
    for (let msg of messages) {
        // Abaikan pesan status
        if (!msg.message || msg.key?.remoteJid === 'status@broadcast') continue;

        const messageContent = msg.message?.conversation || 
                              msg.message?.extendedTextMessage?.text || 
                              '';

        const jid = msg.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');

        // Handle command .vcf
        if (messageContent.toLowerCase().startsWith('.vcf')) {
            console.log(`📇 Menerima perintah .vcf dari ${isGroup ? 'Group' : 'Personal'} ${jid}`);
            
            try {
                // Baca file vcard.vcf
                const vcardData = readVcardFile();
                
                if (!vcardData) {
                    await sock.sendMessage(jid, {
                        text: '❌ Gagal membaca file vcard.vcf. Pastikan file tersedia dan formatnya benar.\n\n' +
                              '📝 Cara membuat file vcard.vcf:\n' +
                              'BEGIN:VCARD\n' +
                              'VERSION:3.0\n' +
                              'FN:Nama Kontak\n' +
                              'TEL:+628123456789\n' +
                              'END:VCARD'
                    });
                    continue;
                }

                // Kirim kontak
                await sock.sendMessage(jid, {
                    contacts: {
                        displayName: vcardData.displayName,
                        contacts: [{
                            vcard: vcardData.content
                        }]
                    }
                });

                // Kirim konfirmasi
                await sock.sendMessage(jid, {
                    text: `✅ Kontak *${vcardData.displayName}* berhasil dikirim dari file vcard.vcf!`
                });

                console.log(`✅ Kontak ${vcardData.displayName} berhasil dikirim ke ${jid}`);

            } catch (error) {
                console.error('❌ Error mengirim vCard:', error);
                await sock.sendMessage(jid, {
                    text: '❌ Gagal mengirim kontak. Error: ' + error.message
                });
            }
        }
    }
}

// ============= FUNGSI UTAMA =============
async function main() {
    console.log('='.repeat(60));
    console.log('🤖 BOT WHATSAPP VCF - KIRIM KONTAK DARI FILE vcard.vcf');
    console.log('='.repeat(60));
    
    // Cek file vcard.vcf
    console.log('\n📁 Memeriksa file vcard.vcf...');
    const vcardCheck = readVcardFile();
    
    if (!vcardCheck) {
        console.log('\n⚠️  FILE vcard.vcf TIDAK DITEMUKAN ATAU TIDAK VALID!');
        console.log('📁 Lokasi file:', VCARD_PATH);
        console.log('\n📝 Buat file vcard.vcf dengan format:');
        console.log('BEGIN:VCARD');
        console.log('VERSION:3.0');
        console.log('FN:Nama Kontak');
        console.log('TEL:+628123456789');
        console.log('END:VCARD');
    } else {
        console.log('\n📇 PREVIEW FILE vcard.vcf:');
        console.log('-'.repeat(40));
        const lines = vcardCheck.content.split('\n');
        for (let i = 0; i < Math.min(5, lines.length); i++) {
            console.log(lines[i]);
        }
        if (lines.length > 5) console.log('...');
        console.log('-'.repeat(40));
    }

    console.log('\n🔄 Menghubungkan ke WhatsApp...');
    console.log('⏳ Mohon tunggu, QR Code akan tampil sebentar...\n');
    
    try {
        const sock = await connectToWhatsApp();

        // Handler pesan masuk
        sock.ev.on('messages.upsert', async ({ messages }) => {
            await handleMessages(sock, messages);
        });

    } catch (error) {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    }
}

// ============= HANDLE SHUTDOWN =============
process.on('SIGINT', () => {
    console.log('\n\n👋 Bot dimatikan. Sampai jumpa!');
    process.exit(0);
});

// ============= JALANKAN BOT =============
main();
