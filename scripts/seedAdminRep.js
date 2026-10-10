/**
 * Make a phone number an admin rep: the rep portal's admin tabs (prices,
 * codes, reps, unlocks, referral payouts) open for that number only.
 *
 * Usage:  MONGO_URI=... node scripts/seedAdminRep.js "<10-digit phone>" "<Full name>" [email] [--apply]
 * Without --apply it prints what it would do.
 */
const mongoose = require('mongoose');
const Rep = require('../models/Rep');
const { phoneCode } = require('../services/phoneCodes');

(async () => {
    const args = process.argv.slice(2).filter((a) => a !== '--apply');
    const apply = process.argv.includes('--apply');
    const [rawPhone, name, email] = args;
    const phone = phoneCode(rawPhone);
    if (!phone || !name) {
        console.error('Usage: node scripts/seedAdminRep.js "<10-digit phone>" "<Full name>" [email] [--apply]');
        process.exit(1);
    }
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error('MONGO_URI is required');
    await mongoose.connect(uri);
    const existing = await Rep.findOne({ phone }).lean();
    console.log(existing ? `Rep exists: ${existing.name} (${existing.role})` : 'No rep with that number yet.');
    if (!apply) {
        console.log(`Would set ${phone} → ${name}, role admin${email ? `, ${email}` : ''}. Re-run with --apply.`);
    } else {
        const rep = await Rep.findOneAndUpdate(
            { phone },
            { $set: { name, role: 'admin', active: true, code: phone, ...(email ? { email } : {}) } },
            { upsert: true, new: true }
        );
        console.log(`Admin rep: ${rep.name} ${rep.phone} (${rep._id})`);
    }
    await mongoose.disconnect();
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
