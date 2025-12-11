// gateio-vercel-autotrade.js
// Fully Auto-Leverage + Order Executor

const crypto = require('crypto');
const fetch = require('node-fetch');

const API_KEY = process.env.GATEIO_KEY;
const API_SECRET = process.env.GATEIO_SECRET;

const API_HOST = "https://api.gateio.ws";
const API_PREFIX = "/api/v4";
const ORDER_PATH = "/futures/usdt/orders";
const LEVERAGE_PATH = "/futures/usdt/positions"; // + /{contract}/leverage

// --------------------------------------------------------------------
// RAW BODY READER
// --------------------------------------------------------------------
async function getRawBody(req) {
  if (req.rawBody) {
    return typeof req.rawBody === "string"
      ? req.rawBody
      : req.rawBody.toString("utf8");
  }
  if (req.body && typeof req.body === "object") {
    try {
      return JSON.stringify(req.body);
    } catch (_) {}
  }
  if (typeof req.body === "string") {
    return req.body;
  }
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (err) => reject(err));
  });
}

// --------------------------------------------------------------------
// SIGNATURE (Identical to Gate.io Python example)
// --------------------------------------------------------------------
function gateSign(method, url, query, payload, timestamp, secret) {
  const bodyHash = crypto
    .createHash("sha512")
    .update(payload || "")
    .digest("hex");

  const signString =
    method +
    "\n" +
    url +
    "\n" +
    (query || "") +
    "\n" +
    bodyHash +
    "\n" +
    timestamp;

  const signature = crypto
    .createHmac("sha512", secret)
    .update(signString)
    .digest("hex");

  return signature;
}

// --------------------------------------------------------------------
// SEND SIGNED REQUEST
// --------------------------------------------------------------------
async function gateioRequest(method, path, payload = "") {
  const url = API_PREFIX + path;
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const signature = gateSign(
    method,
    url,
    "",
    payload,
    timestamp,
    API_SECRET
  );

  const resp = await fetch(API_HOST + url, {
    method,
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      KEY: API_KEY,
      Timestamp: timestamp,
      SIGN: signature,
    },
    body: payload,
  });

  const raw = await resp.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch (_) {
    json = { raw };
  }

  console.log("[DEBUG Gate.io Response]", json);
  return { ok: resp.ok, json };
}

// --------------------------------------------------------------------
// MAIN HANDLER
// --------------------------------------------------------------------
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST." });
    }

    // Read Payload
    const rawBody = await getRawBody(req);
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }

    const { contract, side, size, leverage } = body;

    if (!contract || !side || !size || !leverage) {
      return res.status(400).json({
        error: "Missing required fields: contract, side, size, leverage",
      });
    }

    // ------------------------------------------------------------
    // STEP 1: Set Leverage automatically
    // ------------------------------------------------------------
    console.log("=== SETTING LEVERAGE ===");

    const leverageBody = JSON.stringify({
      leverage: String(leverage)
    });

    const lev = await gateioRequest(
      "POST",
      `${LEVERAGE_PATH}/${contract}/leverage`,
      leverageBody
    );

    if (!lev.ok) {
      return res.status(502).json({
        success: false,
        step: "set leverage",
        error: lev.json,
      });
    }

    // ------------------------------------------------------------
    // STEP 2: Submit Order
    // ------------------------------------------------------------
    console.log("=== SUBMIT ORDER ===");

    const orderData = {
      contract,
      size: side === "long" ? Number(size) : -Math.abs(Number(size)),
      price: "0",
      tif: "ioc",
    };

    const orderPayload = JSON.stringify(orderData);

    const order = await gateioRequest("POST", ORDER_PATH, orderPayload);

    if (!order.ok) {
      return res.status(502).json({
        success: false,
        step: "submit order",
        error: order.json,
      });
    }

    return res.json({
      success: true,
      leverageResponse: lev.json,
      orderResponse: order.json,
    });

  } catch (err) {
    console.error("[ERROR]", err);
    return res.status(500).json({ error: err.message });
  }
};
