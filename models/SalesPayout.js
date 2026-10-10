const mongoose = require('mongoose');

// Money Rishi sent to a rep (commission) or to a customer (referrals), recorded
// in admin. The rep's Earnings page shows it as paid.
const SalesPayoutSchema = new mongoose.Schema(
    {
        kind: { type: String, enum: ['rep', 'referral'], required: true },
        rep: { type: mongoose.Schema.Types.ObjectId, ref: 'Rep', index: true },
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
        month: { type: String, required: true }, // YYYY-MM, America/New_York
        amountCents: { type: Number, required: true, min: 1 },
        method: { type: String, trim: true },
        note: { type: String, trim: true },
        recordedBy: { type: String },
    },
    { timestamps: true }
);

module.exports = mongoose.model('SalesPayout', SalesPayoutSchema);
