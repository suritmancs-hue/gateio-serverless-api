// api/fetch-funding-rate.js

const fetch = require('node-fetch');

// Batas Konkurensi dan Jeda untuk menghindari Error 429
const CONCURRENCY_LIMIT = 10; 
const DELAY_MS = 500; 
const HISTORY_LIMIT = 3; // Mengambil 3 data terakhir

/**
 * Fungsi pembantu untuk menjalankan batch request dengan rate limiting.
 */
async function executeBatchFetch(requests, customHeaders) {
    let allResults = [];
    let fetchPromises = [];
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    for (let i = 0; i < requests.length; i++) {
        const reqItem = requests[i];
        
        const promise = fetch(reqItem.url, {
            method: 'GET',
            headers: customHeaders
        })
        .then(response => {
            if (!response.ok) {
                return { symbol: reqItem.symbol, data: null, error: `HTTP Error: ${response.status}` };
            }
            return response.json().then(data => ({
                symbol: reqItem.symbol, data: data, error: null
            })).catch(e => ({
                symbol: reqItem.symbol, data: null, error: `Parse Error`
            }));
        })
        .catch(e => ({
            symbol: reqItem.symbol, data: null, error: `Fetch Error`
        }));
        
        fetchPromises.push(promise);
        
        if (fetchPromises.length >= CONCURRENCY_LIMIT || i === requests.length - 1) {
            try {
                const batchResults = await Promise.all(fetchPromises);
                allResults = allResults.concat(batchResults);
            } catch (e) {
                console.error("Batch error:", e);
            }
            fetchPromises = [];
            if (i < requests.length - 1) await delay(DELAY_MS);
        }
    }
    return allResults;
}

// =======================================================
// HANDLER UTAMA VERCEL UNTUK FUNDING RATE
// =======================================================
export default async function handler(req, res) {
    
    if (req.method !== 'POST' || !req.body) {
        return res.status(405).send('Hanya metode POST yang diterima.');
    }
    
    const { symbols, config } = req.body;
    
    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
        return res.status(400).send('Simbol tidak valid.');
    }
    
    const { FUTURE_FR_HISTORY_BASE_URL, CUSTOM_HEADERS } = config;

    const frRequests = [];
    symbols.forEach(symbol => {
        frRequests.push({ 
            url: `${FUTURE_FR_HISTORY_BASE_URL}?contract=${symbol}&limit=${HISTORY_LIMIT}`, 
            symbol: symbol 
        });
    });

    const frResults = await executeBatchFetch(frRequests, CUSTOM_HEADERS);
    
    const finalResultArray = frResults.map(result => {
        let finalOutput = '❌'; // Default dikembalikan sebagai '❌'
    
        if (!result.data || result.error || result.data.length < HISTORY_LIMIT) {
            return [finalOutput];
        }

        // Ekstraksi nilai FR dari properti 'r'
        const frValues = result.data.map(item => parseFloat(item.r));
        
        // Cek validitas angka
        if (frValues.some(val => isNaN(val))) return [finalOutput];

        // 🛠️ PERHITUNGAN LOGIKA AND (3 DATA TERAKHIR)
        const maxFR = Math.max(...frValues);
        const minFR = Math.min(...frValues);
        const currentFR = frValues[0]; // Data paling terbaru

        // Syarat: Max < 0.05 DAN Min > -0.5
        if (maxFR < 0.05 && minFR > -0.5) {
            finalOutput = currentFR; 
        } else {
            finalOutput = '❌';
        }
    
        return [finalOutput];
    });

    res.status(200).json({ 
        status: 'Success', 
        data: finalResultArray 
    });
}
