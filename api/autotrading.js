const crypto = require("crypto");
const fetch = require("node-fetch");

// Konfigurasi API
const GATEIO_KEY = process.env.GATEIO_KEY;
const GATEIO_SECRET = process.env.GATEIO_SECRET;
const API_HOST = "https://api.gateio.ws";
const API_PREFIX = "/api/v4";

/**
 * Membuat Signature HMAC-SHA512 sesuai standar Gate.io v4
 */
function createGateioSignature(method, path, query, bodyString, timestamp, secret) {
    // 1. Hash dari Body (SHA512)
    const bodyHash = crypto.createHash('sha512')
        .update(bodyString || "", 'utf8')
        .digest('hex');
    
    // 2. Format String untuk Sign (Method + Path + Query + BodyHash + Timestamp)
    const signString = `${method}\n${path}\n${query || ""}\n${bodyHash}\n${timestamp}`;
    
    // 3. HMAC-SHA512
    return crypto.createHmac('sha512', secret)
        .update(signString, 'utf8')
        .digest('hex');
}

/**
 * Fungsi Universal untuk Request ke Gate.io
 */
async function gateioRequest(method, path, query = "", bodyObject = null) {
    const fullPath = API_PREFIX + path;
    const ts = String(Math.floor(Date.now() / 1000));
    
    // Gate.io Spot v4 wajib menggunakan JSON string
    const bodyString = bodyObject ? JSON.stringify(bodyObject) : "";
    
    const sign = createGateioSignature(method, fullPath, query, bodyString, ts, GATEIO_SECRET);

    const url = `${API_HOST}${fullPath}${query ? "?" + query : ""}`;

    try {
        const response = await fetch(url, {
            method: method,
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "KEY": GATEIO_KEY,
                "Timestamp": ts,
                "SIGN": sign
            },
            body: method !== "GET" ? bodyString : undefined
        });

        const json = await response.json();
        return { ok: response.ok, status: response.status, data: json };
    } catch (err) {
        return { ok: false, status: 500, data: { label: "FETCH_ERROR", message: err.message } };
    }
}

/**
 * LOGIK UTAMA: Eksekusi Beli Market (Spot)
 */
module.exports = async (req, res) => {
    // Keamanan: Hanya izinkan POST (Opsional, untuk webhook TradingView)
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method not allowed. Use POST." });
    }

    if (!GATEIO_KEY || !GATEIO_SECRET) {
        return res.status(500).json({ error: "API Keys belum dikonfigurasi di Vercel." });
    }

    try {
        const { pair, amount, side, trigger_price, rule, type } = req.body;

        // Jika ini adalah request untuk TP/SL Trigger
        if (type === "trigger") {
            const triggerPayload = {
                trigger: {
                    price: String(trigger_price),
                    rule: rule, // ">=" untuk TP, "<=" untuk SL
                    expiration: 86400 * 30 // Berlaku 30 hari
                },
                put: {
                    type: "market", // Jual instan di harga pasar saat terpicu
                    side: side || "sell",
                    amount: String(amount),
                    account: "spot"
                },
                currency_pair: pair.toUpperCase().replace("-", "_")
            };
            
            // Endpoint khusus untuk Price Condition Order
            const result = await gateioRequest("POST", "/spot/price_orders", "", triggerPayload);
            return res.status(200).json({ success: true, data: result.data });
        }

        if (result.ok) {
            console.log("[SUCCESS] Order Berhasil:", result.data);
            return res.status(200).json({
                success: true,
                message: `Berhasil membeli ${pair}`,
                order_id: result.data.id,
                full_data: result.data 
            });
        } else {
            console.error("[ERROR] Gate.io Error:", result.data);
            return res.status(result.status).json({
                success: false,
                error: result.data
            });
        }

    } catch (error) {
        console.error("[CRITICAL] Server Error:", error);
        return res.status(500).json({ error: "Internal Server Error", message: error.message });
    }
};
