// ==============================
// Gate.io Futures Order Proxy
// Vercel Serverless Function
// ==============================

// Library
const crypto = require('crypto');
const fetch = require('node-fetch'); // Jika Node 18+, bisa pakai fetch built-in

// Environment variables dari Vercel
const API_KEY = process.env.GATEIO_KEY;
const API_SECRET = process.env.GATEIO_SECRET;

const API_HOST = 'https://api.gateio.ws';
const API_PATH = '/api/v4/futures/usdt/orders';


// --------------------------------------
// FUNCTION: Create Gate.io Signature
// --------------------------------------
function createGateioSignature(method, path, bodyString, timestamp, secret) {
    const secretBuf = Buffer.from(String(secret).trim());

    // Body hash (sha512 hexdigest)
    const bodyHash = crypto
        .createHash('sha512')
        .update(bodyString, 'utf8')
        .digest('hex');

    console.log("[DEBUG bodyHash length]", bodyHash.length);

    // Harus EXACT sesuai docs: 
    // timestamp\nmethod\nrequestPath\n\nbodyHash
    const signString = `${timestamp}\n${method}\n${path}\n\n${bodyHash}`;

    console.log('[DEBUG signString]\n' + signString);

    // HMAC SHA512
    return crypto
        .createHmac('sha512', secretBuf)
        .update(signString)
        .digest('hex');
}


// --------------------------------------
// MAIN HANDLER
// --------------------------------------
module.exports = async (req, res) => {
    // Validate API Keys
    if (!API_KEY || !API_SECRET) {
        return res.status(500).json({
            error: 'Gate.io API keys missing from environment variables.'
        });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
    }

    // Extract order data
    const { contract, side, size, leverage } = req.body;

    if (!contract || !side || !size || !leverage) {
        return res.status(400).json({
            error: 'Missing required trade parameters: contract, side, size, leverage'
        });
    }

    const method = 'POST';
    const timestamp = Math.floor(Date.now() / 1000).toString();

    // Format order
    const orderData = {
        contract: contract,
        size: side === 'long' ? String(size) : String(-size),
        price: "0",
        leverage: String(leverage)
    };

    const bodyString = JSON.stringify(orderData);

    console.log("[DEBUG bodyString] " + bodyString);

    // Generate signature
    const signature = createGateioSignature(
        method,
        API_PATH,
        bodyString,
        timestamp,
        API_SECRET
    );

    // --------------------------------------
    // SEND REQUEST TO GATE.IO
    // --------------------------------------
    try {
        const response = await fetch(API_HOST + API_PATH, {
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'key': API_KEY.trim(),
                'sign': signature,
                'timestamp': timestamp
            },
            body: bodyString
        });

        const raw = await response.text();
        let parsed = null;

        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            console.log("[ERROR] JSON parse failed, raw response:", raw);
            parsed = { raw };
        }

        console.log("[DEBUG Gate.io response]", parsed);

        if (!response.ok) {
            return res.status(502).json({
                success: false,
                error: 'Gate.io API Error',
                details: parsed
            });
        }

        return res.status(200).json({
            success: true,
            gateioResponse: parsed
        });

    } catch (error) {
        console.error("[ERROR] Internal server error", error);
        return res.status(500).json({
            success: false,
            error: 'Internal Server Error',
            details: error.message
        });
    }
};
