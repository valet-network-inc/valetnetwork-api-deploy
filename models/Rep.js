const mongoose = require('mongoose');

// A sales rep (Rishi, 2026-10-09).
//
// Reps sell Permanent valet on the live /sales terms and need nothing in the
// customer app: Rishi adds them by name and phone in the rep portal's admin
// section, and they sign in at valetnetwork.co/rep with a text code to the
// phone on this record. A rep is not a customer User.
//
// Each rep has a code. Typed in the app's "Have a code?" field it gives no
// discount on its own — a PromoCode of kind 'rep' with the same name credits
// the subscription to the rep. A discount code can carry a rep too.
const RepSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        // E.164 (+19175551234). The sign-in matches the Firebase token's
        // phone_number against this, so it is the rep's identity.
        phone: { type: String, required: true, unique: true, trim: true },
        email: { type: String, trim: true, lowercase: true },
        // Normalized like a promo code (uppercase, no spaces or dashes).
        code: { type: String, unique: true, sparse: true },
        // 'admin' sees the admin section of the portal: prices, codes, reps,
        // payouts, every neighborhood.
        role: { type: String, enum: ['rep', 'admin'], default: 'rep' },
        // Off means the rep cannot sign in. Their history stays.
        active: { type: Boolean, default: true },
        // Stored the first time the rep signs in, after the phone matched.
        firebaseUid: { type: String, unique: true, sparse: true },
        createdBy: { type: String },
        notes: { type: String },
        // The signed commission agreement (services/repAgreement.js).
        agreement: {
            version: { type: Number },
            signedName: { type: String, trim: true },
            signedAt: { type: Date },
            ip: { type: String },
            userAgent: { type: String },
            emailStatus: { type: String }, // sent | not_configured | failed
            emailError: { type: String },
            sentTo: [{ type: String }],
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Rep', RepSchema);
