const mongoose = require('mongoose');

/**
 * OpsAlert — one durable row per thing a human needs to look at.
 *
 * Alerting in this system has, until now, been fire-and-forget: a Slack POST
 * that nothing records and nobody can clear. That is fine for a price mismatch,
 * which is interesting once. It is wrong for a managed car, where the alert is
 * a WORKLIST ITEM — a car we are holding whose block we cannot read is a $65
 * ticket waiting to happen, and it stays true until somebody does something
 * about it.
 *
 * So alerts are rows: they survive a restart, the admin console can show them
 * as an inbox sorted by urgency, and acknowledging one is a recorded act rather
 * than a message scrolling out of a channel.
 *
 * The unique index is the dedupe, and it is the same trick AspCredit uses for
 * money: a scheduler that retries every 60 seconds across a 50-minute window
 * cannot be trusted to deduplicate itself in application logic, so the database
 * enforces it. One alert of a given kind, per car, per New York day.
 */
const OpsAlertSchema = new mongoose.Schema(
    {
        kind: { type: String, required: true, index: true },
        // 'page' is for a car that is about to take a ticket, or has. 'warn' is
        // everything a person should see today but not right now. Keeping the
        // page set small is what stops the alarm from being ignored — the one
        // alerting service already in this repo died of exactly that.
        severity: {
            type: String,
            enum: ['warn', 'page'],
            default: 'warn',
            index: true,
        },
        custody: { type: mongoose.Schema.Types.ObjectId, ref: 'CurbCustody' },
        order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
        customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        // 'YYYY-MM-DD' in New York, matching AspSuspension and AspCredit.
        dateKey: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },

        title: { type: String, required: true },
        detail: { type: String },
        payload: { type: mongoose.Schema.Types.Mixed },

        acknowledgedAt: { type: Date },
        acknowledgedBy: { type: String },
        acknowledgedNote: { type: String },
    },
    { timestamps: true }
);

// The guarantee: one alert of this kind, for this car, on this day.
OpsAlertSchema.index(
    { kind: 1, custody: 1, dateKey: 1 },
    { unique: true, sparse: true }
);
// The inbox query: everything unacknowledged, worst first, newest first.
OpsAlertSchema.index({ acknowledgedAt: 1, severity: 1, createdAt: -1 });

module.exports = mongoose.model('OpsAlert', OpsAlertSchema);
