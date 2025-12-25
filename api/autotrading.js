// ... (Bagian Signature & Request tetap sama)

module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed." });
    
    try {
        const { pair, amount, side, trigger_price, rule, type } = req.body;
        let result;

        if (type === "trigger") {
            // PAKSA OBJEK BERSIH TANPA PROPERTI LAIN
            const cleanPut = {
                type: "market",
                side: side || "sell",
                amount: String(amount)
            };

            const triggerPayload = {
                trigger: {
                    price: String(trigger_price),
                    rule: String(rule),
                    expiration: 86400 * 30
                },
                put: cleanPut,
                currency_pair: String(pair).toUpperCase().replace("-", "_")
            };

            // DEBUG: Cek di Real-time Logs Vercel
            console.log("PAYLOAD TO GATEIO:", JSON.stringify(triggerPayload));
            
            result = await gateioRequest("POST", "/spot/price_orders", "", triggerPayload);
        } else {
            const orderPayload = {
                currency_pair: String(pair).toUpperCase().replace("-", "_"),
                side: side || "buy",
                type: "market",
                account: "spot",
                amount: String(amount),
                time_in_force: "fok"
            };

            result = await gateioRequest("POST", "/spot/orders", "", orderPayload);
        }

        // --- HANDLING RESPONSE ---
        if (result.ok) {
            return res.status(200).json({
                success: true,
                order_id: result.data.id,
                full_data: result.data 
            });
        } else {
            // Lihat di sini jika masih error
            console.error("[GATEIO_ERROR_DETAIL]", JSON.stringify(result.data));
            return res.status(result.status).json({
                success: false,
                error: result.data
            });
        }

    } catch (error) {
        return res.status(500).json({ error: "Internal Error", message: error.message });
    }
};
