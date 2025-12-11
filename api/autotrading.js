// gateio-autotrade.js — PERPETUAL FUTURES FINAL VERSION

const crypto = require("crypto");
const fetch = require("node-fetch"); 

const GATEIO_KEY = process.env.GATEIO_KEY;
const GATEIO_SECRET = process.env.GATEIO_SECRET;

const API_HOST = "https://api.gateio.ws";
const API_PREFIX = "/api/v4";

// ------------------------------------------------------------
// Signature & Authentication Core
// ------------------------------------------------------------
function createGateioSignature(method, path, query, bodyRaw, timestamp, secret) {
    // Membersihkan Kunci Rahasia
    const cleanSecret = String(secret).trim(); 
    
    // Body Hash: SHA512 dari bodyRaw (string JSON)
    const bodyHash = crypto.createHash('sha512').update(String(bodyRaw), 'utf8').digest('hex');
    
    // Signature String (5 elemen: Method\nPath\nQuery\nBodyHash\nTimestamp)
    const signString = `${timestamp}\n${method}\n${path}\n${query || ""}\n${bodyHash}`;
    
    // HMAC SHA512
    return crypto.createHmac('sha512', cleanSecret).update(signString, 'utf8').digest('hex');
}

// Universal Gate.io Caller
async function gateio(method, path, query = "", bodyRaw = "") {
    const url = API_PREFIX + path;
    const ts = String(Math.floor(Date.now() / 1000));
    
    const sign = createGateioSignature(method, path, query, bodyRaw, ts, GATEIO_SECRET);

    const fullURL = API_HOST + url + (query ? "?" + query : "");

    try {
        const resp = await fetch(fullURL, {
            method,
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "KEY": GATEIO_KEY,
                "Timestamp": ts,
                "SIGN": sign,
            },
            body: bodyRaw.length > 0 ? bodyRaw : undefined,
        });

        const raw = await resp.text();
        let json;
        try { 
            json = JSON.parse(raw); 
        } catch { 
            json = { raw }; 
        }

        console.log("[DEBUG Gate.io Response]", json);

        return { ok: resp.ok, json };
    } catch (e) {
        console.error("Fetch Error:", e);
        return { ok: false, json: { error: "Network Error", message: e.message } };
    }
}


// ------------------------------------------------------------
// API FUNCTIONS (Sequential Order)
// ------------------------------------------------------------

// 1. Memaksa Akun ke Single Mode (One-Way)
async function setPositionMode(contract) {
    // Mode Single (One-Way) diatur dengan dual_mode=false (melalui query string)
    const queryString = `dual_mode=false`; 
    
    return await gateio(
        "POST",
        `/futures/usdt/dual_mode`,
        queryString, 
        "" 
    );
}

// 2. Mengatur Leverage
async function setLeverage(contract, lev) {
    // Leverage dikirim sebagai Query String
    const queryString = `leverage=${String(lev)}`;
    
    return await gateio(
        "POST",
        `/futures/usdt/positions/${contract}/leverage`,
        queryString,
        "" 
    );
}

// 3. Menempatkan Market Order (Single Mode)
async function submitOrderFutures(contract, side, size) {
    // Size negatif untuk Short (Sell) dan positif untuk Long (Buy)
    const signedSize = (side === 'long' ? size : -size); 
    
    // Payload dalam format x-www-form-urlencoded
    const bodyRaw =
        `contract=${contract}` +
        `&size=${signedSize}` + 
        `&price=0` + // Market Order
        `&time_in_force=ioc` + // Immediate or Cancel
        `&text=api`;

    return await gateio(
        "POST",
        "/futures/usdt/orders",
        "",
        bodyRaw
    );
}

// ------------------------------------------------------------
// MAIN HANDLER VERCEL
// ------------------------------------------------------------
module.exports = async (req, res) => {
    if (!GATEIO_KEY || !GATEIO_SECRET) {
        return res.status(500).json({ error: 'API keys not configured in Vercel environment variables.' });
    }
    
    try {
        const rawBody = await new Promise((resolve) => {
            let b = "";
            req.on("data", (c) => (b += c));
            req.on("end", () => resolve(b));
        });

        const data = JSON.parse(rawBody);
        const { contract, side, size, leverage } = data;
        
        // --- PROSES EKSEKUSI BERURUTAN ---

        // 1. Memaksa ke Single Mode (One-Way)
        console.log("=== 1. SET POSITION MODE: SINGLE ===");
        const modeRes = await setPositionMode(contract); 
        if (!modeRes.ok) {
            return res.status(500).json({
                error: "Failed to switch to Single Mode",
                details: modeRes.json,
            });
        }

        // 2. Mengatur Leverage
        console.log("=== 2. SET LEVERAGE ===");
        const levRes = await setLeverage(contract, leverage);

        if (!levRes.ok) {
            return res.status(500).json({
                error: "Failed to set leverage",
                details: levRes.json,
            });
        }

        // 3. Menempatkan Market Order
        console.log("=== 3. SUBMIT ORDER ===");
        const orderRes = await submitOrderFutures(contract, side, size);

        if (!orderRes.ok) {
            return res.status(502).json({
                error: "Failed to submit order (Gate.io)",
                details: orderRes.json,
            });
        }
        
        // Output berhasil (Order ID akan ada di responseJson.gateioResponse.id)
        return res.status(200).json({
            success: true,
            message: "Order placed successfully in Single Mode.",
            order: orderRes.json,
        });

    } catch (err) {
        // Kesalahan parsing JSON atau kesalahan internal Vercel
        return res.status(500).json({ error: `Internal Vercel Error: ${err.message}` });
    }
};
