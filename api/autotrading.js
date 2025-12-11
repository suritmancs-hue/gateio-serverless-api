// Menggunakan pustaka crypto bawaan Node.js untuk hashing aman
const crypto = require('crypto');
const fetch = require('node-fetch'); // Ganti dengan 'undici' jika Anda menggunakan Node.js versi 18+

// Kunci API diambil dari Environment Variables Vercel
const GATEIO_KEY = process.env.GATEIO_KEY;
const GATEIO_SECRET = process.env.GATEIO_SECRET;

const API_HOST = 'https://api.gateio.ws';
const API_PATH = '/api/v4/futures/usdt/orders';

// Fungsi untuk membuat signature (HMAC SHA-512)
function createGateioSignature(method, path, bodyString, timestamp, secret) {
    
    // **1. Membersihkan dan Memverifikasi Kunci Rahasia**
    const cleanSecret = Buffer.from(String(secret).trim(), 'utf8'); // Memastikan Secret adalah Buffer dari string bersih
    
    // **2. Hitung Body Hash (SHA512)**
    const bodyHash = crypto.createHash('sha512').update(String(bodyString), 'utf8').digest('hex');
    
    // **3. Buat Signature String (5 elemen)**
    // Format: TIMESTAMP\nMETHOD\nPATH\n\nBODY_HASH
    const signString = `${timestamp}\n${method}\n${path}\n\n${bodyHash}`;

    console.log(`[DEBUG] Sign String: \n${signString}`);
    
    // **4. Hitung Signature (HMAC SHA512)**
    // Kita berikan string tanda tangan mentah (signString)
    return crypto.createHmac('sha512', cleanSecret).update(signString, 'utf8').digest('hex');
}

// ...

// Fungsi Utama Handler Vercel
module.exports = async (req, res) => {
    // 0. Validasi Kunci dan Pembersihan Ekstra
    // Gunakan String() untuk menjamin tipe data yang diambil dari Env Vars
    const KEY = GATEIO_KEY ? String(GATEIO_KEY).trim() : null;
    const SECRET = GATEIO_SECRET ? String(GATEIO_SECRET).trim() : null; 

    if (!KEY || !SECRET) {
        return res.status(500).json({ error: 'API keys not configured or are empty after trimming.' });
    }
    
    if (!GATEIO_KEY || !GATEIO_SECRET) {
        return res.status(500).json({ error: 'API keys not configured in Vercel environment variables.' });
    }
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
    }

    // Ambil data yang dikirim dari Apps Script
    const { contract, side, size, leverage } = req.body;

    if (!contract || !side || !size || !leverage) {
        return res.status(400).json({ error: 'Missing required trade parameters in payload.' });
    }

    const method = 'POST';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    
    // Siapkan Data Order Gate.io
    const orderData = {
        contract: contract,
        size: (side === 'long' ? String(size) : String(-size)),
        price: '0', // Market Order
        leverage: String(leverage),
    };
    
    const bodyString = JSON.stringify(orderData);

    // Buat Signature
    const signature = createGateioSignature(method, API_PATH, bodyString, timestamp, SECRET);
    // Kirim Permintaan ke Gate.io
    try {
        const response = await fetch(API_HOST + API_PATH, {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'KEY': GATEIO_KEY,
                'SIGN': signature,
                'Timestamp': timestamp,
            },
            body: bodyString,
        });

        const responseText = await response.text();
        const responseJson = JSON.parse(responseText);

        if (response.ok) {
            // Berhasil
            return res.status(200).json({ success: true, gateioResponse: responseJson });
        } else {
            // Gagal di Gate.io (misalnya: insuficient funds)
            return res.status(502).json({ 
                success: false, 
                error: 'Gate.io API Error', 
                details: responseJson 
            });
            console.log(`[ERROR] Gate.io API Response: ${responseText}`);
        }
    } catch (error) {
        return res.status(500).json({ success: false, error: 'Internal Server Error', details: error.message });
    }
};
