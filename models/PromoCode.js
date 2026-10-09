const mongoose = require('mongoose');

// Discount codes created without a deploy (2026-10-09).
//
// The built-in codes (HANDSFREE, LOLGARAGE, ...) still live in
// services/subscriptionPromos.js. These are the ones an admin makes in the
// rep portal or through /api/admin/sales/codes, and findPromo reads them
// first. Customers type both kinds into the same "Have a code?" field.
//
//   percent_off  — percentOff% off, for `duration`
//   amount_off   — amountOffCents off each bill, for `duration`
//   free_trial   — trialDays free, card taken up front (see subscriptionPromos.js
//                  for why a free stretch must be a trial and never a 100% coupon)
//   rep          — no discount; credits the subscription to `rep`
//
// Any kind may carry `rep`, which credits the subscription to that rep.
const PromoCodeSchema = new mongoose.Schema(
    {
        // Normalized exactly like subscriptionPromos.normalizeCode: uppercase,
        // spaces and dashes removed.
        code: { type: String, required: true, unique: true },
        kind: {
            type: String,
            enum: ['percent_off', 'amount_off', 'free_trial', 'rep'],
            required: true,
        },
        percentOff: { type: Number, min: 1, max: 99 },
        amountOffCents: { type: Number, min: 1 },
        // How long a percent/amount discount lasts, in Stripe's own terms.
        duration: { type: String, enum: ['once', 'repeating', 'forever'], default: 'once' },
        durationInMonths: { type: Number, min: 1 },
        trialDays: { type: Number, min: 1 },
        // Empty means any plan. A filled field pins the code to that plan
        // and snaps a customer on another plan onto it.
        appliesTo: {
            tier: { type: String },
            interval: { type: String },
            movesPerWeek: { type: Number },
        },
        // Only before the customer's first plan ever starts.
        firstTimeOnly: { type: Boolean, default: false },
        // Empty = no cap. Counted once per subscription when it activates.
        maxRedemptions: { type: Number, min: 1 },
        redemptions: { type: Number, default: 0 },
        expiresAt: { type: Date },
        active: { type: Boolean, default: true },
        rep: { type: mongoose.Schema.Types.ObjectId, ref: 'Rep' },
        // Minted on first use for percent/amount codes, then reused.
        stripeCouponId: { type: String },
        // Shown on the review screen. Generated from the terms when empty
        // ("20% off your first month").
        headline: { type: String },
        detail: { type: String },
        createdBy: { type: String },
    },
    { timestamps: true }
);

module.exports = mongoose.model('PromoCode', PromoCodeSchema);
