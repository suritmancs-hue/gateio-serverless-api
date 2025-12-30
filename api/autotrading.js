const crypto = require("crypto");
const fetch = require("node-fetch");

const GATEIO_KEY = process.env.GATEIO_KEY;
const GATEIO_SECRET = process.env.GATEIO_SECRET;
const API_HOST = "https://api.gateio.ws";
const API_PREFIX = "/api/v4";

/* ===================== SIGNATURE ===================== */
function createGateioSignature(method, path, query, bodyString, timestamp, secret) {
  const bodyHash = crypto.createHash("sha512").update(bodyString || "", "utf8").digest("hex");
  const signString = `${method}\n${path}\n${query || ""}\n${bodyHash}\n${timestamp}`;
  return crypto.createHmac("sha512", secret).update(signString, "utf8").digest("hex");
}

async function gateioRequest(method, path, query = "", bodyObject = null) {
  const fullPath = API_PREFIX + path;
  const ts = String(Math.floor(Date.now() / 1000));
  const bodyString = bodyObject ? JSON.stringify(bodyObject) : "";
  const sign = createGateioSignature(method, fullPath, query, bodyString, ts, GATEIO_SECRET);
  const url = `${API_HOST}${fullPath}${query ? "?" + query : ""}`;

  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      KEY: GATEIO_KEY,
      Timestamp: ts,
      SIGN: sign
    },
    body: method !== "GET" ? bodyString : undefined
  });

  const json = await response.json();
  return { ok: response.ok, status: response.status, data: json };
}

/* ===================== IMPROVED PRECISION ===================== */
const pairCache = new Map();

/**
 * Mencegah angka kecil berubah menjadi '0' atau scientific notation (1e-7)
 */
function toPrecision(value, precision) {
  if (value === undefined || value === null || isNaN(value)) return "0";
  
  // Menggunakan toLocaleString untuk memaksa format desimal murni
  const num = Number(value);
  const formatted = num.toLocaleString('fullwide', {
    useGrouping: false,
    maximumFractionDigits: precision
  });
  
  // Bersihkan trailing zeros yang tidak perlu agar tidak memicu 'invalid argument'
  return String(parseFloat(formatted));
}

async function getPairInfo(pair) {
  if (pairCache.has(pair)) return pairCache.get(pair);

  const res = await gateioRequest("GET", "/spot/currency_pairs");
  if (!res.ok) throw new Error("Failed to fetch currency pairs");

  const info = res.data.find(p => p.id === pair);
  if (!info) throw new Error(`Invalid market pair: ${pair}`);

  pairCache.set(pair, info);
  return info;
}

/* ===================== HANDLER ===================== */
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  if (!GATEIO_KEY || !GATEIO_SECRET) return res.status(500).json({ error: "API Keys missing." });

  try {
    const { pair, amount, side, trigger_price, rule, type, trail_value } = req.body;
    const marketPair = String(pair).toUpperCase().replace("-", "_");

    /* ===== FITUR CEK SALDO ===== */
    if (type === "get_balance") {
      const currency = String(pair).split('_')[0].toUpperCase();
      const balanceRes = await gateioRequest("GET", "/spot/accounts", `currency=${currency}`);
      
      if (!balanceRes.ok) return res.status(balanceRes.status).json({ success: false, error: balanceRes.data });
      
      const available = balanceRes.data.length > 0 ? balanceRes.data[0].available : "0";
      return res.status(200).json({ success: true, available: available });
    }

    // 🔑 Ambil info resmi dari Gate.io
    const pairInfo = await getPairInfo(marketPair);
    const pricePrecision = pairInfo.precision;
    const amountPrecision = pairInfo.amount_precision;

    let result;

    /* ===== TRIGGER ORDER (TP/SL) ===== */
    if (type === "trigger") {
      const formattedPrice = toPrecision(trigger_price, pricePrecision);
      
      if (formattedPrice === "0") throw new Error(`Trigger price resolved to 0 for ${pair}`);

      const triggerPayload = {
        trigger: {
          price: formattedPrice,
          rule: String(rule),
          expiration: 86400 * 30
        },
        put: {
          type: "market",
          side: side || "sell",
          amount: toPrecision(amount, amountPrecision),
          account: "normal",
          // Gate.io v4 Price Orders untuk Market sering menolak 'ioc' 
          // Jika Anda ingin tetap ada, pastikan huruf kecil 'ioc' atau 'fok'
          time_in_force: "ioc" 
        },
        market: marketPair
      };

      console.log("SENDING TRIGGER ORDER:", JSON.stringify(triggerPayload));
      result = await gateioRequest("POST", "/spot/price_orders", "", triggerPayload);

    } else {
      /* ===== MARKET ORDER (Eksekusi Awal) ===== */
      const orderPayload = {
        currency_pair: marketPair,
        side: side || "buy",
        type: "market",
        account: "spot",
        amount: toPrecision(amount, amountPrecision),
        // Untuk orders/spot, 'fok' biasanya lebih diterima
        time_in_force: "fok"
      };

      console.log("SENDING MARKET ORDER:", JSON.stringify(orderPayload));
      result = await gateioRequest("POST", "/spot/orders", "", orderPayload);
    }

    if (!result.ok) {
      console.error("[GATEIO_ERROR_DETAIL]", JSON.stringify(result.data));
      return res.status(result.status).json({ success: false, error: result.data });
    }

    return res.status(200).json({
      success: true,
      order_id: result.data.id,
      data: result.data
    });

  } catch (err) {
    console.error("[CRITICAL]", err.message);
    return res.status(500).json({ error: err.message });
  }
};
