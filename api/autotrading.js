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

    // 1. Clean secret
    const secretBuf = Buffer.from(secret.trim());

    // 2. Body hash
    const bodyHash = crypto
        .createHash('sha512')
        .update(bodyString)
        .digest('hex');

    // 3. Signature string (HARUS EXACT)
    const signString =
        `${timestamp}\n${method}\n${path}\n\n${bodyHash}`;

    console.log('[DEBUG signString]\n' + signString);

    // 4. HMAC SHA512
    return crypto
        .createHmac('sha512', secretBuf)
        .update(signString)
        .digest('hex');
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
                'key': KEY,
                'sign': signature,
                'timestamp': timestamp,
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
