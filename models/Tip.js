const mongoose = require('mongoose');

// Tip — customer-paid tip for a valet, 100% pass-through.
//
// Customer is charged the gross amount via Stripe. Stripe takes their
// processing fee (2.9% + 30¢ in the US). The remaining net amount lands
// in the valet's currentBalance + totalEarnings — they get paid out via
// the existing payout flow (Zelle/Venmo/Cash App).
//
// Valet Network never touches a penny of the tip. The Stripe fee is
// borne by the valet (deducted from their net), not by the platform.
// This is intentional: keeps VNI hands-off the contractor's
// compensation, which strengthens the 1099 contractor relationship.

const TipSchema = new mongoose.Schema({
    order: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Order',
        required: true,
        index: true,
    },
    customer: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    valet: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },

    // Amounts in cents.
    amountGross: { type: Number, required: true },     // what customer was charged
    stripeFee:   { type: Number, required: true },     // Stripe's fee (deducted from gross)
    amountNet:   { type: Number, required: true },     // what valet receives (gross - fee)

    // What preset the customer picked (15 / 20 / 25), or null if custom amount.
    // Stored for analytics — what fraction of tips are %-based vs custom?
    percentagePreset: { type: Number, enum: [15, 20, 25, null], default: null },

    // Where in the order lifecycle the tip was added. Used by the mobile UI
    // to render different copy ("Thanks for tipping after pickup!" etc.) and
    // by analytics to learn which moments drive the most tipping.
    context: {
        type: String,
        enum: [
            'during_park',
            'after_park',
            'during_retrieve',
            'after_retrieve',
            'post_completion',
            'general',
        ],
        default: 'general',
    },

    // Stripe references
    paymentIntentId: { type: String, required: true, unique: true },
    chargeId: { type: String },
    currency: { type: String, default: 'usd' },

    status: {
        type: String,
        enum: ['pending', 'succeeded', 'failed', 'refunded'],
        default: 'pending',
        required: true,
    },

    // Failure / refund reason (if applicable)
    failureReason: { type: String },
}, {
    timestamps: true,
});

module.exports = mongoose.model('Tip', TipSchema);
