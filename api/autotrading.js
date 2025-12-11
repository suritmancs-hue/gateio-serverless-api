// gateio-autotrade.js — DELIVERY FUTURES COMPATIBLE

const crypto = require("crypto");
const fetch = require("node-fetch");

const API_KEY = process.env.GATEIO_KEY;
const API_SECRET = process.env.GATEIO_SECRET;

const API_HOST = "https://api.gateio.ws";
const API_PREFIX = "/api/v4";

// ------------------------------------------------------------------
// SIGN EXACTLY LIKE GATE.IO PYTHON DOCS
// ------------------------------------------------------------------
function genSign(method, url, queryStr, payloadStr, timestamp) {
  const m = crypto.createHash("sha512");
  m.update(payloadStr || "");
  const bodyHash = m.digest("hex");

  const s =
    method +
    "\n" +
    url +
    "\n" +
    (queryStr || "") +
    "\n" +
    bodyHash +
    "\n" +
    timestamp;

  return crypto.createHmac("sha512", API_SECRET).update(s).digest("hex");
}

// ------------------------------------------------------------------
async function gateio(method, path, query = "", payloadObj = null) {
  const url = API_PREFIX + path;
  const timestamp = String(Math.floor(Date.now() / 1000));

  const payload = payloadObj ? JSON.stringify(payloadObj) : "";

  const signature = genSign(method, url, query, payload, timestamp);

  const fullURL = API_HOST + url + (query ? "?" + query : "");

  const resp = await fetch(fullURL, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      KEY: API_KEY,
      Timestamp: timestamp,
      SIGN: signature,
    },
    body: payload || undefined,
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
}

// ------------------------------------------------------------------
// SET LEVERAGE — DELIVERY ENDPOINT
// ------------------------------------------------------------------
async function setLeverage(contract, lev) {
  return await gateio(
    "POST",
    `/delivery/usdt/positions/${contract}/leverage`,
    `leverage=${lev}`,
    null
  );
}

// ------------------------------------------------------------------
// SUBMIT ORDER — DELIVERY ORDER FORMAT
// ------------------------------------------------------------------
async function submitOrder(contract, side, size) {
  return await gateio(
    "POST",
    `/delivery/orders`,
    "",
    {
      contract,
      size: side === "long" ? Number(size) : -Math.abs(Number(size)),
      price: "0",
      tif: "ioc",
    }
  );
}

// ------------------------------------------------------------------
// HANDLER
// ------------------------------------------------------------------
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
    const orderRes = await submitOrder(contract, side, size);

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
