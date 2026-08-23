/**
 * Hanging a promo code on customer accounts ahead of a campaign.
 *
 * A push can say "your first month is free", but the app build already on
 * people's phones makes them find a "Have a code?" field and type it, and the
 * deep link that would drop them on the plans page loses a race with the
 * auth-loading redirect on a cold start. Both of those are app-side and ride
 * the next App Store build; neither is a reason to send a campaign that leaks
 * the customers it reaches.
 *
 * So the code goes on the account instead of in their hands:
 * `subscriptionController.createSubscription` falls back to
 * `User.pendingPromoCode` when the app sends no code, applies it only if it
 * fits the plan they picked, and drops it quietly otherwise. Activation clears
 * it.
 */

const User = require('../models/User');
const { findPromo, normalizeCode } = require('../services/subscriptionPromos');

// POST /api/admin/pending-promo
// { userIds: [...], code: 'HANDSFREE' }  — hang it on those accounts
// { userIds: [...], code: null }         — take it back off
exports.setPendingPromo = async (req, res) => {
    try {
        const { userIds, code } = req.body || {};
        if (!Array.isArray(userIds) || userIds.length === 0) {
            return res
                .status(400)
                .json({ success: false, message: 'userIds must be a non-empty array' });
        }

        // Clearing is always allowed. Setting is not: a typo'd code would sit
        // on the account doing nothing, and the customer would be told at
        // checkout that a code they never typed is invalid.
        if (code === null || code === undefined || code === '') {
            const result = await User.updateMany(
                { _id: { $in: userIds } },
                { $unset: { pendingPromoCode: 1, pendingPromoSetAt: 1 } }
            );
            return res.json({
                success: true,
                cleared: true,
                matched: result.matchedCount ?? result.n ?? 0,
                modified: result.modifiedCount ?? result.nModified ?? 0,
            });
        }

        const promo = findPromo(code);
        if (!promo) {
            return res.status(400).json({ success: false, message: `No promo named ${code}` });
        }

        const result = await User.updateMany(
            { _id: { $in: userIds } },
            { $set: { pendingPromoCode: normalizeCode(code), pendingPromoSetAt: new Date() } }
        );

        console.log(
            `Pending promo ${promo.code} set on ${result.modifiedCount ?? result.nModified ?? 0} account(s)`
        );

        return res.json({
            success: true,
            code: promo.code,
            appliesTo: promo.appliesTo || null,
            matched: result.matchedCount ?? result.n ?? 0,
            modified: result.modifiedCount ?? result.nModified ?? 0,
        });
    } catch (err) {
        console.error('setPendingPromo failed:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// GET /api/admin/pending-promo — who is carrying one right now.
exports.listPendingPromo = async (req, res) => {
    try {
        const users = await User.find({ pendingPromoCode: { $exists: true, $ne: null } })
            .select('_id firstName lastName name phone pendingPromoCode pendingPromoSetAt')
            .lean();
        const byCode = users.reduce((acc, u) => {
            acc[u.pendingPromoCode] = (acc[u.pendingPromoCode] || 0) + 1;
            return acc;
        }, {});
        return res.json({ success: true, count: users.length, byCode, users });
    } catch (err) {
        console.error('listPendingPromo failed:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};
