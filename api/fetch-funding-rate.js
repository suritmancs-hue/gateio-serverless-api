// api/fetch-funding-rate.js

const fetch = require('node-fetch');

// Batas Konkurensi dan Jeda untuk menghindari Error 429
const CONCURRENCY_LIMIT = 10; 
const DELAY_MS = 500; 
const HISTORY_LIMIT = 3; // Ambil 3 data untuk memastikan kita punya N dan N-1

/**
 * Fungsi pembantu untuk menjalankan batch request dengan rate limiting.
 * (Disalin dari fungsi sebelumnya, karena prinsipnya sama)
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
                return { symbol: reqItem.symbol, data: null, error: `HTTP Error: ${response.status} - ${response.statusText}` };
            }
            return response.json().then(data => ({
                symbol: reqItem.symbol, data: data, error: null
            })).catch(e => ({
                symbol: reqItem.symbol, data: null, error: `JSON Parse Error: ${e.message}`
            }));
        })
        .catch(e => ({
            symbol: reqItem.symbol, data: null, error: `Fetch Error: ${e.message}`
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
// HANDLER UTAMA VERCEL UNTUK FUNDING RATE
// =======================================================
export default async function handler(req, res) {
    
    if (req.method !== 'POST' || !req.body) {
        return res.status(405).send('Hanya metode POST yang diterima dengan body JSON.');
    }
    
    const { symbols, config } = req.body;
    
    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
        return res.status(400).send('Daftar simbol tidak valid atau kosong.');
    }
    
    const { FUTURE_FR_HISTORY_BASE_URL, CUSTOM_HEADERS } = config;

    // --- PHASE 1: FETCH DATA FUNDING RATE ---
    const frRequests = [];
    symbols.forEach(symbol => {
        frRequests.push({ 
            url: `${FUTURE_FR_HISTORY_BASE_URL}?contract=${symbol}&limit=${HISTORY_LIMIT}`, 
            symbol: symbol 
        });
    });
    const frResults = await executeBatchFetch(frRequests, CUSTOM_HEADERS);
    
    // --- PHASE 2: PERHITUNGAN DAN FINALISASI ---
    const finalResultArray = frResults.map(result => {
        const symbol = result.symbol;
        let frChangeRatio = 0; // Default jika gagal
        let finalOutputFR = 0; // 🛠️ DEKLARASI: Variabel yang akan dikembalikan (Kolom G)
    
        if (!result.data || result.error || result.data.length < 2) {
            // Jika data error atau kurang dari 2 (N dan N-1)
            return [finalOutputFR];
        }
        const frHistory = result.data;
        
        // Pastikan properti API yang digunakan adalah 'r'
        const latestFR = parseFloat(frHistory[0].r);
        const prevFR = parseFloat(frHistory[1].r);
    
        // Pastikan tidak ada pembagian dengan nol dan data valid
        if (!isNaN(latestFR) && !isNaN(prevFR) && prevFR !== 0 && isFinite(latestFR) && isFinite(prevFR)) {
            frChangeRatio = (latestFR - prevFR) / prevFR;
        }
    
        // 🛠️ LOGIKA finalOutputFR
        if (frChangeRatio < 1.5) {
            finalOutputFR = latestFR;
        } else {
            finalOutputFR = 1; // Atau nilai yang Anda inginkan saat rasio tinggi
        }
    
        // Output hanya satu kolom: Nilai final dari logika if/else
        return [finalOutputFR];
    });

    // Kirim Respons
    res.status(200).json({ 
        status: 'Success', 
        message: 'Data Funding Rate berhasil diambil dan diproses.',
        data: finalResultArray 
    });
}
