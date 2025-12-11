// gateio-vercel-autotrade.js
// Auto-test leverage format (A, B, C) then submit order

const crypto = require('crypto');
const fetch = require('node-fetch');

const API_KEY = process.env.GATEIO_KEY;
const API_SECRET = process.env.GATEIO_SECRET;

const API_HOST = "https://api.gateio.ws";
const API_PREFIX = "/api/v4";
const ORDER_PATH = "/futures/usdt/orders";
const LEV_BASE = "/futures/usdt/positions";   // /{contract}/leverage

// --------------------------------------------------------------
// RAW BODY
// --------------------------------------------------------------
async function getRawBody(req) {
  if (req.rawBody) return req.rawBody.toString();
  if (typeof req.body === "string") return req.body;
  return new Promise((resolve) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => resolve(body));
  });
}

// --------------------------------------------------------------
// SIGN
// --------------------------------------------------------------
function gateSign(method, url, query, payload, timestamp, secret) {
  const hash = crypto.createHash("sha512").update(payload || "").digest("hex");

  const str =
    method + "\n" +
    url + "\n" +
    (query || "") + "\n" +
    hash + "\n" +
    timestamp;

  return crypto
    .createHmac("sha512", secret)
    .update(str)
    .digest("hex");
}

// --------------------------------------------------------------
// REQUEST
// --------------------------------------------------------------
async function gateioRequest(method, path, payload = "", query = "") {
  const url = API_PREFIX + path;
  const timestamp = String(Math.floor(Date.now() / 1000));

  const signature = gateSign(method, url, query, payload, timestamp, API_SECRET);
  const fullURL = API_HOST + url + (query ? "?" + query : "");

  const resp = await fetch(fullURL, {
    method,
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      KEY: API_KEY,
      Timestamp: timestamp,
      SIGN: signature,
    },
    body: payload || undefined
  });

  const raw = await resp.text();
  let json;
  try { json = JSON.parse(raw); }
  catch { json = { raw }; }

  console.log("[DEBUG Gate.io Response]", json);

  return { ok: resp.ok, json };
}

// --------------------------------------------------------------
// TRY 3 LEVERAGE FORMATS
// --------------------------------------------------------------
async function setLeverage(contract, leverage) {

  console.log("=== TESTING LEVERAGE FORMAT A ===");
  const A = await gateioRequest(
    "POST",
    `${LEV_BASE}/${contract}/leverage`,
    JSON.stringify({
      leverage: Number(leverage),
      cross_leverage: false
    }),
    ""
  );
  if (A.ok) return { success: true, method: "A", response: A.json };

  console.log("Format A failed:", A.json);

  // -------------------------------
  console.log("=== TESTING LEVERAGE FORMAT B (QUERY) ===");
  const B = await gateioRequest(
    "POST",
    `${LEV_BASE}/${contract}/leverage`,
    "",
    "leverage=" + Number(leverage)
  );
  if (B.ok) return { success: true, method: "B", response: B.json };

  console.log("Format B failed:", B.json);

  // -------------------------------
  console.log("=== TESTING LEVERAGE FORMAT C ===");
  const C = await gateioRequest(
    "POST",
    `${LEV_BASE}/${contract}/leverage`,
    JSON.stringify({
      lever_rate: Number(leverage)
    }),
    ""
  );
  if (C.ok) return { success: true, method: "C", response: C.json };

  console.log("Format C failed:", C.json);

  return { success: false, A: A.json, B: B.json, C: C.json };
}

// --------------------------------------------------------------
// MAIN
// --------------------------------------------------------------
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Use POST" });

    const raw = await getRawBody(req);
    let payload;
    try { payload = JSON.parse(raw); }
    catch { return res.status(400).json({ error: "Invalid JSON", raw }); }

    const { contract, side, size, leverage } = payload;

    if (!contract || !side || !size || !leverage)
      return res.status(400).json({ error: "Missing fields" });

    // ----------------------------------------------------
    // STEP 1 — Try 3 leverage formats
    // ----------------------------------------------------
    const lev = await setLeverage(contract, leverage);

    if (!lev.success) {
      return res.status(502).json({
        success: false,
        error: "All leverage formats failed",
        details: lev
      });
    }

    // ----------------------------------------------------
    // STEP 2 — SUBMIT ORDER
    // ----------------------------------------------------
    const order = await gateioRequest(
      "POST",
      ORDER_PATH,
      JSON.stringify({
        contract,
        size: side === "long" ? Number(size) : -Math.abs(Number(size)),
        price: "0",
        tif: "ioc"
      }),
      ""
    );

    if (!order.ok) {
      return res.status(502).json({
        success: false,
        step: "submit order",
        error: order.json
      });
    }

    return res.json({
      success: true,
      leverageMethod: lev.method,
      leverageResponse: lev.response,
      orderResponse: order.json
    });

  } catch (e) {
    console.error("[ERROR]", e);
    return res.status(500).json({ error: e.message });
  }
};
