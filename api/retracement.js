// Import fetch
const fetch = require('node-fetch');

// --- Konstanta Umum ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Batas Konkurensi dan Jeda untuk menghindari Error 429
const CONCURRENCY_LIMIT = 10;
const DELAY_MS = 335;

// --- Konfigurasi Endpoint Gate.io ---
const GATEIO_CANDLE_URL = 'https://api.gateio.ws/api/v4/spot/candlesticks';
const CANDLE_INTERVAL = '1h';
const CANDLE_REQUIRED_COMPLETED = 70;

// ------------------------------------------

// --- Fungsi Konversi Timestamp ke UTC ---
function convertUnixTimestampToUTC(unixTimestampSeconds) {
    if (typeof unixTimestampSeconds !== 'number' || unixTimestampSeconds <= 0) {
        return '';
    }
    const unixTimestampMilliseconds = unixTimestampSeconds * 1000;
    const dateObject = new Date(unixTimestampMilliseconds);
    return dateObject.toUTCString();
}
// ----------------------------------------

// --- Fungsi Perhitungan Teknikal ---

/**
 * Menghitung Relative Strength Index (RSI) - Standar J. Welles Wilder
 */
function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;

    let gains = 0, losses = 0;

    for (let i = 1; i <= period; i++) {
        let diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i++) {
        let diff = closes[i] - closes[i - 1];
        let gain = diff >= 0 ? diff : 0;
        let loss = diff < 0 ? -diff : 0;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) return 100; 
    let rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

/**
 * Menghitung Metrik yang Direquest
 */
function calculateMetrics(highs, lows, closes, opens, volumes) {
    const lastClose = closes[closes.length - 1];
    const lastOpen = opens[opens.length - 1];
    
    // 1. Hitung lastChange
    const lastChange = lastClose / lastOpen;

    // 2. Filter: Jika turun (lastChange < 1), kembalikan 0
    if (lastChange < 1) {
        return {
            lastClose: Number(lastClose.toFixed(5)),
            volumespike: 0,
            rangeClose: 0,
            f05: 0,
            f0618: 0,
            rsi: 0,
            lastChange: Number(lastChange.toFixed(3))
        };
    }

    // 3. Cari titik Min terlebih dahulu
    let minLow = Infinity;
    let minIndex = -1;

    for (let i = 0; i < lows.length; i++) {
        if (lows[i] < minLow) {
            minLow = lows[i];
            minIndex = i;
        }
    }

    // 4. Cari titik Max SETELAH titik Min (minIndex)
    let maxHigh = -Infinity;
    
    for (let i = minIndex; i < highs.length; i++) {
        if (highs[i] > maxHigh) {
            maxHigh = highs[i];
        }
    }

    // 5. FILTER TAMBAHAN: Jika tidak ada Max setelah Min (atau max <= min)
    // Ini mengembalikan 0 untuk indikator teknikal
    if (maxHigh <= minLow) {
        return {
            lastClose: Number(lastClose.toFixed(5)),
            volumespike: 0,
            rangeClose: 0,
            f05: 0,
            f0618: 0,
            rsi: 0,
            lastChange: Number(lastChange.toFixed(3))
        };
    }

    // --- Lanjut jika Uptrend Valid ---
    const uptrendRange = maxHigh - minLow;
    const f05 = maxHigh - (uptrendRange * 0.5);
    const f0618 = maxHigh - (uptrendRange * 0.618);

    const rsi = calculateRSI(closes, 14);

    const lastVolume = volumes[volumes.length - 1];
    const periodVol = 10;
    const last10Volumes = volumes.slice((-1 - periodVol), -1);
    const sumVol10 = last10Volumes.reduce((acc, curr) => acc + curr, 0);
    const maVol10 = sumVol10 / periodVol;
    
    const volumeSpike = maVol10 > 0 ? (lastVolume / maVol10) : 0;

    return {
        lastClose: Number(lastClose.toFixed(5)),
        volumespike: Number(volumeSpike.toFixed(2)),
        rangeClose: Number((Math.max(...closes) / Math.min(...closes)).toFixed(3)), 
        f05: Number(f05.toFixed(5)),
        f0618: Number(f0618.toFixed(5)),
        rsi: rsi !== null ? Number(rsi.toFixed(2)) : 0,
        lastChange: Number(lastChange.toFixed(3))
    };
}

/**
 * Fungsi pembantu untuk menjalankan batch request dengan rate limiting.
 */
async function executeBatchFetch(requests, customHeaders) {
    let allResults = [];
    let fetchPromises = [];

    for (let i = 0; i < requests.length; i++) {
        const reqItem = requests[i];
        
        const promise = fetch(reqItem.url, {
            method: 'GET',
            headers: customHeaders
        })
        .then(response => {
            if (!response.ok) {
                return { symbol: reqItem.symbol, type: reqItem.type, data: null, error: `HTTP Error: ${response.status}`, extra: reqItem.extra };
            }
            return response.json().then(data => ({
                symbol: reqItem.symbol, type: reqItem.type, data: data, error: null, extra: reqItem.extra
            })).catch(e => ({
                symbol: reqItem.symbol, type: reqItem.type, data: null, error: `JSON Parse Error`, extra: reqItem.extra
            }));
        })
        .catch(e => ({
            symbol: reqItem.symbol, type: reqItem.type, data: null, error: `Fetch Error`, extra: reqItem.extra
        }));
        
        fetchPromises.push(promise);
        
        if (fetchPromises.length >= CONCURRENCY_LIMIT || i === requests.length - 1) {
            try {
                const batchResults = await Promise.all(fetchPromises);
                allResults = allResults.concat(batchResults);
            } catch (e) { console.error(e); }
            fetchPromises = [];
            if (i < requests.length - 1) await delay(DELAY_MS);
        }
    }
    return allResults;
}

// ... (Bagian atas kode tetap sama)

// =======================================================
// HANDLER UTAMA VERCEL
// =======================================================
export default async function handler(req, res) {
    if (req.method !== 'POST' || !req.body) {
        return res.status(405).send('Metode tidak diizinkan.');
    }
    
    const { symbols } = req.body;
    
    // Siapkan request khusus untuk Spot Candlesticks
    // limit 100 akan mengambil 100 data candle terbaru
    const candleRequests = symbols.map(symbol => ({ 
        url: `${GATEIO_CANDLE_URL}?currency_pair=${symbol}&interval=${CANDLE_INTERVAL}&limit=${CANDLE_REQUIRED_COMPLETED}`, 
        type: 'candle', 
        symbol: symbol 
    }));

    const candleResults = await executeBatchFetch(candleRequests, {});

    const finalResultArray = candleResults.map(result => {
        if (!result.data || result.data.length < CANDLE_REQUIRED_COMPLETED) {
            return { 
                symbol: result.symbol, 
                timestamp: "Data Kurang",
                lastClose: 0, volumespike: 0, rangeClose: 0, f05: 0, f0618: 0, rsi: 0, lastChange: 0 
                };
        }

        // Mapping Array berdasarkan dokumentasi Gate.io Spot:
        // [0:t, 1:v_quote, 2:c, 3:h, 4:l, 5:o, 6:sum_base, 7:window_closed]
        const data = result.data;
        const closes = data.map(d => Number(d[2]));
        const highs = data.map(d => Number(d[3]));
        const lows = data.map(d => Number(d[4]));
        const opens = data.map(d => Number(d[5]));
        const volumes = data.map(d => Number(d[6]));

        const calc = calculateMetrics(highs, lows, closes, opens, volumes);

        const timestamp = convertUnixTimestampToUTC(data[data.length - 1][0]);
        // Jika hasil timestamp adalah string kosong, kita paksa logging untuk debug
        if (timestamp === "") {
            console.log(`Debug: Timestamp gagal dikonversi untuk simbol ${result.symbol}. Raw value:`, rawTimestamp);
        }

        return { symbol: result.symbol, timestamp: timestamp, ...calc };
    });

    res.status(200).json({ status: 'Success', data: finalResultArray });
}
