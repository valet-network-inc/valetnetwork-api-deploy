const mongoose = require('mongoose');

// A pick-up (Park my car) or drop-off (Bring my car back) booked for later,
// once or on repeat (spec v2, 8). services/scheduledMoves.js turns each
// occurrence into an ordinary order shortly before it.
const ScheduledMoveSchema = new mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        kind: { type: String, enum: ['pick-up', 'drop-off'], required: true },
        repeat: { type: String, enum: ['once', 'weekdays', 'daily', 'days'], default: 'once' },
        days: [{ type: Number, min: 0, max: 6 }], // repeat 'days': 0 = Sunday
        time: { type: String, required: true }, // 'HH:MM', New York
        address: {
            streetAddress: { type: String, required: true },
            lat: { type: Number, required: true },
            lng: { type: Number, required: true },
        },
        // Where the car stands when it isn't at the keys (Park my car's car map, Nov 5).
        carLocation: {
            streetAddress: { type: String },
            lat: { type: Number },
            lng: { type: Number },
        },
        active: { type: Boolean, default: true },
        // Paid at booking (Rishi, Nov 5 2026: "charge it at booking because what
        // if there's no card on file?"). `priced`: booked by a client that showed
        // the price and took the money, so a retrieval is charged like one for
        // now. `prepaid`: what the booking paid, used by the next run instead of
        // a new charge and refunded if that run doesn't need it. Later runs of a
        // repeat are charged when they're booked to `paymentMethodId`, the card
        // the booking paid with. `awaitingPayment`: booked, payment not back yet;
        // the move stays inactive (out of the job and Home) until it is.
        priced: { type: Boolean },
        prepaid: {
            paymentIntentId: { type: String },
            cents: { type: Number },
            paidAt: { type: Date },
        },
        paymentMethodId: { type: String },
        awaitingPayment: {
            paymentIntentId: { type: String },
            cents: { type: Number },
            since: { type: Date },
        },
        nextAt: { type: Date, index: true },
        skipped: [{ type: String }], // occurrence keys cancelled one at a time
        lastKey: { type: String }, // the occurrence last claimed by the job
        lastOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
        lastOutcome: { type: String },
        lastError: { type: String },
    },
    { timestamps: true }
);

ScheduledMoveSchema.index({ active: 1, nextAt: 1 });

module.exports = mongoose.model('ScheduledMove', ScheduledMoveSchema);
