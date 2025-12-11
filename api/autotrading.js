// gateio-vercel-autotrade.js
// Vercel Serverless Function for Gate.io Futures Orders
// FINAL VERSION – ready for deployment

const crypto = require('crypto');
const fetch = require('node-fetch'); // or 'undici' if Node 18+

// Env vars
const API_KEY = process.env.GATEIO_KEY;
const API_SECRET = process.env.GATEIO_SECRET;

const API_HOST = 'https://api.gateio.ws';
const API_PATH = '/api/v4/futures/usdt/orders';

// ------------------------------------------------------------
// Helper: robust raw body reader (supports Vercel rawBody)
// ------------------------------------------------------------
async function getRawBody(req) {
  if (req.rawBody) {
    return typeof req.rawBody === 'string'
      ? req.rawBody
      : req.rawBody.toString('utf8');
  }

  if (req.body && typeof req.body === 'object') {
    try {
      return JSON.stringify(req.body);
    } catch (_) {}
  }

  if (typeof req.body === 'string') return req.body;

  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ------------------------------------------------------------
// Signature Generator (HMAC SHA-512)
// ------------------------------------------------------------
function createGateioSignature(method, path, bodyString, timestamp, secret) {
  const cleanedSecret = String(secret || '').trim();
  const secretBuf = Buffer.from(cleanedSecret, 'utf8');

  const bodyHash = crypto
    .createHash('sha512')
    .update(Buffer.from(bodyString, 'utf8'))
    .digest('hex');

  console.log('[DEBUG bodyHash length]', bodyHash.length);

  // append trailing ?
  const signPath = `${path}?`;

  const signString =
    `${timestamp}\n` +
    `${method}\n` +
    `${signPath}\n\n` +
    bodyHash;

  console.log('[DEBUG signString]\n' + signString);

  const signature = crypto
    .createHmac('sha512', secretBuf)
    .update(Buffer.from(signString, 'utf8'))
    .digest('hex');

  return signature;
}

// ------------------------------------------------------------
// Main Handler
// ------------------------------------------------------------
module.exports = async (req, res) => {
  try {
    // Validate keys
    if (!API_KEY || !API_SECRET) {
      return res.status(500).json({
        error: 'API keys missing in environment variables.',
      });
    }

    // Debug Secret Info (safe — HEX only)
    const SECRET = String(API_SECRET || '').trim();
    console.log('SECRET LENGTH =', SECRET.length);
    console.log('SECRET HEX =', Buffer.from(SECRET, 'utf8').toString('hex'));

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
    }

    // Read raw body
    const rawBody = await getRawBody(req);

    let payload;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch (e) {
      return res.status(400).json({
        error: 'Invalid JSON payload',
        rawBody,
        details: e.message,
      });
    }

    // Extract required fields
    const { contract, side, size, leverage } = payload;
    if (!contract || !side || !size || !leverage) {
      return res.status(400).json({
        error: 'Missing required trade parameters: contract, side, size, leverage',
      });
    }

    const method = 'POST';
    const timestamp = Math.floor(Date.now() / 1000).toString();

    // Order payload (Gate.io standard)
    const orderData = {
      contract: String(contract),
      size:
        side === 'long'
          ? String(size)
          : String(-Math.abs(Number(size))),
      price: '0', // market order
      leverage: String(leverage),
    };

    const bodyString = JSON.stringify(orderData);
    console.log('[DEBUG bodyString]', bodyString);

    // Create signature
    const signature = createGateioSignature(
      method,
      API_PATH,
      bodyString,
      timestamp,
      API_SECRET
    );

    // Make Gate.io request
    const response = await fetch(API_HOST + API_PATH, {
      method,
      headers: {
        'Content-Type': 'application/json',
        key: String(API_KEY).trim(),
        sign: signature,
        timestamp,
      },
      body: bodyString,
    });

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      json = { raw: text };
    }

    console.log('[DEBUG Gate.io response]', json);

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        error: 'Gate.io API Error',
        details: json,
      });
    }

    return res.status(200).json({
      success: true,
      gateioResponse: json,
    });
  } catch (err) {
    console.error('[ERROR] Unexpected:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      details: err?.message,
    });
  }
};
