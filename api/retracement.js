// Import fetch
const fetch = require('node-fetch');

// --- Konstanta Umum ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Batas Konkurensi dan Jeda untuk menghindari Error 429
const CONCURRENCY_LIMIT = 10;
const DELAY_MS = 335;

// --- Konfigurasi Endpoint Gate.io ---
const GATEIO_STATS_URL = 'https://api.gateio.ws/api/v4/futures/usdt/contract_stats';
const GATEIO_CANDLE_URL = 'https://api.gateio.ws/api/v4/futures/usdt/candlesticks';
const CANDLE_INTERVAL = '4h';

// --- Konfigurasi Konstanta Perhitungan ---
const CANDLE_REQUIRED_COMPLETED = 100;
const STATS_REQUIRED_COMPLETED = 100; 
const STATS_LIMIT = STATS_REQUIRED_COMPLETED + 145; // Buffer ekstra

// Asumsi interval '4h' = 14400 detik (untuk perhitungan waktu mundur)
const INTERVAL_SECONDS = 14400;
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
    const lastVolume = volumes[volumes.length - 1];

    const maxClose = Math.max(...closes);
    const minClose = Math.min(...closes);
    const rangeClose = maxClose / minClose; 

    const maxHigh = Math.max(...highs);
    const minLow = Math.min(...lows);
    
    // Fibonacci Retracement (Uptrend)
    const uptrendRange = maxHigh - minLow;
    const f05 = maxHigh - (uptrendRange * 0.5);
    const f0618 = maxHigh - (uptrendRange * 0.618);

    const rsi = calculateRSI(closes, 14);
    const lastChange = lastClose / lastOpen;

    // --- Perhitungan Volume Spike ---
    const periodVol = 10;
    const last10Volumes = volumes.slice((-1-periodVol), -1);
    const sumVol10 = last10Volumes.reduce((acc, curr) => acc + curr, 0);
    const maVol10 = sumVol10 / periodVol;
    
    const volumeSpike = maVol10 > 0 ? (lastVolume / maVol10) : 0;

    return {
        lastClose: Number(lastClose.toFixed(4)),
        volumespike: Number(volumeSpike.toFixed(2)),
        rangeClose: Number(rangeClose.toFixed(4)),
        f05: Number(f05.toFixed(4)),
        f0618: Number(f0618.toFixed(4)),
        rsi: rsi !== null ? Number(rsi.toFixed(2)) : null,
        lastChange: Number(lastChange.toFixed(4))
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
    
    const { symbols, config } = req.body;
    console.log(`Menerima request untuk ${symbols.length} simbol.`);
    
    const CUSTOM_HEADERS = config.CUSTOM_HEADERS || {};
    const syncMap = new Map();
    symbols.forEach(symbol => syncMap.set(symbol, { statsCompleted: [], highsArray: [], lowsArray: [], closesArray: [], opensArray: [], volumesArray: [] }));

    const statsRequests = symbols.map(symbol => ({ 
        url: `${GATEIO_STATS_URL}?contract=${symbol}&limit=${STATS_LIMIT}`, 
        type: 'stats', symbol: symbol 
    }));

    const statsResults = await executeBatchFetch(statsRequests, CUSTOM_HEADERS);
    const candleRequests = [];

    statsResults.forEach(result => {
        if (!result.data || result.error) {
            console.log(`Error Stats untuk ${result.symbol}: ${result.error || 'Data kosong'}`);
            return;
        }
        const completedStats = result.data.slice(0, result.data.length - 1); 
        if (completedStats.length < STATS_REQUIRED_COMPLETED) {
            console.log(`Stats kurang untuk ${result.symbol}: Hanya dapat ${completedStats.length} data.`);
            return;
        }

        const syncData = syncMap.get(result.symbol);
        syncData.statsCompleted = completedStats;
        const latestStatsTimestamp = completedStats[completedStats.length - 1].time;
        const start = latestStatsTimestamp - (CANDLE_REQUIRED_COMPLETED * INTERVAL_SECONDS);
        
        candleRequests.push({ 
            url: `${GATEIO_CANDLE_URL}?contract=${result.symbol}&interval=${CANDLE_INTERVAL}&from=${start}&to=${latestStatsTimestamp}`, 
            type: 'candle', symbol: result.symbol 
        });
    });
    
    console.log(`Memulai fetch ${candleRequests.length} candle request.`);
    const candleResults = await executeBatchFetch(candleRequests, CUSTOM_HEADERS);

    candleResults.forEach(result => {
        if (!result.data || result.error) {
            console.log(`Error Candle untuk ${result.symbol}: ${result.error || 'Data kosong'}`);
            return;
        }
        const syncData = syncMap.get(result.symbol);
        
        // --- LOG PENTING UNTUK DEBUG ---
        const synchronizedData = result.data.filter(c => syncData.statsCompleted.find(s => s.time === c.t));
        console.log(`Sinkronisasi ${result.symbol}: Diterima ${result.data.length} candle, setelah sinkron tersisa ${synchronizedData.length}.`);

        if (synchronizedData.length < CANDLE_REQUIRED_COMPLETED) {
            console.log(`Data tidak cukup setelah sinkronisasi untuk ${result.symbol}: ${synchronizedData.length} < ${CANDLE_REQUIRED_COMPLETED}`);
            return;
        }
        
        syncData.timestampUTC = convertUnixTimestampToUTC(synchronizedData[synchronizedData.length - 1].t);
        syncData.highsArray = synchronizedData.map(d => Number(d.h)).slice(-CANDLE_REQUIRED_COMPLETED);
        syncData.lowsArray = synchronizedData.map(d => Number(d.l)).slice(-CANDLE_REQUIRED_COMPLETED);
        syncData.closesArray = synchronizedData.map(d => Number(d.c)).slice(-CANDLE_REQUIRED_COMPLETED);
        syncData.opensArray = synchronizedData.map(d => Number(d.o)).slice(-CANDLE_REQUIRED_COMPLETED);
        syncData.volumesArray = synchronizedData.map(d => Number(d.sum)).slice(-CANDLE_REQUIRED_COMPLETED);
    });

    const finalResultArray = symbols.map(symbol => {
        const syncData = syncMap.get(symbol);
        let calc = { lastClose: null, volumespike: null, rangeClose: null, f05: null, f0618: null, rsi: null, lastChange: null };
        
        if (syncData.closesArray.length === CANDLE_REQUIRED_COMPLETED) {
            calc = calculateMetrics(syncData.highsArray, syncData.lowsArray, syncData.closesArray, syncData.opensArray, syncData.volumesArray);
        } else {
            console.log(`Hasil Perhitungan untuk ${symbol}: Data Kurang (Jumlah closesArray: ${syncData.closesArray.length})`);
        }
        
        return { symbol, timestamp: syncData.timestampUTC || 'Data Kurang', ...calc }; 
    });

    res.status(200).json({ status: 'Success', data: finalResultArray });
}
