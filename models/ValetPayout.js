const mongoose = require('mongoose');

/**
 * ValetPayout
 *
 * Records a valet's payout request. The app does NOT move money — Rishi
 * manually pays out via Zelle/transfer and (optionally) marks the record
 * as `sent` later. Slack notification fires on every new request.
 *
 * Note: separate from the legacy `Payout` model which is tied to the
 * subscription / Stripe-transfer flow and shouldn't be conflated.
 */
const ValetPayoutSchema = new mongoose.Schema(
    {
        valet: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        // Snapshot of valet's name/contact at request time, in case profile is edited later
        valetSnapshot: {
            firstName: { type: String },
            lastName: { type: String },
            phone: { type: String },
        },
        // Total amount paid out, in cents (= earningsAmount + tipsAmount).
        amount: {
            type: Number,
            required: true,
            min: 0,
        },
        // Breakdown of the payout — base earnings vs tip earnings — so the
        // admin dashboard can show "of $X paid, $Y was tips" and so the
        // valet's pay history can split the two cleanly. Both in cents.
        earningsAmount: {
            type: Number,
            default: 0,
            min: 0,
        },
        tipsAmount: {
            type: Number,
            default: 0,
            min: 0,
        },
        method: {
            type: String,
            enum: ['zelle', 'venmo', 'cashapp'],
            required: true,
        },
        // Destination handle for the chosen method:
        //   zelle   → email or phone (E.164)
        //   venmo   → username (no leading '@')
        //   cashapp → $cashtag (no leading '$')
        handle: {
            type: String,
            required: true,
        },
        status: {
            type: String,
            enum: ['requested', 'sent', 'cancelled'],
            default: 'requested',
        },
        // Optional note (transaction ref, etc.)
        adminNote: { type: String },
        sentAt: { type: Date },
    },
    { timestamps: true }
);

module.exports = mongoose.model('ValetPayout', ValetPayoutSchema);
