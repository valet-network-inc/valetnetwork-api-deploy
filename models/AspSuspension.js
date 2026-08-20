const mongoose = require('mongoose');

/**
 * A single day on which New York suspends alternate side parking.
 *
 * Why this is its own collection rather than a hardcoded list: the city
 * publishes ~40 scheduled suspensions a year (holidays, observances) plus
 * unscheduled ones at a few hours' notice (snow). Both have to land somewhere
 * queryable, because two very different things read them:
 *
 *   - the customer app, to say "stay put" instead of "move your car"
 *   - the subscription scheduler, to NOT dispatch and pay a valet for a move
 *     that was never needed, and to credit the customer for the missed day
 *
 * Keyed on a plain 'YYYY-MM-DD' string rather than a Date. Suspensions are
 * calendar facts in New York local time; storing them as Dates invites a
 * timezone bug where a suspension silently shifts a day for anyone whose
 * server clock is UTC — which ours is.
 */
const AspSuspensionSchema = new mongoose.Schema(
    {
        date: {
            type: String,
            required: true,
            unique: true,
            match: /^\d{4}-\d{2}-\d{2}$/,
        },
        // "Eid al-Adha", "Snow emergency" — shown to the customer verbatim, so
        // it must read like something a person would say.
        reason: { type: String, required: true, trim: true },
        source: {
            type: String,
            enum: ['dot_calendar', 'nyc311', 'manual'],
            default: 'manual',
        },
        // Year is denormalised so the annual DOT import can replace exactly one
        // year without touching manually-entered or 311-sourced days.
        year: { type: Number, required: true, index: true },
        note: { type: String },
        createdBy: { type: String },
    },
    { timestamps: true }
);

// `unique: true` on `date` already builds the ascending index that range
// queries ("what is suspended this month") use, so there is nothing to add
// here — declaring it twice is what makes mongoose warn at boot.

module.exports = mongoose.model('AspSuspension', AspSuspensionSchema);
