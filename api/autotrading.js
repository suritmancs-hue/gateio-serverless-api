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

/* ===================== PRECISION CACHE ===================== */
const pairCache = new Map();

function toPrecision(value, precision) {
  return Number(value).toFixed(precision);
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
    const { pair, amount, side, trigger_price, rule, type } = req.body;
    const marketPair = String(pair).toUpperCase().replace("-", "_");

    // 🔑 ambil precision pair
    const pairInfo = await getPairInfo(marketPair);
    const pricePrecision = pairInfo.price_precision;
    const amountPrecision = pairInfo.amount_precision;

    let result;

    /* ===== TRIGGER ORDER ===== */
    if (type === "trigger") {
      const triggerPayload = {
        trigger: {
          price: toPrecision(trigger_price, pricePrecision),
          rule: String(rule),
          expiration: 86400 * 30
        },
        put: {
          type: "market",
          side: side || "sell",
          amount: toPrecision(amount, amountPrecision),
          account: "normal",
          time_in_force: "ioc"
        },
        market: marketPair
      };

      console.log("SENDING TRIGGER ORDER:", triggerPayload);
      result = await gateioRequest("POST", "/spot/price_orders", "", triggerPayload);

    } else {
      /* ===== MARKET ORDER ===== */
      const orderPayload = {
        currency_pair: marketPair,
        side: side || "buy",
        type: "market",
        account: "spot",
        amount: toPrecision(amount, amountPrecision),
        time_in_force: "fok"
      };

      console.log("SENDING MARKET ORDER:", orderPayload);
      result = await gateioRequest("POST", "/spot/orders", "", orderPayload);
    }

    if (!result.ok) {
      console.error("[GATEIO_ERROR_DETAIL]", result.data);
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
