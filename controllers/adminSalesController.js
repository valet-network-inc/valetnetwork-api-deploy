/**
 * The admin-key mirrors of the rep portal's admin section (spec v2, 19).
 *
 * The portal is where Rishi edits prices, codes and notes. These are the same
 * operations behind `x-admin-key`, for ops scripts and for the day the portal
 * is down. They call the same services the portal does, so a rule enforced
 * there (a commission below the price, a code that can't make the first bill
 * $0) is enforced here too.
 */

const {
    getTable,
    saveTable,
    allNeighborhoods,
} = require('../services/neighborhoodPricing');
const { createCode, updateCode, listCodes } = require('../services/subscriptionPromos');

// GET /api/admin/sales/pricing — the live table, centroids included.
exports.getPricing = async (req, res) => {
    try {
        const table = await getTable();
        res.json({ success: true, table, neighborhoods: allNeighborhoods(table) });
    } catch (err) {
        console.error('admin getPricing error:', err);
        res.status(500).json({ success: false, message: 'Could not load prices', error: err.message });
    }
};

// PUT /api/admin/sales/pricing  { brooklynQueens?, manhattan?, contactSales? }
exports.putPricing = async (req, res) => {
    try {
        const result = await saveTable(req.body || {}, req.get('x-admin-actor') || 'admin-key');
        if (result.error) return res.status(400).json({ success: false, message: result.error });
        res.json({ success: true, table: result.table });
    } catch (err) {
        console.error('admin putPricing error:', err);
        res.status(500).json({ success: false, message: 'Could not save prices', error: err.message });
    }
};

// GET /api/admin/sales/codes
exports.getCodes = async (req, res) => {
    try {
        res.json({ success: true, ...(await listCodes()) });
    } catch (err) {
        console.error('admin getCodes error:', err);
        res.status(500).json({ success: false, message: 'Could not load codes', error: err.message });
    }
};

// POST /api/admin/sales/codes  { code, kind, ... } (subscriptionPromos.createCode)
exports.postCode = async (req, res) => {
    try {
        const result = await createCode(req.body || {}, req.get('x-admin-actor') || 'admin-key');
        if (result.error) return res.status(400).json({ success: false, message: result.error });
        res.status(201).json({ success: true, code: result.code });
    } catch (err) {
        console.error('admin postCode error:', err);
        res.status(500).json({ success: false, message: 'Could not create the code', error: err.message });
    }
};

// PATCH /api/admin/sales/codes/:code  { active?, maxRedemptions?, expiresAt?, headline?, detail? }
exports.patchCode = async (req, res) => {
    try {
        const result = await updateCode(req.params.code, req.body || {});
        if (result.error) return res.status(400).json({ success: false, message: result.error });
        res.json({ success: true, code: result.code });
    } catch (err) {
        console.error('admin patchCode error:', err);
        res.status(500).json({ success: false, message: 'Could not update the code', error: err.message });
    }
};
