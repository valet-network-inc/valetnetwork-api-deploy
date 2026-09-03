const mongoose = require('mongoose');

/**
 * CurbCustody — a car we are holding on the street between moves.
 *
 * The $250 (`home_garage`) and $300 (`valet_anywhere`) plans sell active
 * management of a parked car: the customer is never asked when their street is
 * cleaned, because the valet is standing at the sign. The sweep schedule is
 * therefore a property of THE BLOCK THE CAR IS ON RIGHT NOW, and it changes
 * every time we re-park. Management runs for the life of the plan, not for one
 * booking — a car sitting untouched for three weeks is the good case.
 *
 * WHY THIS IS ITS OWN DOCUMENT, and not a field on Order:
 *
 *   The order that represents the car DIES. A street-cleaning move mints a
 *   return leg (controllers/orderController.js runAspSweep), and completing
 *   that leg drives both the leg and its parent to 'completed' (:1533 → :1563).
 *   After one move there is no live order anywhere pointing at the car. A field
 *   on Order cannot survive that; this row can, and hops to the new order.
 *
 * WHY IT IS NOT INFERRED FROM Order.status:
 *
 *   That field is deliberately overloaded. 'parked-with-keys' was collapsed into
 *   'parked' by a schema setter (models/Order.js:98); enterprise parks reach
 *   'parked' while the FRONT DESK holds the keys; and cancelRetrievalLeg
 *   completes an order whose car is still standing on the street. Custody is a
 *   fact we write down, not a status we read off something else.
 *
 * A ticket on a managed car is ours (Rishi's call, 2026-09-02). That is why the
 * alert stamps below are declared schema paths and why `spots` is append-only.
 */

/**
 * A sweep window in the shape this system dispatches on.
 *
 * ParkingNote and StreetParkingMark store `{day, startTime:'HH:MM', endTime}`,
 * while every scheduler in this repo speaks `{weekday, hour, minute}`
 * (models/Subscription.js aspSchedule.days, Order.awayDays). The translation
 * happens exactly ONCE, at capture, by services/sweepWindows.js — so that
 * nothing is parsing a string at 8:29 on a Monday morning with a sweeper
 * already on the block.
 */
const SweepWindowSchema = new mongoose.Schema(
    {
        weekday: { type: Number, min: 0, max: 6, required: true }, // 0 = Sunday
        hour: { type: Number, min: 0, max: 23, required: true },
        minute: { type: Number, min: 0, max: 59, required: true },
        // The end of the window, so the watchdog can tell "a sweep is due" from
        // "a sweep is happening right now and a ticket is being written".
        endHour: { type: Number, min: 0, max: 23 },
        endMinute: { type: Number, min: 0, max: 59 },
    },
    { _id: false }
);

/**
 * One entry per parking event, appended and never rewritten.
 *
 * This is the ticket-dispute file. If a ticket lands on day 45 for a block the
 * car left three moves ago, nothing else can say what the sign read: the
 * ParkingNote is upserted per order so the old rules are gone, and its sign
 * photo has already been wiped by the 30-day expiry cron
 * (services/parkingPhotoExpiry.js). This array is the only surviving record.
 */
const SpotSchema = new mongoose.Schema(
    {
        seq: { type: Number, required: true },
        order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
        lat: { type: Number },
        lng: { type: Number },
        streetAddress: { type: String },
        tileKey: { type: String },
        windows: { type: [SweepWindowSchema], default: [] },
        rulesSource: { type: String },
        disputed: { type: Boolean, default: false },
        noteId: { type: mongoose.Schema.Types.ObjectId, ref: 'ParkingNote' },
        rulesCapturedAt: { type: Date },
        arrivedAt: { type: Date },
        departedAt: { type: Date },
    },
    { _id: false }
);

const CurbCustodySchema = new mongoose.Schema(
    {
        customer: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        subscription: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Subscription',
            required: true,
        },
        // street_cleaning is deliberately absent. That plan is sold by the move
        // against days the customer typed, services/subscriptionScheduler.js
        // owns it, and nothing here may ever touch it.
        tier: {
            type: String,
            enum: ['home_garage', 'valet_anywhere'],
            required: true,
        },

        // The order the car is currently sitting under. Hops when a sweep move
        // mints a new one; the row itself lives until the car goes back.
        currentOrder: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Order',
            required: true,
        },
        // Every order this car has passed through, oldest first.
        orderChain: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Order' }],

        // Snapshotted rather than read off the order, because valetCancelOrder
        // blanks `order.valet` when a valet drops an accepted job
        // (controllers/orderController.js:3710-3717).
        valet: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

        /**
         * The one field the admin tab reads, so nobody has to derive a car's
         * status client-side from four other fields.
         *
         *   resolving — parked; we have not read the block yet
         *   armed     — we know the sweep windows and the next move is scheduled
         *   blind     — parked, and we cannot read this block. AN ALARM STATE.
         *   moving    — a move is booked or pushed for the occurrence now due
         *   releasing — the customer has asked for the car back
         *   closed    — closedAt is set
         */
        state: {
            type: String,
            enum: ['resolving', 'armed', 'blind', 'moving', 'releasing', 'closed'],
            default: 'resolving',
            index: true,
        },

        /**
         * Who has the keys. Recorded, never inferred.
         *
         *   'customer' — the default, and the safe side. The keys went back at
         *                park close-out, which is what park-and-hold does today
         *                on every one of these plans. A sweep move therefore
         *                needs a real booked ASP order.
         *   'valet'    — we are holding them. A sweep move is then only a push
         *                to the valet who already has them, and they re-park
         *                through the same order — the shape away mode runs.
         *
         * Defaulting to 'customer' is the fail direction that matters: assuming
         * keys we do not have sends a valet to a locked car. The valet-holds-the-
         * keys flow is specified but deliberately unbuilt, so nothing sets
         * 'valet' yet; the dispatcher already handles it for when it lands.
         */
        keysWith: {
            type: String,
            enum: ['customer', 'valet'],
            default: 'customer',
        },
        keysWithSetAt: { type: Date },

        // Where the car is right now.
        spot: {
            lat: { type: Number },
            lng: { type: Number },
            streetAddress: { type: String },
            // ~1-block grid cell, lat/lng rounded to 0.001°. The same identity
            // StreetParkingMark uses. Pure arithmetic, so it is available when
            // Overpass is not — and resolveBlockSegment has no retry, a cache
            // that dies on every deploy, and returns null on failure, which is
            // indistinguishable from "no rules here".
            tileKey: { type: String, index: true },
            // Best-effort enrichment, captured at note-write time only, never
            // on the dispatch path.
            segmentKey: { type: String },
        },
        spotSince: { type: Date },

        spots: { type: [SpotSchema], default: [] },

        rules: {
            /**
             * 'note'         — a valet stood at this car and photographed this sign
             * 'block'        — another valet's note on the same block face
             * 'mark'         — StreetParkingMark consensus for the tile
             * 'operator'     — a human typed it into the admin console
             * 'none_on_sign' — a valet read the sign: no street cleaning here
             * 'off_street'   — garage, driveway, private lot; sweeps do not apply
             * 'unknown'      — we do not know. An alarm, never a green light.
             *
             * An empty `streetCleaning: []` on a legacy note means BOTH "no
             * cleaning on this sign" and "the valet skipped the field", and
             * nothing can tell them apart. It stays 'unknown' forever. Reading
             * it as "no sweep needed" would reproduce, in a new place, exactly
             * the silent skip this whole build exists to fix.
             */
            source: {
                type: String,
                enum: [
                    'note',
                    'block',
                    'mark',
                    'operator',
                    'none_on_sign',
                    'off_street',
                    'unknown',
                ],
                default: 'unknown',
            },
            windows: { type: [SweepWindowSchema], default: [] },
            capturedAt: { type: Date },
            noteId: { type: mongoose.Schema.Types.ObjectId, ref: 'ParkingNote' },
            // Two readings of one block that disagree. We dispatch on the UNION:
            // moving needlessly costs one valet fee, missing costs a $65 ticket
            // we have said we eat. Same asymmetry services/aspSuspensions.js
            // reasons from.
            disputed: { type: Boolean, default: false },
            disputeDetail: { type: String },
            // How many windows the converter could not parse. "We read three and
            // understood two" is a different fact from "there were two".
            droppedWindows: { type: Number, default: 0 },
        },

        // Per-occurrence dedupe for the push path: '<NY date>:<HH>:<MM>'. Same
        // shape as Order.awayReminderLastKey, for the same reason.
        lastMoveReminderKey: { type: String },
        // What the spot was when we told someone to move it, so the watchdog can
        // ask "did the car actually move?" without a second source of truth.
        reminderSpotKey: { type: String },
        reminderSentAt: { type: Date },

        movesThisPeriod: { type: Number, default: 0 },
        lastMoveAt: { type: Date },

        // The plan stopped paying while we still had the car. We keep moving it.
        planEndedAt: { type: Date },

        /**
         * Alert dedupe, as 'YYYY-MM-DD' New York date keys rather than booleans:
         * one alert per car per day, and a car re-parked tomorrow onto a second
         * unreadable block is worth saying again.
         *
         * These are DECLARED paths on purpose. services/parkingAlerts.js stamps
         * `endingSoonAlert` and `aspCustomerNotificationSent`, neither of which
         * exists on the Order schema — and Order runs mongoose strict mode, so
         * those writes go nowhere. That service has never been registered, which
         * is the only reason it has not re-sent the same alert every 60 seconds.
         */
        alerts: {
            noRulesOn: { type: String },
            disputedOn: { type: String },
            planEndedOn: { type: String },
            unclaimedOn: { type: String },
            didNotMoveOn: { type: String },
            costOn: { type: String },
            inProgressOn: { type: String },
            driftedOn: { type: String },
            backfilledOn: { type: String },
        },

        // Mirror of `currentOrder` while this row is open, unset once it is
        // closed. See the index note at the bottom of this file — this exists
        // because a partial index cannot express "not closed".
        openKey: { type: String },

        openedAt: { type: Date, default: Date.now },
        closedAt: { type: Date },
        closeReason: {
            type: String,
            enum: [
                'retrieved',
                'enterprise_key_return',
                'cancelled',
                'car_gone',
                'operator',
                'superseded',
            ],
        },
    },
    { timestamps: true }
);

/**
 * The uniqueness guarantee: one OPEN custody row per order.
 *
 * Deliberately per ORDER and not per customer — a two-car household is legal,
 * and a unique {customer, open} index would silently refuse to record the
 * second car, which is the exact failure this model exists to prevent.
 *
 * It is expressed as a sparse index over a mirror field rather than as
 * `partialFilterExpression: { closedAt: { $exists: false } }`, because MongoDB
 * rejects that outright: `$exists: false` compiles to `$not`, which partial
 * indexes do not support. Written the obvious way, the index is never built and
 * the guarantee quietly does not exist. `openKey` holds the current order id
 * while the row is open and is unset the moment it closes, so a closed row drops
 * out of the sparse index and the same car can be managed again later.
 */
CurbCustodySchema.index({ openKey: 1 }, { unique: true, sparse: true });

CurbCustodySchema.pre('save', function syncOpenKey(next) {
    if (this.closedAt) this.openKey = undefined;
    else this.openKey = String(this.currentOrder);
    next();
});
CurbCustodySchema.index({ closedAt: 1, 'spot.tileKey': 1 });
CurbCustodySchema.index({ customer: 1, closedAt: 1 });
CurbCustodySchema.index({ state: 1, closedAt: 1 });

module.exports = mongoose.model('CurbCustody', CurbCustodySchema);
