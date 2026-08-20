const mongoose = require('mongoose');

/**
 * One credit issued to a subscriber because the city suspended a street
 * cleaning they had already paid for.
 *
 * Exists as its own collection rather than an array on the subscription for
 * one reason: the unique index below is what makes crediting idempotent. The
 * scheduler retries an occurrence every minute across a 50-minute window, so
 * without a hard constraint a single holiday would credit a customer dozens of
 * times. Money needs the database to enforce that, not application logic.
 */
const AspCreditSchema = new mongoose.Schema(
    {
        subscription: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Subscription',
            required: true,
        },
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        // 'YYYY-MM-DD' in New York, matching AspSuspension.
        date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
        amountCents: { type: Number, required: true, min: 0 },
        reason: { type: String, required: true },
        stripeStatus: {
            type: String,
            enum: ['pending', 'applied', 'skipped', 'failed'],
            default: 'pending',
        },
        stripeTransactionId: { type: String },
        note: { type: String },
    },
    { timestamps: true }
);

// The guarantee: one credit per subscription per day, enforced by Mongo.
AspCreditSchema.index({ subscription: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('AspCredit', AspCreditSchema);
