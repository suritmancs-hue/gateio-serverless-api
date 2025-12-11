// gateio-vercel-autotrade.js
// Vercel Serverless Function for Gate.io futures orders

const crypto = require('crypto');
const fetch = require('node-fetch');

// Env vars
const API_KEY = process.env.GATEIO_KEY;
const API_SECRET = process.env.GATEIO_SECRET;

const API_HOST = 'https://api.gateio.ws';
const API_PATH = '/api/v4/futures/usdt/orders';

// ------------------------------------------------------------
// Helper: Read raw body robustly
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

  if (typeof req.body === 'string') {
    return req.body;
  }

  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', err => reject(err));
  });
}

// ------------------------------------------------------------
// Gate.io Signature Creator
// ------------------------------------------------------------
function createGateioSignature(method, path, bodyString, timestamp, secret) {
  const cleanedSecret = String(secret || '').trim();
  const secretBuf = Buffer.from(cleanedSecret, 'utf8');

  // Body hash
  const bodyHash = crypto
    .createHash('sha512')
    .update(Buffer.from(bodyString, 'utf8'))
    .digest('hex');

  console.log('[DEBUG bodyHash length]', bodyHash.length);

  const signPath = `${path}?`;

  const signString =
    `${timestamp}\n${method}\n${signPath}\n\n${bodyHash}`;

  console.log('[DEBUG signString]\n' + signString);

  const signature = crypto
    .createHmac('sha512', secretBuf)
    .update(Buffer.from(signString, 'utf8'))
    .digest('hex');

  return signature;
}

// ------------------------------------------------------------
// Vercel Handler
// ------------------------------------------------------------
module.exports = async (req, res) => {
  try {
    if (!API_KEY || !API_SECRET) {
      return res.status(500).json({ error: 'API keys missing.' });
    }

    // Debug secret
    try {
      const SECRET = String(API_SECRET || '');
      console.log('SECRET LENGTH =', SECRET.length);
      console.log('SECRET HEX =', Buffer.from(SECRET, 'utf8').toString('hex'));
    } catch (e) {
      console.log('[WARN] Failed to log secret:', e.message);
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
    }

    // RAW BODY
    const rawBody = await getRawBody(req);
    let payload;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch (e) {
      return res.status(400).json({
        error: 'Invalid JSON payload',
        details: e.message,
        rawBody
      });
    }

    const { contract, side, size, leverage } = payload;

    if (!contract || !side || !size || !leverage) {
      return res.status(400).json({
        error: 'Missing required parameters: contract, side, size, leverage'
      });
    }

    const method = 'POST';
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const orderData = {
      contract: String(contract),
      size: side === 'long'
        ? String(size)
        : String(-Math.abs(Number(size))),
      price: '0',
      leverage: String(leverage)
    };

    const bodyString = JSON.stringify(orderData);
    console.log('[DEBUG bodyString]', bodyString);

    const signature = createGateioSignature(
      method,
      API_PATH,
      bodyString,
      timestamp,
      API_SECRET
    );

    // ------------------------------------------------------------
    // Request to Gate.io (headers FIXED)
    // ------------------------------------------------------------
    const resp = await fetch(API_HOST + API_PATH, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'KEY': String(API_KEY).trim(),
        'Timestamp': timestamp,
        'SIGN': signature
      },
      body: bodyString
    });

    const rawResp = await resp.text();
    let parsedResp;

    try {
      parsedResp = JSON.parse(rawResp);
    } catch (_) {
      parsedResp = { raw: rawResp };
    }

    console.log('[DEBUG Gate.io response]', parsedResp);

    if (!resp.ok) {
      return res.status(502).json({
        success: false,
        error: 'Gate.io API Error',
        details: parsedResp
      });
    }

    return res.status(200).json({
      success: true,
      gateioResponse: parsedResp
    });

  } catch (err) {
    console.error('[ERROR] Unexpected:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      details: err.message
    });
  }
};
