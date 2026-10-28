const mongoose = require('mongoose');

/**
 * A gift card is a link that puts money on whoever redeems it. Redeeming adds
 * the amount to the customer's Stripe balance, which Stripe takes off their
 * plan bills until it is used up. One redemption per card: the claim on
 * `redeemedBy` (null → the customer) is what makes that hold.
 */
const GiftCardSchema = new mongoose.Schema(
    {
        // Upper-case letters and digits; the link carries it.
        code: { type: String, required: true, unique: true },
        amountCents: { type: Number, required: true, min: 100 },
        recipientName: { type: String },
        message: { type: String },
        active: { type: Boolean, default: true },
        redeemedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        redeemedAt: { type: Date, default: null },
        stripeCustomerId: { type: String },
        stripeBalanceTransactionId: { type: String },
        createdBy: { type: String },
    },
    { timestamps: true }
);

module.exports = mongoose.model('GiftCard', GiftCardSchema);
