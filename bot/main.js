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
import axios from 'axios';
import publicIp from 'public-ip';

// ============= KONFIGURASI =============
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSION_DIR = 'sessions';

// Cache
const msgRetryCounterCache = new NodeCache();
const logger = pino({ level: 'silent' });

// Cache untuk data kontak
const contactCache = new Map();
const ipCache = new Map();

// ============= FUNGSI DAPATKAN IP PUBLIK =============
async function getPublicIP() {
    try {
        const ip = await publicIp.v4();
        return ip;
    } catch (error) {
        return 'Unknown IP';
    }
}

// ============= FUNGSI DAPATKAN GEOLOKASI DARI IP =============
async function getGeoLocation(ip) {
    try {
        // Cek cache dulu
        if (ipCache.has(ip)) {
            return ipCache.get(ip);
        }

        // Pake ipapi.co (gratis, tanpa API key)
        const response = await axios.get(`https://ipapi.co/${ip}/json/`);
        
        if (response.data && !response.data.error) {
            const geoData = {
                country: response.data.country_name || 'Unknown',
                city: response.data.city || 'Unknown',
                region: response.data.region || 'Unknown',
                latitude: response.data.latitude || 'Unknown',
                longitude: response.data.longitude || 'Unknown',
                isp: response.data.org || 'Unknown',
                timezone: response.data.timezone || 'Unknown'
            };
            
            // Simpan ke cache
            ipCache.set(ip, geoData);
            return geoData;
        }
        
        return null;
    } catch (error) {
        console.error('❌ Error get geolocation:', error.message);
        return null;
    }
}

// ============= FUNGSI FORMAT GEOLOKASI =============
function formatGeoLocation(geo) {
    if (!geo) return '🌍 Geolokasi: Tidak tersedia';
    
    return `🌍 GEOLOKASI:
   • Negara: ${geo.country}
   • Kota: ${geo.city}
   • Region: ${geo.region}
   • ISP: ${geo.isp}
   • Timezone: ${geo.timezone}
   • Koordinat: ${geo.latitude}, ${geo.longitude}`;
}

// ============= FUNGSI DAPATKAN NAMA KONTAK =============
async function getContactName(sock, jid) {
    try {
        // Cek cache dulu
        if (contactCache.has(jid)) {
            return contactCache.get(jid);
        }

        let name = 'Unknown';
        
        // Untuk personal chat
        if (jid.endsWith('@s.whatsapp.net')) {
            const contact = await sock.fetchContact(jid);
            name = contact?.name || contact?.notify || contact?.verifiedName || jid.split('@')[0];
        }
        // Untuk group
        else if (jid.endsWith('@g.us')) {
            const groupMetadata = await sock.groupMetadata(jid);
            name = groupMetadata.subject || 'Unknown Group';
        }
        
        // Simpan ke cache
        contactCache.set(jid, name);
        return name;
    } catch (error) {
        console.error('Error get contact name:', error.message);
        return jid.split('@')[0];
    }
}

// ============= FUNGSI FORMAT WAKTU =============
function getFormattedTime() {
    const now = new Date();
    const options = {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    };
    
    const formatter = new Intl.DateTimeFormat('id-ID', options);
    const parts = formatter.formatToParts(now);
    
    const date = `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
    const time = `${parts.find(p => p.type === 'hour').value}:${parts.find(p => p.type === 'minute').value}:${parts.find(p => p.type === 'second').value}`;
    
    return {
        full: `${date} ${time} WIB`,
        date,
        time
    };
}

// ============= FUNGSI LOG PESAN LENGKAP =============
async function logMessageDetails(sock, msg, messageContent, isGroup) {
    try {
        const jid = msg.key.remoteJid;
        const sender = msg.key.participant || jid;
        const senderNumber = sender.split('@')[0];
        
        // Dapatkan nama kontak
        const contactName = await getContactName(sock, jid);
        
        // Dapatkan waktu
        const waktu = getFormattedTime();
        
        // Dapatkan IP publik bot (bukan IP user)
        const botIP = await getPublicIP();
        
        // Dapatkan geolokasi dari IP bot
        const geoLocation = await getGeoLocation(botIP);
        
        // Tampilkan di konsol dengan format menarik
        console.log('\n' + '='.repeat(80));
        console.log(`📱 DETAIL PESAN MASUK [${waktu.full}]`);
        console.log('='.repeat(80));
        
        // Info Kontak
        console.log(`👤 KONTAK:`);
        console.log(`   • Nama: ${contactName}`);
        console.log(`   • JID: ${jid}`);
        console.log(`   • Nomor: ${senderNumber}`);
        console.log(`   • Tipe: ${isGroup ? 'Grup' : 'Personal'}`);
        
        // Info Pesan
        console.log(`\n💬 PESAN:`);
        console.log(`   • Isi: ${messageContent || '[Non-text message]'}`);
        console.log(`   • Panjang: ${messageContent?.length || 0} karakter`);
        console.log(`   • Waktu: ${waktu.time}`);
        console.log(`   • Tanggal: ${waktu.date}`);
        
        // Info IP Bot
        console.log(`\n🖥️  SERVER:`);
        console.log(`   • IP Publik: ${botIP}`);
        
        // Info Geolokasi (dari IP bot)
        if (geoLocation) {
            console.log(`\n${formatGeoLocation(geoLocation)}`);
        } else {
            console.log(`\n🌍 Geolokasi: Gagal mendapatkan data`);
        }
        
        // Info tambahan
        console.log(`\n📊 METADATA:`);
        console.log(`   • Message ID: ${msg.key.id}`);
        console.log(`   • From Me: ${msg.key.fromMe ? 'Ya' : 'Tidak'}`);
        console.log(`   • Type: ${Object.keys(msg.message || {})[0] || 'Unknown'}`);
        
        console.log('='.repeat(80) + '\n');
        
        return { contactName, waktu, botIP, geoLocation };
        
    } catch (error) {
        console.error('❌ Error logging message:', error.message);
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
        browser: ['Bot Logger', 'Chrome', '1.0.0'],
        version: version,
        syncFullHistory: false,
        msgRetryCounterCache,
        defaultQueryTimeoutMs: 60000
    });

    // Handle QR Code
    sock.ev.on('connection.update', async (update) => {
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
            console.log('\n✅ BOT LOGGER BERHASIL TERHUBUNG!');
            console.log('📝 Mode: Logging Lengkap');
            console.log('📝 Setiap pesan masuk akan ditampilkan detailnya di konsol\n');
            
            // Tampilkan IP bot saat connect
            const botIP = await getPublicIP();
            const geo = await getGeoLocation(botIP);
            console.log('🖥️  INFORMASI SERVER BOT:');
            console.log(`   • IP: ${botIP}`);
            if (geo) {
                console.log(`   • Lokasi: ${geo.city}, ${geo.country}`);
                console.log(`   • ISP: ${geo.isp}`);
            }
            console.log('');
        }
    });

    sock.ev.on('creds.update', saveCreds);
    
    // Handler pesan
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (let msg of messages) {
            if (!msg.message || msg.key?.remoteJid === 'status@broadcast') continue;
            
            // Ambil teks pesan
            let messageContent = '';
            if (msg.message?.conversation) {
                messageContent = msg.message.conversation;
            } else if (msg.message?.extendedTextMessage?.text) {
                messageContent = msg.message.extendedTextMessage.text;
            } else {
                messageContent = '[Media/Non-text message]';
            }

            const jid = msg.key.remoteJid;
            const isGroup = jid.endsWith('@g.us');

            // Log detail pesan
            await logMessageDetails(sock, msg, messageContent, isGroup);
            
            // Auto-read pesan
            if (!msg.key.fromMe) {
                await sock.readMessages([msg.key]);
            }
        }
    });

    return sock;
}

// ============= FUNGSI UTAMA =============
async function main() {
    console.log('='.repeat(80));
    console.log('🤖 BOT WHATSAPP LOGGER - LENGKAP DENGAN GEOLOKASI');
    console.log('='.repeat(80));
    
    // Tampilan awal
    console.log('\n📋 FITUR LOGGING:');
    console.log('   ✓ Nama kontak');
    console.log('   ✓ Isi pesan');
    console.log('   ✓ Waktu (jam & tanggal)');
    console.log('   ✓ IP publik bot');
    console.log('   ✓ Geolokasi dari IP (negara, kota, ISP)');
    console.log('   ✓ Metadata pesan\n');
    
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
