// Menggunakan pustaka crypto bawaan Node.js untuk hashing aman
const crypto = require('crypto');

// Kunci API diambil dari Environment Variables Vercel
const GATEIO_KEY = process.env.GATEIO_KEY;
const GATEIO_SECRET = process.env.GATEIO_SECRET;

const API_HOST = 'https://api.gateio.ws';
const API_PATH = '/api/v4/futures/usdt/orders';

// Fungsi untuk membuat signature (HMAC SHA-512)
function createGateioSignature(method, path, bodyString, timestamp, secret) {
    // 1. Hitung Body Hash (SHA512)
    const bodyHash = crypto.createHash('sha512').update(bodyString).digest('hex');
    
    // 2. Buat Signature String (5 elemen dipisahkan \n)
    // Format: TIMESTAMP\nMETHOD\nPATH\nQUERY_STRING\nBODY_HASH
    // QUERY_STRING kosong
    const signString = `${timestamp}\n${method}\n${path}\n\n${bodyHash}`;
    
    // 3. Hitung Signature (HMAC SHA512)
    return crypto.createHmac('sha512', secret).update(signString).digest('hex');
}

// Fungsi Utama Handler Vercel
module.exports = async (req, res) => {
    // 0. Validasi Kunci
    if (!GATEIO_KEY || !GATEIO_SECRET) {
        return res.status(500).json({ error: 'API keys not configured in Vercel environment variables.' });
    }

    // 1. Ambil Data Sinyal dari Google Apps Script (payload POST)
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
    }

    const { contract, side, currentPrice, size, leverage } = req.body;

    if (!contract || !side || !currentPrice || !size || !leverage) {
        return res.status(400).json({ error: 'Missing required trade parameters in payload.' });
    }

    const method = 'POST';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    
    // 2. Siapkan Data Order Gate.io
    const orderData = {
        contract: contract,
        size: (side === 'long' ? size : -size), // Sign: Positif untuk long, negatif untuk short
        price: '0', // Market Order
        leverage: leverage.toString(),
    };
    
    const bodyString = JSON.stringify(orderData);

    // 3. Buat Signature
    const signature = createGateioSignature(method, API_PATH, bodyString, timestamp, GATEIO_SECRET);

    // 4. Kirim Permintaan ke Gate.io
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
            // Jika Market Order berhasil, kirim kembali response Gate.io ke GAS
            return res.status(200).json({ success: true, gateioResponse: responseJson });
        } else {
            // Gagal di Gate.io (ex: insuficient funds, invalid signature)
            return res.status(502).json({ 
                success: false, 
                error: 'Gate.io API Error', 
                details: responseJson 
            });
        }
    } catch (error) {
        return res.status(500).json({ success: false, error: 'Internal Server Error', details: error.message });
    }
};
