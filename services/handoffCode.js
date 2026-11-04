/**
 * Handoff codes: the code read out at each key handoff.
 *
 * Optional per user since Nov 2026 (Rishi: "OTP is off by default, but can be
 * enabled in profile"): `User.handoffCodes`, copied onto each order as
 * `Order.handoffCode` when it is made. With it off, a code is still minted —
 * every beat of the handoff machinery (types, the retrieval's second code, the
 * stamps the cancel and refund gates read) keeps running unchanged — but no
 * app shows it, and the valet's swipe confirms the beat instead
 * (`POST /api/order/confirmHandoff`), verified server-side against the code
 * the order holds.
 *
 * Three digits (Rishi, Nov 3 2026: "make the code reading 3 digits instead").
 * It is a handshake between two people standing at the car, not a password.
 */
const User = require('../models/User');

function newHandoffCode() {
    return String(Math.floor(100 + Math.random() * 900));
}

/** Whether this user has handoff codes switched on. Off when unknown. */
async function handoffCodesOn(userId) {
    if (!userId) return false;
    const user = await User.findById(userId).select('handoffCodes').lean();
    return !!(user && user.handoffCodes);
}

module.exports = { newHandoffCode, handoffCodesOn };
