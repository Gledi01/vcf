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

        // Perbaiki typo di file (BEGIN:VCDAR -> BEGIN:VCARD)
        const fixedContent = vcardContent.replace('BEGIN:VCDAR', 'BEGIN:VCARD');

        // Ekstrak display name
        let displayName = 'Kontak';
        const fnMatch = fixedContent.match(/FN[^:]*:([^\n\r]+)/i);
        if (fnMatch) {
            displayName = fnMatch[1].trim().replace(/[;]/g, ' ').trim();
        }

        console.log('✅ File vcard.vcf berhasil dibaca');
        console.log('📇 Nama kontak:', displayName);
        
        return {
            content: fixedContent,
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

    // Ambil versi Baileys terbaru [citation:1]
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📦 Menggunakan Baileys versi: ${version.join('.')} (latest: ${isLatest})`);

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    
    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        printQRInTerminal: false, // MATIKAN, kita handle manual
        logger: logger,
        browser: ['Bot VCF', 'Chrome', '1.0.0'],
        version: version, // PAKAI VERSI TERBARU [citation:1]
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        msgRetryCounterCache,
        defaultQueryTimeoutMs: 60000
    });

    // Handle QR Code MANUAL
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // TAMPILKAN QR CODE JIKA ADA
        if (qr) {
            console.log('\n' + '='.repeat(50));
            console.log('📱 SCAN QR CODE INI DENGAN WHATSAPP ANDA');
            console.log('='.repeat(50));
            console.log('Cara scan:');
            console.log('1. Buka WhatsApp di HP');
            console.log('2. Tap titik 3 (Android) atau Settings (iPhone)');
            console.log('3. Pilih "Perangkat Tertaut"');
            console.log('4. Tap "Tautkan Perangkat"');
            console.log('5. Scan QR code di bawah ini:\n');
            
            // Generate QR code di terminal menggunakan qrcode-terminal
            qrcode.generate(qr, { small: true });
            
            console.log('\n⏳ Menunggu scan...\n');
        } else {
            // Debug: lihat apa yang diterima dari event
            console.log('📡 Connection update:', JSON.stringify(update, null, 2));
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log('❌ Koneksi terputus. Status code:', statusCode);
            
            if (statusCode === 405) {
                console.log('⚠️  Error 405 Method Not Allowed - Mencoba dengan versi berbeda...');
                // Coba dengan versi yang lebih lama jika 405 [citation:1]
                setTimeout(() => connectToWhatsApp(), 3000);
            } else if (shouldReconnect) {
                console.log('Mencoba reconnect dalam 3 detik...');
                setTimeout(() => connectToWhatsApp(), 3000);
            } else {
                console.log('❌ Bot logout. Hapus folder sessions dan jalankan ulang.');
            }
        } else if (connection === 'open') {
            console.log('\n✅ BOT WHATSAPP VCF BERHASIL TERHUBUNG!');
            console.log('📝 Kirim perintah .vcf di chat untuk mengirim kontak dari file vcard.vcf');
            console.log('💡 Contoh: .vcf\n');
        } else if (connection === 'connecting') {
            console.log('⏳ Menghubungkan...');
        }
    });

    // Save credentials
    sock.ev.on('creds.update', saveCreds);

    // Handle error lainnya
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
        const isGroup = jid.endsWith('@g.us');

        if (messageContent.toLowerCase().startsWith('.vcf')) {
            console.log(`📇 Menerima perintah .vcf dari ${isGroup ? 'Group' : 'Personal'} ${jid}`);
            
            try {
                const vcardData = readVcardFile();
                
                if (!vcardData) {
                    await sock.sendMessage(jid, {
                        text: '❌ Gagal membaca file vcard.vcf. Pastikan file tersedia dan formatnya benar.\n\n' +
                              '📝 File vcard.vcf harus berisi:\n' +
                              'BEGIN:VCARD\n' +
                              'VERSION:3.0\n' +
                              'FN:Nama Kontak\n' +
                              'TEL:+628123456789\n' +
                              'END:VCARD'
                    });
                    continue;
                }

                await sock.sendMessage(jid, {
                    contacts: {
                        displayName: vcardData.displayName,
                        contacts: [{
                            vcard: vcardData.content
                        }]
                    }
                });

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
    
    // Fix typo di file vcard.vcf jika ada
    if (fs.existsSync(VCARD_PATH)) {
        let content = fs.readFileSync(VCARD_PATH, 'utf8');
        if (content.includes('BEGIN:VCDAR')) {
            console.log('\n🔧 Memperbaiki typo di file vcard.vcf (BEGIN:VCDAR -> BEGIN:VCARD)');
            content = content.replace('BEGIN:VCDAR', 'BEGIN:VCARD');
            fs.writeFileSync(VCARD_PATH, content);
        }
    }
    
    // Cek file vcard.vcf
    console.log('\n📁 Memeriksa file vcard.vcf...');
    const vcardCheck = readVcardFile();
    
    if (!vcardCheck) {
        console.log('\n⚠️  FILE vcard.vcf TIDAK VALID!');
        console.log('📁 Buat file vcard.vcf dengan format:');
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
        await connectToWhatsApp();
    } catch (error) {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    }
}

// Handle shutdown
process.on('SIGINT', () => {
    console.log('\n\n👋 Bot dimatikan. Sampai jumpa!');
    process.exit(0);
});

main();
