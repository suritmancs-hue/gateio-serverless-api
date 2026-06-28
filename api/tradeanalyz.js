// Import fetch
const fetch = require('node-fetch');

// --- Konstanta Umum ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Batas Konkurensi dan Jeda untuk menghindari Error 429
const CONCURRENCY_LIMIT = 10;
const DELAY_MS = 335;

// --- Konfigurasi Endpoint Gate.io ---
const GATEIO_CANDLE_URL = 'https://api.gateio.ws/api/v4/spot/candlesticks';
const GATEIO_TRADE_URL = 'https://api.gateio.ws/api/v4/spot/trades';
const CANDLE_REQUIRED_COMPLETED = 20;

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
 * Menghitung analisis candle
 */
function calculateCandle(highs, lows, closes, opens, volumes) {
    const lastOpen = opens[opens.length - 1];
    const lastHigh = highs[highs.length - 1];
    const lastLow = lows[lows.length - 1];
    const lastClose = closes[closes.length - 1];
    const lastVolume = volumes[volumes.length - 1];
    
    // 1. Hitung lastChange
    const lastChange = lastClose / lastOpen;

    // 2. Filter lastChange
    if (lastChange < 0.98 || lastChange > 1.03 || lastVolume < 5000) {
        return {
            lastOpen: Number(lastOpen.toFixed(5)),
            lastHigh: Number(lastHigh.toFixed(5)),
            lastLow: Number(lastLow.toFixed(5)),
            lastClose: Number(lastClose.toFixed(5)),
            lastVolume: Number(lastVolume.toFixed(5)),
            lastChange: Number(lastChange.toFixed(3)),
            volumeSpike: 0,
            rsi: 0
        };
    }

    const period = 10;
    const last10Volumes = volumes.slice((-1 - period), -1);
    const sumVol10 = last10Volumes.reduce((acc, curr) => acc + curr, 0);
    const maVol10 = sumVol10 / period;
    
    const volumeSpike = maVol10 > 0 ? (lastVolume / maVol10) : 0;

    const rsi = calculateRSI(closes, 14);

    return {
        lastOpen: Number(lastOpen.toFixed(5)),
        lastHigh: Number(lastHigh.toFixed(5)),
        lastLow: Number(lastLow.toFixed(5)),
        lastClose: Number(lastClose.toFixed(5)),
        lastVolume: Number(lastVolume.toFixed(5)),
        lastChange: Number(lastChange.toFixed(3)),
        volumeSpike: Number(volumeSpike.toFixed(2)),
        rsi: Number(rsi.toFixed(2)),
    };
}

/**
 * Menghitung analisis trade
 */
function calculateTrade(dataTrade) {
    const period = 10;
    // 1. Filter
    const lastTradeCount = dataTrade.tradeCount[dataTrade.length - 1];
    const lastVolTrade = dataTrade.volTrade[dataTrade.length - 1];
    const lastBuy = dataTrade.buy[dataTrade.length - 1];
    const lastSell = dataTrade.sell[dataTrade.length - 1];
    const lastNettFlow = dataTrade.nettFlow[dataTrade.length - 1];

    const TradeSum = lastBuy + lastSell;
    const nettRasio = lastBuy / lastSell;

    const last10VolTrade = dataTrade.volTrade.slice((-1 - period), -1);
    const maVolTrade = last10VolTrade.reduce((acc, curr) => acc + curr, 0) / period;
    const volTradeSpike = maVolTrade > 0 ? (lastVolTrade / maVolTrade) : 0;

    const last10Buy = dataTrade.buy.slice((-1 - period), -1);
    const maBuy = last10Buy.reduce((acc, curr) => acc + curr, 0) / period;
    const buySpike = maBuy > 0 ? (lastBuy / maBuy) : 0;

    const last10NettFlow = dataTrade.buy.slice((-1 - period), -1);
    const maNettFlow = last10NettFlow.reduce((acc, curr) => acc + curr, 0) / period;
    const netFlowSpike = maNettFlow > 0 ? (lastNettFlow / maNettFlow) : 0;

    if (lastTradeCount < 100 || nettFlow < 0 || volTradeSpike < 1 || buySpike < 1 || netFlowSpike < 1 || nettRasio < 1.5) {
        return {
            tradeCount: 0,
            volTrade: 0,
            buy: 0,
            sell: 0,
            nettFlow: 0,
            nettRasio: 0
        } 
    } else {
        return {
            tradeCount: Number(lastTradeCount.toFixed(0)),
            volTrade: Number(lastVolTrade.toFixed(0)),
            buy: Number(lastBuy.toFixed(0)),
            sell: Number(lastSell.toFixed(0)),
            nettFlow: Number(lastNettFlow.toFixed(0)),
            nettRasio: Number(nettRasio.toFixed(3))
        };
    }
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


// =======================================================
// HANDLER UTAMA VERCEL
// =======================================================
export default async function handler(req, res) {
    if (req.method !== 'POST' || !req.body) {
        return res.status(405).send('Metode tidak diizinkan.');
    }
    
    const { symbols, interval } = req.body;
    if (!symbols || !Array.isArray(symbols)) {
        return res.status(400).json({ status: 'Error', message: 'Payload "symbols" wajib berupa array.' });
    }
    
    // 1. Setup Request untuk Spot Candlesticks
    const candleRequests = symbols.map(symbol => ({ 
        url: `${GATEIO_CANDLE_URL}?currency_pair=${symbol}&interval=${interval}&limit=${CANDLE_REQUIRED_COMPLETED}`, 
        type: 'candle', 
        symbol: symbol 
    }));

    // 2. Setup Request untuk Spot Trades (Maksimal 1000 data terakhir per request)
    const tradeRequests = symbols.map(symbol => ({ 
        url: `${GATEIO_TRADE_URL}?currency_pair=${symbol}&limit=1000`, 
        type: 'trade', 
        symbol: symbol 
    }));

    // 3. Eksekusi Request Candle
    const candleResults = await executeBatchFetch(candleRequests, {});
    const tradeResults = await executeBatchFetch(tradeRequests, {});

    // 4. Map Trade Data agar mudah dicari saat memproses Candle
    const tradeDataMap = {};
    tradeResults.forEach(res => {
        tradeDataMap[res.symbol] = res.data || [];
    });

    // 5. Kalkulasi dan Penggabungan Format Akhir (18 Kolom Data)
    const finalResultArray = candleResults.map(result => {
        if (!result.data || result.data.length < CANDLE_REQUIRED_COMPLETED) {
            // Mapping fallback (Data Kosong) 18 item
            return { 
                symbol: result.symbol, 
                timestamp: "Data Kurang", 
                price: 0, open: 0, high: 0, low: 0, close: 0, volume: 0, 
                lastChg: 0, volSpike: 0, RSI: 0, 
                tradeCount: 0, volTrade: 0, buy: 0, sell: 0, totalTrade: 0, nettFlow: 0, nettRasio: 0 
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

        // Eksekusi fungsi kalkulasi Candle
        const calcCandle = calculateCandle(highs, lows, closes, opens, volumes);
        const lastCandle = data[data.length - 1];
        const rawTimestamp = lastCandle ? Number(lastCandle) : 0;

        // ----------------------------------------------------
        // PROSES STRUKTUR dataTrade (BAGIAN REKONSILIASI DATA)
        // ----------------------------------------------------
        const rawTrades = tradeDataMap[result.symbol] || [];
        
        // Buat cetakan kontainer dataTrade bertipe deret waktu (Time-Series Map)
        const structuredDataTrade = {
            timestamp: [], tradeCount: [], buy: [], sell: [], totalTrade: [], volTrade: [], nettFlow: [], nettRasio: []
        };

        // Kelompokkan data transaksi mentah menjadi blok berbasis jam unik (floor per jam)
        const hourlyGroups = {};
        rawTrades.forEach(trade => {
            const ms = parseFloat(trade.create_time_ms);
            const dateObj = new Date(ms);
            // Pembulatan menit ke 00 untuk mendapatkan kunci jam unik
            dateObj.setMinutes(0, 0, 0);
            const hourKey = dateObj.toISOString();

            if (!hourlyGroups[hourKey]) {
                hourlyGroups[hourKey] = { count: 0, buy: 0, sell: 0 };
            }

            const amount = Number(trade.amount);
            if (trade.side === 'buy') hourlyGroups[hourKey].buy += amount;
            if (trade.side === 'sell') hourlyGroups[hourKey].sell += amount;
            hourlyGroups[hourKey].count++;
        });

        // Urutkan kunci jam dari yang terlama ke terbaru sebelum dimasukkan ke array dataTrade
        const sortedHours = Object.keys(hourlyGroups).sort((a, b) => new Date(a) - new Date(b));

        sortedHours.forEach(hour => {
            const group = hourlyGroups[hour];
            const total = group.buy + group.sell;

            structuredDataTrade.timestamp.push(hour);
            structuredDataTrade.tradeCount.push(group.count);
            structuredDataTrade.buy.push(group.buy);
            structuredDataTrade.sell.push(group.sell);
            structuredDataTrade.totalTrade.push(total);
            structuredDataTrade.volTrade.push(group.count > 0 ? total / group.count : 0);
            structuredDataTrade.nettFlow.push(group.buy - group.sell);
            structuredDataTrade.nettRasio.push(group.sell > 0 ? group.buy / group.sell : group.buy);
        });

        // Jalankan kalkulasi forensik trade berdasarkan struktur dataTrade yang telah diisi
        const calcTrade = calculateTrade(structuredDataTrade);

        // Final Return (18 Format Exact Mapping)
        return { 
            Symbol: result.symbol,
            Timestamp: convertUnixTimestampToUTC(rawTimestamp),
            Price: calcCandle.lastClose,
            Open: calcCandle.lastOpen,
            High: calcCandle.lastHigh,
            Low: calcCandle.lastLow,
            Close: calcCandle.lastClose,
            Volume: calcCandle.lastVolume,
            lastChg: calcCandle.lastChange,
            volSpike: calcCandle.volumeSpike,
            rsi: calcCandle.rsi,
            tradeCount: calcTrade.tradeCount,
            volTrade: calcTrade.volTrade,
            buy: calcTrade.buy,
            sell: calcTrade.sell,
            totalTrade: calcTrade.totalTrade,
            nettFlow: calcTrade.nettFlow,
            nettRasio: calcTrade.nettRasio
        };
    });

    res.status(200).json({ status: 'Success', data: finalResultArray });
}
