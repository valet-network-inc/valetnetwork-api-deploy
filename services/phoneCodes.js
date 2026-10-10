// Rep and referral codes are phone numbers (Rishi, 2026-10-09: "more unique
// and fewer errors"). A rep's code is the rep's 10-digit number and credits
// the rep; a customer's is theirs and pays them the referral. Neither is a
// discount. Admin-made discount codes stay words.
const mongoose = require('mongoose');

/** "(917) 555-0134", "+1 917 555 0134", "9175550134" → "9175550134"; else null. */
function phoneCode(code) {
    const raw = String(code || '');
    if (/[a-z]/i.test(raw)) return null;
    let d = raw.replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    return d.length === 10 && /^[2-9]/.test(d) ? d : null;
}

/** The ways a 10-digit number is stored on User.phone (Firebase gives E.164). */
function phoneVariants(ten) {
    return [`+1${ten}`, `1${ten}`, ten];
}

/** "(917) 555-0134". */
function formatPhone(ten) {
    const d = phoneCode(ten);
    return d ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(ten || '');
}

/**
 * The promo a phone number stands for, or null. A rep's number wins over a
 * customer's. A customer's number is a code only once they have told us
 * where to send the money (Refer a friend, step 1).
 */
async function findPhonePromo(code) {
    const ten = phoneCode(code);
    if (!ten || mongoose.connection.readyState !== 1) return null;
    const Rep = require('../models/Rep');
    const User = require('../models/User');
    const base = { code: ten, appliesTo: null, firstTimeOnly: false, active: true, source: 'phone', headline: 'Code applied', detail: null };
    const rep = await Rep.findOne({ phone: ten, active: { $ne: false } }).select('_id name').lean();
    if (rep) return { ...base, kind: 'rep', rep: rep._id };
    const user = await User.findOne({ phone: { $in: phoneVariants(ten) }, 'referral.method': { $exists: true } })
        .select('_id')
        .lean();
    if (user) return { ...base, kind: 'referral', referrer: user._id };
    return null;
}

module.exports = { phoneCode, phoneVariants, formatPhone, findPhonePromo };
