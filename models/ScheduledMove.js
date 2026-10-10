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
        active: { type: Boolean, default: true },
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
