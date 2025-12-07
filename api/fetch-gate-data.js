/**
 * Vercel Serverless Function / API Route.
 * * Strategi: Sequential Phased Fetching (Ambil Stats dulu, lalu ambil Candle dengan Timestamp yang sudah disinkronkan).
 * * Perbaikan: Menggunakan STATS_LIMIT=50 untuk toleransi data Stats yang sangat sparse dan mengkonversi Timestamp ke UTC.
 * * CATATAN: Pastikan 'node-fetch' terinstal di package.json.
 */

// Import fetch (gunakan versi yang sama dengan GCF Anda)
const fetch = require('node-fetch');

// --- Konstanta Umum ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Batas Konkurensi dan Jeda untuk menghindari Error 429
const CONCURRENCY_LIMIT = 10; 
const DELAY_MS = 350; 

// --- Konfigurasi Konstanta Perhitungan ---
const STATS_REQUIRED_COMPLETED = 50;
const STATS_LIMIT = STATS_REQUIRED_COMPLETED + 145;

// Batas minimum yang dibutuhkan untuk denominator Volume yang sukses.
const CANDLE_REQUIRED_COMPLETED = 50; 

// Kita asumsikan interval '5m' = 300 detik (untuk perhitungan waktu mundur)
const INTERVAL_SECONDS = 300; 
// ------------------------------------------

// --- Fungsi Konversi Timestamp ke UTC ---
/**
 * Mengkonversi Unix Timestamp (dalam detik) menjadi string waktu UTC yang dapat dibaca.
 * @param {number} unixTimestampSeconds - Unix Timestamp dalam detik (10 digit).
 * @returns {string} Waktu dalam format UTC.
 */
function convertUnixTimestampToUTC(unixTimestampSeconds) {
    if (typeof unixTimestampSeconds !== 'number' || unixTimestampSeconds <= 0) {
        return '';
    }
    
    // Konversi ke milidetik (13 digit)
    const unixTimestampMilliseconds = unixTimestampSeconds * 1000;
    
    const dateObject = new Date(unixTimestampMilliseconds);
    
    // Menggunakan toUTCString() untuk mendapatkan representasi waktu dalam UTC
    return dateObject.toUTCString();
}
// ----------------------------------------

/**
 * Fungsi ini menghitung status "✅" atau "❌" dengan tambahan filter ATRP (Pre-Breakout).
 * [Fungsi ini tidak diubah dari kode GCF asli Anda]
 * * @param {Array<number>} lsrTakers - Array LSR Taker.
 * @param {Array<number>} volumes - Array Volume.
 * @param {Array<number>} openInterests - Array Open Interest.
 * @param {Array<number>} highs - Array Harga Tertinggi (High).
 * @param {Array<number>} lows - Array Harga Terendah (Low).
 * @param {Array<number>} closes - Array Harga Penutupan (Close).
 * @returns {string} Status "✅" atau "❌".
 */
function calculateColumnEStatus(lsrTakers, volumes, openInterests, highs, lows, closes, opens) {
    // Pastikan panjang minimum terpenuhi
    if (lsrTakers.length < STATS_REQUIRED_COMPLETED || volumes.length < CANDLE_REQUIRED_COMPLETED || opens.length < CANDLE_REQUIRED_COMPLETED) {
        return '❌'; 
    }

    // --- 1. Persiapan Data ATR (RMA Method ala TradingView) ---
    const trArray = [];
    const atrArray = new Array(closes.length).fill(0);
    const ATR_PERIOD = 14;

    // Hitung True Range (TR)
    for (let k = 0; k < closes.length; k++) {
        if (k < 4) {
            // Jika belum cukup data (candle ke 0, 1, 2, 3), gunakan High - Low standar
            // Ini mencegah index negatif yang menyebabkan NaN
            trArray.push(highs[k] - lows[k]);
        } else {
            // STRATEGI ANDA: Menggunakan closes[k - 4]
            const prevCloseCustom = closes[k - 4];
            const tr = Math.max(
                highs[k] - lows[k],
                Math.abs(highs[k] - prevCloseCustom), // Selisih High dengan Close H-4
                Math.abs(lows[k] - prevCloseCustom)   // Selisih Low dengan Close H-4
            );
            trArray.push(tr);
        }
    }

    // Hitung ATR Awal (SMA)
    let sumTR = 0;
    for (let k = 0; k < ATR_PERIOD; k++) {
        sumTR += trArray[k];
    }
    atrArray[ATR_PERIOD - 1] = sumTR / ATR_PERIOD;

    // Hitung ATR Lanjutan (RMA / Wilder's Smoothing)
    for (let k = ATR_PERIOD; k < trArray.length; k++) {
        atrArray[k] = ((atrArray[k - 1] * (ATR_PERIOD - 1)) + trArray[k]) / ATR_PERIOD;
    }

    // --- 2. Persiapan Data Volume Buy ---
    const volumeBuys = [];
    for (let i = 0; i < volumes.length; i++) {
        const vol = volumes[i];
        const lsr = lsrTakers[i];
        if (lsr <= 0) {volumeBuys.push(0); continue; }
        const volume_buy = vol / (1 + (1 / lsr));
        volumeBuys.push(volume_buy);
    }
    
    let trueCount = 0;
    const endIndex = volumes.length; 
    const ITERATION_COUNT = 1;

    // --- KONFIGURASI PARAMETER (UBAH DI SINI) ---
    const OFFSET_TO_START = 4; // Offset: Seberapa jauh kita melihat ke belakang (skip candle baru)
    const LOOKBACK_DEPTH = 20; // Lookback: Berapa banyak data historis untuk rata-rata volume
    const STABILITY_LOOKBACK = 20; // Stability: Berapa candle ke belakang untuk cek ATR datar
    
    // --- 3. Iterasi Pengecekan Kondisi ---
    for (let i = 0; i < ITERATION_COUNT; i++) {
        
        const currentDataIndex = endIndex - 1 - i; 
        
        // Validasi Index untuk mundur ke belakang
        if (currentDataIndex - (STABILITY_LOOKBACK - 1) < 0) continue; 

        // Ambil data dasar
        const volume_buy_n = volumeBuys[currentDataIndex];
        const volume_buy_n1 = volumeBuys[currentDataIndex - 1];
        const lsr_taker_n = lsrTakers[currentDataIndex];
        const open_interest_n = openInterests[currentDataIndex];
        const open_interest_n1 = openInterests[currentDataIndex - 1];

        // --- A. CEK ATR VALUE (ATRP RENDAH?) ---
        const targetIndexForATR = currentDataIndex - OFFSET_TO_START; 
        const close_n = closes[targetIndexForATR];
        
        // Safety check index ATR
        if (targetIndexForATR < 0) continue;
        const atr_n = atrArray[targetIndexForATR]; 
        
        let atrp_n = 0;
        if (close_n > 0 && atr_n > 0) {
            atrp_n = (atr_n / close_n) * 100;
        }

        // --- B. CEK ATR STABILITY (DATAR SELAMA 20 CANDLE?) ---
        const sliceEnd = currentDataIndex + 1 - OFFSET_TO_START;
        const sliceStart = sliceEnd - STABILITY_LOOKBACK;
        
        if (sliceStart < 0) continue;
        const atrSlice = atrArray.slice(sliceStart, sliceEnd);
        
        // Cari nilai Max dan Min
        const maxAtr = Math.max(...atrSlice);
        const minAtr = Math.min(...atrSlice);

        // Hitung rasio fluktuasi
        let atrStabilityScore = 0;
        if (minAtr > 0) {
            atrStabilityScore = (maxAtr - minAtr) / minAtr;
        }

        // --- Logika Deteksi Spike (Denominator) ---
        const volup = (volume_buy_n1 > 0) ? volume_buy_n / volume_buy_n1 : volume_buy_n / 1;
        const oiup = (open_interest_n1 > 0) ? open_interest_n / open_interest_n1 : open_interest_n / 1;
        
        const endIndexSlice = currentDataIndex - OFFSET_TO_START + 1;
        const startIndex = endIndexSlice - LOOKBACK_DEPTH;
        const denominatorSlice = volumeBuys.slice(startIndex, endIndexSlice);

        if (startIndex < 0 || denominatorSlice.length !== LOOKBACK_DEPTH) continue; 

        const sumDenominator = denominatorSlice.reduce((acc, vol) => acc + vol, 0);
        const denominator = sumDenominator / LOOKBACK_DEPTH;
        let volSpike = (denominator > 0) ? volume_buy_n / denominator : volume_buy_n / 1;

        const denominatorSliceOI = openInterests.slice(startIndex, endIndexSlice);
        const sumDenominatorOI = denominatorSliceOI.reduce((acc, val) => acc + val, 0);
        const denominatorOI = sumDenominatorOI / LOOKBACK_DEPTH;
        let oiSpike = (denominatorOI > 0) ? open_interest_n / denominatorOI : 0;

        const buySlice1 = volumeBuys.slice(startIndex + 4, endIndexSlice + 3);
        const totalBuyVolume1 = buySlice1.reduce((acc, val) => acc + val, 0);
        let buyaverage1 = totalBuyVolume1 / (LOOKBACK_DEPTH - 1);
        const buySlice0 = volumeBuys.slice(startIndex + 4, endIndexSlice + 4);
        const totalBuyVolume0 = buySlice0.reduce((acc, val) => acc + val, 0);
        let buyaverage0 = totalBuyVolume0 / (LOOKBACK_DEPTH);

        let buyavgrasio = buyaverage0 / buyaverage1;

        const lastClose = closes[currentDataIndex];
        const lastOpen = opens[currentDataIndex];
    
        let isBullishLastCandle = false;
        if (lastOpen > 0) {
            isBullishLastCandle = lastClose / lastOpen;        // close candle indeks terakhir / open candle indeks terakhir > 1
        }

        // console.log(`ATRP = ${atrp_n} ATRS = ${atrStabilityScore}`);

        // --- Validasi Status FINAL ---
        const isSpikeValid = (
             //( (volup > 0.75) && (oiup > 0.980) && (volume_buy_n > 3000) && (volSpike > 1.50) && (lsr_taker_n > 1.1) && (oiSpike > 1.015) ) ||
             //( (volup > 0.65) && (oiup > 0.965) && (volume_buy_n > 3000) && (volSpike > 2.00) && (lsr_taker_n > 1.1) && (oiSpike > 1.055) ) ||
             //( (volup > 0.30) && (oiup > 1.000) && (volume_buy_n > 1500) && (volSpike > 2.75) && (lsr_taker_n > 1.1) && (oiSpike > 1.100) )

             ( (volup > 1.5) && (oiup > 1.05) && (volume_buy_n > 7500) && (volSpike > 2.5) && (lsr_taker_n > 1.25) && (oiSpike > 1.05) && isBullishLastCandle > 1)
            
        )

        const isCalmValid = (
             //( (atr_n <= 0.001) && (atrp_n <= 2.5) && (atrStabilityScore <= 0.10) && (buyavgrasio > 1.25) ) || 
             //( (atr_n <= 0.015) && (atrp_n <= 1.7) && (atrStabilityScore <= 0.35) && (buyavgrasio > 1.25) ) ||
             //( (atr_n <= 0.050) && (atrp_n <= 1.1) && (atrStabilityScore <= 0.65) && (buyavgrasio > 1.25) )

             ( (atr_n <= 0.05) && (atrp_n <= 2.5) && (atrStabilityScore <= 0.5) && (buyavgrasio > 1.15) )
            
        );

       if (isSpikeValid && isCalmValid) {
            trueCount++;
        }
    }
    return (trueCount > 0) ? "✅" : "❌";
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
// HANDLER UTAMA VERCEL (PENGGANTI GCF exports.fetchGateioData)
// =======================================================
export default async function handler(req, res) {
    
    // 1. Validasi Input dan Konfigurasi
    if (req.method !== 'POST' || !req.body) {
        return res.status(405).send('Hanya metode POST yang diterima dengan body JSON.');
    }
    
    // Vercel/Next.js Functions secara otomatis mem-parse body JSON
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
            finalData: [null, null, null, null], 
            lsrTakersArray: [], 
            volumesArray: [], 
            openInterestsArray: [] 
        });
    });

    // -----------------------------------------------------------
    // PHASE 1: FETCH DATA STATS
    // -----------------------------------------------------------
    
    const statsRequests = [];
    symbols.forEach(symbol => {
        // Menggunakan STATS_LIMIT = 50
        statsRequests.push({ 
            url: `${FUTURE_STATS_BASE_URL}?contract=${symbol}&limit=${STATS_LIMIT}`, 
            type: 'stats', 
            symbol: symbol 
        });
    });

    const statsResults = await executeBatchFetch(statsRequests, CUSTOM_HEADERS);
    
    // Proses hasil stats dan tentukan parameter fetch candle (from/to)
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
        // Validasi historis harus setidaknya 5
        if (completedStats.length < STATS_REQUIRED_COMPLETED) {
            return;
        }

        // Simpan semua stats completed (untuk data historis)
        syncData.statsCompleted = completedStats;
        
        // Data Stats terbaru yang sudah selesai (akan menjadi 'to' untuk Candle)
        const latestStats = completedStats[completedStats.length - 1];
        const latestStatsTimestamp = latestStats.time; // timestamp 'to'
        
        // Hitung waktu mulai yang dibutuhkan ('from') untuk CANDLE_REQUIRED_COMPLETED
        const requiredLookbackSeconds = (CANDLE_REQUIRED_COMPLETED) * INTERVAL_SECONDS;
        const requiredStartTimestamp = latestStatsTimestamp - requiredLookbackSeconds; 
        
        // REQUEST data candle menggunakan from dan to (TIDAK ADA PARAMETER LIMIT)
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
        
        if (!result.data || result.error) {
            console.error(`Gagal memproses candle untuk ${symbol}: ${result.error}`);
            return;
        }

        const candleData = result.data;
        if (candleData.length === 0) return;
        
        const statsCompleted = syncData.statsCompleted;
        if (statsCompleted.length === 0) return;
        
        // 1. SINKRONISASI PENUH
        const synchronizedData = []; 

        candleData.forEach(candle => {
            const foundStats = statsCompleted.find(s => s.time === candle.t); 
            
            if (foundStats) {
                synchronizedData.push({
                    time: candle.t,
                    price: Number(candle.c),
                    open: Number(candle.o),
                    high: Number(candle.h),
                    low: Number(candle.l), 
                    close: Number(candle.c),
                    volume: Number(candle.sum),
                    lsr_taker: parseFloat(foundStats.lsr_taker),
                    open_interest: parseFloat(foundStats.open_interest_usd || 0)
                });
            }
        });

        // 2. EKSTRAKSI DAN VALIDASI FINAL
        // Validasi minimum: Membutuhkan data sinkron
        if (synchronizedData.length < CANDLE_REQUIRED_COMPLETED) {
            return;
        }
        
        // Data Terbaru yang akan ditampilkan di Kolom B, C, D, E
        const latestSynced = synchronizedData[synchronizedData.length - 1];

        // Konversi Timestamp ke UTC sebelum dimasukkan ke finalData
        syncData.finalData[0] = convertUnixTimestampToUTC(latestSynced.time); 
        // Kolom C (Price)
        syncData.finalData[1] = latestSynced.price; 
        // Kolom D (LSR Taker)
        syncData.finalData[2] = latestSynced.lsr_taker; 
        // Kolom E (Volume Sum)
        syncData.finalData[3] = latestSynced.volume; 

        // 3. Ekstraksi Array Historis untuk Kolom F (Status)
        
        // Ambil array Volume terakhir
        syncData.volumesArray = synchronizedData
            .map(d => d.volume)
            .slice(synchronizedData.length - CANDLE_REQUIRED_COMPLETED);
        
        // Ambil array LSR Taker terakhir
        syncData.lsrTakersArray = synchronizedData
            .map(d => d.lsr_taker)
            .slice(synchronizedData.length - STATS_REQUIRED_COMPLETED);

        // Ambil array LSR Taker terakhir
        syncData.openInterestsArray = synchronizedData
            .map(d => d.open_interest)
            .slice(synchronizedData.length - CANDLE_REQUIRED_COMPLETED);
        
        // Ambil HLC
        syncData.highsArray = synchronizedData.map(d => d.high).slice(synchronizedData.length - CANDLE_REQUIRED_COMPLETED);
        syncData.lowsArray = synchronizedData.map(d => d.low).slice(synchronizedData.length - CANDLE_REQUIRED_COMPLETED);
        syncData.closesArray = synchronizedData.map(d => d.close).slice(synchronizedData.length - CANDLE_REQUIRED_COMPLETED);
        syncData.opensArray = synchronizedData.map(d => d.open).slice(synchronizedData.length - CANDLE_REQUIRED_COMPLETED);
    });

    // -----------------------------------------------------------
    // PHASE 4: FINALISASI PERHITUNGAN STATUS DAN KIRIM RESPON
    // -----------------------------------------------------------
    
    const finalResultArray = symbols.map(symbol => {
        const syncData = syncMap.get(symbol);
        const rawData = syncData.finalData;
        
        const outputRow = [];

        // Masukkan data output: [Timestamp (UTC), Price, LSR Taker, Volume]
        outputRow.push(rawData[0] === null ? '' : rawData[0]); 
        outputRow.push(rawData[1] === null ? 0 : rawData[1]); 
        outputRow.push(rawData[2] === null ? 0 : rawData[2]); 
        outputRow.push(rawData[3] === null ? 0 : rawData[3]); 

        // F: Status Perhitungan
        const lsrTakers = syncData.lsrTakersArray;
        const volumes = syncData.volumesArray;
        const openInterests = syncData.openInterestsArray;
        const opens = syncData.opensArray;
        const highs = syncData.highsArray;
        const lows = syncData.lowsArray;
        const closes = syncData.closesArray;
        
        // Hanya hitung jika data yang sudah selesai memenuhi syarat minimum
        const statusE = (lsrTakers.length === STATS_REQUIRED_COMPLETED && volumes.length === CANDLE_REQUIRED_COMPLETED)
            ? calculateColumnEStatus(lsrTakers, volumes, openInterests, highs, lows, closes, opens)
            : '❌';

        outputRow.push(statusE); // F: Status

        return outputRow; 
    });

    // Kirim Respons menggunakan res.status().json()
    res.status(200).json({ 
        status: 'Success', 
        message: 'Data berhasil diambil dan diproses dengan sinkronisasi waktu.',
        data: finalResultArray 
    });
};
