const crypto = require("crypto");
const fetch = require("node-fetch");

const GATEIO_KEY = process.env.GATEIO_KEY;
const GATEIO_SECRET = process.env.GATEIO_SECRET;
const API_HOST = "https://api.gateio.ws";
const API_PREFIX = "/api/v4";

function createGateioSignature(method, path, query, bodyString, timestamp, secret) {
    const bodyHash = crypto.createHash('sha512').update(bodyString || "", 'utf8').digest('hex');
    const signString = `${method}\n${path}\n${query || ""}\n${bodyHash}\n${timestamp}`;
    return crypto.createHmac('sha512', secret).update(signString, 'utf8').digest('hex');
}

async function gateioRequest(method, path, query = "", bodyObject = null) {
    const fullPath = API_PREFIX + path;
    const ts = String(Math.floor(Date.now() / 1000));
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

// ... (Bagian atas script tetap sama)

module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed." });
    if (!GATEIO_KEY || !GATEIO_SECRET) return res.status(500).json({ error: "API Keys missing." });

    try {
        const { pair, amount, side, trigger_price, rule, type } = req.body;
        let result;

        // --- GANTI BLOK INI ---
        if (type === "trigger") {
            // Gabungkan definisinya di sini agar rapi
            const putOrder = {
                type: "market",
                side: side || "sell",
                amount: String(amount),
                price: "0",      // Wajib ada sebagai placeholder market order
                account: "spot"  // Pastikan tertulis "spot" (huruf kecil)
            };

            const triggerPayload = {
                trigger: {
                    price: String(trigger_price),
                    rule: String(rule),
                    expiration: 86400 * 30 
                },
                put: putOrder,
                currency_pair: String(pair).toUpperCase().replace("-", "_")
            };
            
            console.log("SENDING TRIGGER PAYLOAD:", JSON.stringify(triggerPayload));
            result = await gateioRequest("POST", "/spot/price_orders", "", triggerPayload);
        } 
        // --- BATAS AKHIR PERUBAHAN ---
        
        else {
            // Logika Market Buy tetap sama
            const orderPayload = {
                currency_pair: String(pair).toUpperCase().replace("-", "_"),
                side: side || "buy",
                type: "market",
                account: "spot",
                amount: String(amount),
                time_in_force: "fok"
            };
            result = await gateioRequest("POST", "/spot/orders", "", orderPayload);
        }

        // --- HANDLING RESPONSE ---
        if (result.ok) {
            return res.status(200).json({
                success: true,
                message: `Order ${type || 'market'} ${pair} berhasil`,
                order_id: result.data.id,
                full_data: result.data 
            });
        } else {
            console.error("[GATEIO_ERROR_DETAIL]", JSON.stringify(result.data));
            return res.status(result.status).json({
                success: false,
                error: result.data
            });
        }

    } catch (error) {
        console.error("[CRITICAL] Server Error:", error);
        return res.status(500).json({ error: "Internal Error", message: error.message });
    }
};
