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

module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed." });
    if (!GATEIO_KEY || !GATEIO_SECRET) return res.status(500).json({ error: "API Keys missing." });

    try {
        const { pair, amount, side, trigger_price, rule, type } = req.body;
        let result;

        // --- SKENARIO 1: TRIGGER ORDER (TP/SL) ---
        if (type === "trigger") {
            const triggerPayload = {
                trigger: {
                    price: String(trigger_price),
                    rule: rule, // ">=" atau "<="
                    expiration: 86400 * 30 
                },
                put: {
                    type: "market", 
                    side: side || "sell",
                    amount: String(amount),
                    account: "spot"
                },
                currency_pair: pair.toUpperCase().replace("-", "_")
            };
            
            result = await gateioRequest("POST", "/spot/price_orders", "", triggerPayload);
        } 
        // --- SKENARIO 2: MARKET BUY ORDER (EKSEKUSI AWAL) ---
        else {
            const orderPayload = {
                currency_pair: pair.toUpperCase().replace("-", "_"),
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
            console.log("[SUCCESS] Order Berhasil:", result.data);
            return res.status(200).json({
                success: true,
                message: `Order ${type || 'market'} ${pair} berhasil`,
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
        return res.status(500).json({ error: "Internal Error", message: error.message });
    }
};
