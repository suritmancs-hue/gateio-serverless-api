// gateio-autotrade.js — PERPETUAL FUTURES ONLY VERSION

const crypto = require("crypto");
const fetch = require("node-fetch");

const API_KEY = process.env.GATEIO_KEY;
const API_SECRET = process.env.GATEIO_SECRET;

const API_HOST = "https://api.gateio.ws";
const API_PREFIX = "/api/v4";

// ------------------------------------------------------------
// Signature — WAJIB: body adalah RAW STRING (x-www-form-urlencoded)
// ------------------------------------------------------------
function genSign(method, url, query, bodyRaw, timestamp) {
  const hash = crypto.createHash("sha512").update(bodyRaw || "").digest("hex");

  const signStr =
    method + "\n" +
    url + "\n" +
    (query || "") + "\n" +
    hash + "\n" +
    timestamp;

  return crypto
    .createHmac("sha512", API_SECRET)
    .update(signStr)
    .digest("hex");
}

// ------------------------------------------------------------
// Universal Gate.io Caller — FUTURES VERSION (x-www-form-urlencoded ONLY)
// ------------------------------------------------------------
async function gateio(method, path, query = "", bodyRaw = "") {
  const url = API_PREFIX + path;
  const ts = String(Math.floor(Date.now() / 1000));

  const sign = genSign(method, url, query, bodyRaw, ts);

  const fullURL = API_HOST + url + (query ? "?" + query : "");

  const resp = await fetch(fullURL, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      KEY: API_KEY,
      Timestamp: ts,
      SIGN: sign,
    },
    body: bodyRaw || undefined,
  });

  const raw = await resp.text();
  let json;
  try { json = JSON.parse(raw); }
  catch { json = { raw }; }

  console.log("[DEBUG Gate.io Response]", json);

  return { ok: resp.ok, json };
}

// ------------------------------------------------------------
// SET LEVERAGE — Format Resmi (tidak pakai body!)
// Dikemas dalam QUERY STRING
// ------------------------------------------------------------
async function setLeverage(contract, lev) {
  return await gateio(
    "POST",
    `/futures/usdt/positions/${contract}/leverage`,
    `leverage=${lev}`,   // query
    ""                   // body kosong
  );
}

// ------------------------------------------------------------
// SUBMIT FUTURES ORDER — MUST USE x-www-form-urlencoded
// ------------------------------------------------------------
async function submitOrderFutures(contract, side, size) {
  const body =
    `contract=${contract}` +
    `&size=${size}` +
    `&price=0` +
    `&side=${side}` +
    `&time_in_force=gtc` +
    `&iceberg=0` +
    `&text=api`;

  return await gateio(
    "POST",
    "/futures/usdt/orders",
    "",
    body
  );
}

// ------------------------------------------------------------
// MAIN HANDLER VERCEL
// ------------------------------------------------------------
module.exports = async (req, res) => {
  try {
    const raw = await new Promise((resolve) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => resolve(b));
    });

    const data = JSON.parse(raw);
    const { contract, side, size, leverage } = data;

    console.log("=== SET LEVERAGE ===");
    const levRes = await setLeverage(contract, leverage);

    if (!levRes.ok) {
      return res.status(500).json({
        error: "Failed to set leverage",
        details: levRes.json,
      });
    }

    console.log("=== SUBMIT ORDER ===");
    const orderRes = await submitOrderFutures(contract, side, size);

    if (!orderRes.ok) {
      return res.status(500).json({
        error: "Failed to submit order",
        details: orderRes.json,
      });
    }

    return res.json({
      success: true,
      leverage: levRes.json,
      order: orderRes.json,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
