// gateio-vercel-autotrade.js
// Vercel Serverless Function for Gate.io futures orders
// Ready to copy-paste & deploy

const crypto = require('crypto');
const fetch = require('node-fetch'); // Ganti dengan 'undici' jika Node 18+

// Env vars
const API_KEY = process.env.GATEIO_KEY;
const API_SECRET = process.env.GATEIO_SECRET;

const API_HOST = 'https://api.gateio.ws';
const API_PATH = '/api/v4/futures/usdt/orders';

// Helper: baca raw body dengan robust (req.rawBody, req.body string/object, atau stream)
async function getRawBody(req) {
  // Vercel sometimes provides req.rawBody
  if (req.rawBody) {
    return typeof req.rawBody === 'string' ? req.rawBody : req.rawBody.toString('utf8');
  }

  // If body is already parsed object (Express-like), produce JSON string
  if (req.body && typeof req.body === 'object') {
    try {
      return JSON.stringify(req.body);
    } catch (e) {
      // fallback to stream reading
    }
  }

  // If body is string
  if (typeof req.body === 'string') {
    return req.body;
  }

  // Fallback: read stream
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => reject(err));
  });
}

// Create signature (HMAC SHA512) — using Buffer everywhere for deterministic encoding
function createGateioSignature(method, path, bodyString, timestamp, secret) {
  const cleanedSecret = String(secret || '').trim();
  const secretBuf = Buffer.from(cleanedSecret, 'utf8');

  // Body hash SHA512 (hex)
  const bodyHash = crypto
    .createHash('sha512')
    .update(Buffer.from(bodyString, 'utf8'))
    .digest('hex');

  console.log('[DEBUG bodyHash length]', bodyHash.length);

  // Gate.io expects requestPath with trailing ? even if querystring is empty
  const signPath = `${path}?`;

  // Build sign string exactly:
  // timestamp\nMETHOD\nrequestPath?\n\nsha512(body)
  const signString = `${timestamp}\n${method}\n${signPath}\n\n${bodyHash}`;

  console.log('[DEBUG signString]\n' + signString);

  const signature = crypto
    .createHmac('sha512', secretBuf)
    .update(Buffer.from(signString, 'utf8'))
    .digest('hex');

  return signature;
}

module.exports = async (req, res) => {
  try {
    // Basic checks for API keys
    if (!API_KEY || !API_SECRET) {
      return res.status(500).json({ error: 'API keys missing in environment variables.' });
    }

    // Debug: secret length & hex (do NOT print the secret itself)
    try {
      const SECRET = String(API_SECRET || '');
      console.log('SECRET LENGTH =', SECRET.length);
      console.log('SECRET HEX =', Buffer.from(SECRET, 'utf8').toString('hex'));
    } catch (e) {
      console.log('[WARN] Failed to log secret debug info:', e && e.message);
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
    }

    // Read raw body robustly
    const rawBody = await getRawBody(req);
    let payload;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch (e) {
      // If parse fails, return error — we expect JSON payload
      return res.status(400).json({ error: 'Invalid JSON payload', details: e.message, rawBody });
    }

    // Extract fields
    const { contract, side, size, leverage } = payload;

    if (!contract || !side || !size || !leverage) {
      return res.status(400).json({ error: 'Missing required trade parameters: contract, side, size, leverage' });
    }

    const method = 'POST';
    const timestamp = Math.floor(Date.now() / 1000).toString();

    // Prepare orderData exactly as Gate.io expects
    const orderData = {
      contract: String(contract),
      size: side === 'long' ? String(size) : String(-Math.abs(Number(size))),
      price: '0', // market order
      leverage: String(leverage)
    };

    const bodyString = JSON.stringify(orderData);

    console.log('[DEBUG bodyString] ' + bodyString);

    // Generate signature
    const signature = createGateioSignature(method, API_PATH, bodyString, timestamp, API_SECRET);

    // Send request to Gate.io
    const resp = await fetch(API_HOST + API_PATH, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'key': String(API_KEY).trim(),
        'sign': signature,
        'timestamp': timestamp
      },
      body: bodyString
    });

    const rawResp = await resp.text();
    let parsedResp;
    try {
      parsedResp = JSON.parse(rawResp);
    } catch (e) {
      parsedResp = { raw: rawResp };
    }

    console.log('[DEBUG Gate.io response]', parsedResp);

    if (!resp.ok) {
      return res.status(502).json({ success: false, error: 'Gate.io API Error', details: parsedResp });
    }

    return res.status(200).json({ success: true, gateioResponse: parsedResp });
  } catch (err) {
    console.error('[ERROR] Unexpected:', err);
    return res.status(500).json({ success: false, error: 'Internal Server Error', details: err && err.message });
  }
};
