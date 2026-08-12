const PricingConfig = require('../models/PricingConfig');

// The editable price fields (all integer cents).
const PRICE_FIELDS = [
    'parkingCents',
    'parkAndRetrieveCents',
    'aspCents',
    'retrievalCents',
    'carWatchPerHourCents',
];

function serialize(doc) {
    const out = {};
    PRICE_FIELDS.forEach((f) => {
        out[f] = doc[f];
    });
    out.updatedBy = doc.updatedBy || null;
    out.updatedAt = doc.updatedAt;
    return out;
}

// GET /api/pricing — public. The mobile app calls this on launch to price the
// order screen. Never fails hard: on error the client falls back to its own
// built-in defaults, but we still return 500 so problems are visible.
exports.getPricing = async (req, res) => {
    try {
        const doc = await PricingConfig.getSingleton();
        return res.json({ success: true, pricing: serialize(doc) });
    } catch (err) {
        console.error('getPricing error:', err);
        return res
            .status(500)
            .json({ success: false, message: 'Failed to load pricing' });
    }
};

// PUT /api/pricing — admin dashboard. Accepts any subset of PRICE_FIELDS.
exports.updatePricing = async (req, res) => {
    try {
        const doc = await PricingConfig.getSingleton();
        const updates = {};

        for (const f of PRICE_FIELDS) {
            if (req.body[f] !== undefined && req.body[f] !== null) {
                const v = Number(req.body[f]);
                // Guard against garbage / negative / absurd values (max $10,000).
                if (!Number.isFinite(v) || v < 0 || v > 1000000) {
                    return res.status(400).json({
                        success: false,
                        message: `Invalid value for ${f}`,
                    });
                }
                updates[f] = Math.round(v);
            }
        }

        if (req.body.updatedBy) {
            updates.updatedBy = String(req.body.updatedBy).slice(0, 120);
        }

        if (Object.keys(updates).length === 0) {
            return res
                .status(400)
                .json({ success: false, message: 'No valid price fields provided' });
        }

        Object.assign(doc, updates);
        await doc.save();

        console.log('Pricing updated:', updates);
        return res.json({ success: true, pricing: serialize(doc) });
    } catch (err) {
        console.error('updatePricing error:', err);
        return res
            .status(500)
            .json({ success: false, message: 'Failed to update pricing' });
    }
};
