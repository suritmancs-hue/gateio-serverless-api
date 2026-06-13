// Import fetch
const fetch = require('node-fetch');

// --- Konstanta Umum ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Batas Konkurensi dan Jeda untuk menghindari Error 429
const CONCURRENCY_LIMIT = 10;
const DELAY_MS = 335;

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
    
    // Fibo Retracement dari rentang High-Low 100 candle
    const f05 = maxHigh - ((maxHigh - minLow) * 0.5);
    const f0618 = maxHigh - ((maxHigh - minLow) * 0.618);

    const rsi = calculateRSI(closes, 14);
    const lastChange = lastClose / lastOpen;

    // --- Perhitungan Volume Spike ---
    const periodVol = 10;
    const last10Volumes = volumes.slice(-periodVol);
    const sumVol10 = last10Volumes.reduce((acc, curr) => acc + curr, 0);
    const maVol10 = sumVol10 / periodVol;
    
    // Hindari Infinity jika MA Volume = 0
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
// ----------------------------------

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
                return { symbol: reqItem.symbol, type: reqItem.type, data: null, error: `HTTP Error: ${response.status} - ${response.statusText}`, extra: reqItem.extra };
            }
            return response.json().then(data => ({
                symbol: reqItem.symbol, type: reqItem.type, data: data, error: null, extra: reqItem.extra
            })).catch(e => ({
                symbol: reqItem.symbol, type: reqItem.type, data: null, error: `JSON Parse Error: ${e.message}`, extra: reqItem.extra
            }));
        })
        .catch(e => ({
            symbol: reqItem.symbol, type: reqItem.type, data: null, error: `Fetch Error: ${e.message}`, extra: reqItem.extra
        }));
        
        fetchPromises.push(promise);
        
        if (fetchPromises.length >= CONCURRENCY_LIMIT || i === requests.length - 1) {
            try {
                const batchResults = await Promise.all(fetchPromises);
                allResults = allResults.concat(batchResults);
            } catch (e) {
                console.error("Error selama Promise.all batch:", e);
            }
            
            fetchPromises = [];
            
            if (i < requests.length - 1) {
                await delay(DELAY_MS);
            }
        }
    }
    return allResults;
}

// =======================================================
// HANDLER UTAMA VERCEL
// =======================================================
export default async function handler(req, res) {
    
    // 1. Validasi Input dan Konfigurasi
    if (req.method !== 'POST' || !req.body) {
        return res.status(405).send('Hanya metode POST yang diterima dengan body JSON.');
    }
    
    const { symbols, config } = req.body;
    
    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
        return res.status(400).send('Daftar simbol tidak valid atau kosong.');
    }
    
    const { FUTURE_STATS_BASE_URL, FUTURE_CANDLE_BASE_URL, 
            CANDLESTICK_INTERVAL, CUSTOM_HEADERS } = config;
  
    const syncMap = new Map();
    symbols.forEach(symbol => {
        syncMap.set(symbol, { 
            statsCompleted: [], 
            timestampUTC: null,
            highsArray: [], 
            lowsArray: [],
            closesArray: [],
            opensArray: [],
            volumesArray: [] 
        });
    });

    // -----------------------------------------------------------
    // PHASE 1: FETCH DATA STATS
    // -----------------------------------------------------------
    
    const statsRequests = [];
    symbols.forEach(symbol => {
        statsRequests.push({ 
            url: `${FUTURE_STATS_BASE_URL}?contract=${symbol}&limit=${STATS_LIMIT}`, 
            type: 'stats', 
            symbol: symbol 
        });
    });

    const statsResults = await executeBatchFetch(statsRequests, CUSTOM_HEADERS);
    const candleRequests = [];

    statsResults.forEach(result => {
        const symbol = result.symbol;
        const syncData = syncMap.get(symbol);
        
        if (!result.data || result.error) {
            console.error(`Gagal memproses stats untuk ${symbol}: ${result.error}`);
            return;
        }

        // Eksklusi Data Live
        const completedStats = result.data.slice(0, result.data.length - 1); 
        
        if (completedStats.length < STATS_REQUIRED_COMPLETED) {
            return;
        }

        syncData.statsCompleted = completedStats;
        
        const latestStats = completedStats[completedStats.length - 1];
        const latestStatsTimestamp = latestStats.time; 
        
        const requiredLookbackSeconds = (CANDLE_REQUIRED_COMPLETED) * INTERVAL_SECONDS;
        const requiredStartTimestamp = latestStatsTimestamp - requiredLookbackSeconds; 
        
        candleRequests.push({ 
            url: `${FUTURE_CANDLE_BASE_URL}?contract=${symbol}&interval=${CANDLESTICK_INTERVAL}&from=${requiredStartTimestamp}&to=${latestStatsTimestamp}`, 
            type: 'candle', 
            symbol: symbol,
            extra: { latestStatsTimestamp: latestStatsTimestamp }
        });
    });
    
    // -----------------------------------------------------------
    // PHASE 2: FETCH DATA CANDLE 
    // -----------------------------------------------------------
    
    const candleResults = await executeBatchFetch(candleRequests, CUSTOM_HEADERS);

    // -----------------------------------------------------------
    // PHASE 3: SINKRONISASI DAN FINALISASI
    // -----------------------------------------------------------
    
    candleResults.forEach(result => {
        const symbol = result.symbol;
        const syncData = syncMap.get(symbol);
        
        if (!result.data || result.error) return;

        const candleData = result.data;
        if (candleData.length === 0) return;
        
        const statsCompleted = syncData.statsCompleted;
        if (statsCompleted.length === 0) return;
        
        const synchronizedData = []; 

        candleData.forEach(candle => {
            const foundStats = statsCompleted.find(s => s.time === candle.t); 
            
            if (foundStats) {
                // Menambahkan ekstraksi data volume (sum)
                synchronizedData.push({
                    time: candle.t,
                    open: Number(candle.o),
                    high: Number(candle.h),
                    low: Number(candle.l), 
                    close: Number(candle.c),
                    volume: Number(candle.sum) 
                });
            }
        });

        if (synchronizedData.length < CANDLE_REQUIRED_COMPLETED) {
            return;
        }
        
        const latestSynced = synchronizedData[synchronizedData.length - 1];

        syncData.timestampUTC = convertUnixTimestampToUTC(latestSynced.time); 

        // Ekstraksi 100 data terakhir termasuk Volume
        syncData.highsArray = synchronizedData.map(d => d.high).slice(-CANDLE_REQUIRED_COMPLETED);
        syncData.lowsArray = synchronizedData.map(d => d.low).slice(-CANDLE_REQUIRED_COMPLETED);
        syncData.closesArray = synchronizedData.map(d => d.close).slice(-CANDLE_REQUIRED_COMPLETED);
        syncData.opensArray = synchronizedData.map(d => d.open).slice(-CANDLE_REQUIRED_COMPLETED);
        syncData.volumesArray = synchronizedData.map(d => d.volume).slice(-CANDLE_REQUIRED_COMPLETED);
    });

    // -----------------------------------------------------------
    // PHASE 4: FINALISASI PERHITUNGAN DAN KIRIM RESPON
    // -----------------------------------------------------------
    
    const finalResultArray = symbols.map(symbol => {
        const syncData = syncMap.get(symbol);
        
        const opens = syncData.opensArray;
        const highs = syncData.highsArray;
        const lows = syncData.lowsArray;
        const closes = syncData.closesArray;
        const volumes = syncData.volumesArray;
        
        let calculatedData = {
            lastClose: null, volumespike: null, rangeClose: null, f05: null, f0618: null, rsi: null, lastChange: null
        };

        // Pastikan array volume juga memenuhi syarat panjangnya sebelum kalkulasi
        if (closes.length === CANDLE_REQUIRED_COMPLETED && volumes.length === CANDLE_REQUIRED_COMPLETED) {
            calculatedData = calculateMetrics(highs, lows, closes, opens, volumes);
        }

        return {
            symbol: symbol,
            timestamp: syncData.timestampUTC || 'Data Kurang',
            ...calculatedData
        }; 
    });

    // Kirim Respons 
    res.status(200).json({ 
        status: 'Success', 
        message: 'Data berhasil diambil, disinkronisasi, dan dikalkulasi dengan Volume Spike.',
        data: finalResultArray 
    });
};
