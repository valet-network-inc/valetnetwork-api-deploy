const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
    customer: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    customerLocation: {
        lat: {
            type: Number,
            required: true,
        },
        lng: {
            type: Number,
            required: true,
        },
        streetAddress: {
            type: String,
            required: true,
        },
    },
    parkingType: {
        type: String,
        required: true,
        enum: ['street', 'garage', 'private', 'retrieval'],
        default: 'street',
    },
    orderType: {
        type: String,
        enum: ['parking', 'retrieval'],
        default: 'parking',
    },
    parkingLocation: {
        lat: {
            type: Number,
        },
        lng: {
            type: Number,
        },
        streetAddress: {
            type: String,
        },
    },

    // Where the keys physically changed hands at order start. Recorded by
    // the valet the moment they take possession of the keys. Used as the
    // default retrieval coordinate (build 11) and as the stable "key
    // pickup location" anchor for build 12's pre-positioned dispatch
    // math (walk + walk + drive).
    keyDropoffLocation: {
        lat: { type: Number },
        lng: { type: Number },
        streetAddress: { type: String },
        recordedAt: { type: Date },
    },

    duration: { type: Number, required: true }, // Duration in minutes

    // Customer-initiated duration extensions. Each row is one paid extension
    // event. Pricing tier: $5 first additional hour, +$1 each after — billed
    // as a separate Stripe charge per extension (not a top-up of the
    // original PaymentIntent which is already captured).
    extensions: [
        {
            additionalHours: { type: Number, required: true },
            amountCents: { type: Number, required: true },
            paymentIntentId: { type: String, required: true },
            chargedAt: { type: Date, required: true },
            requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        },
    ],
    pickUpTime: { type: Date, required: true },
    valet: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    valetLocation: {
        lat: {
            type: Number,
        },
        lng: {
            type: Number,
        },
        streetAddress: {
            type: String,
        },
    },
    status: {
        type: String,
        required: true,
        // One parked state. A park ends with the keys back in the customer's
        // hand — always — so there is nothing to distinguish. Whether that
        // handoff has happened yet is `otpVerifiedTimes.returnKey`; whether a
        // return trip is already paid for is `serviceType`.
        enum: ['pending', 'accepted', 'in-progress', 'in_progress', 'parked', 'keys-returning', 'completed', 'cancelled'],
        // Phones still running the App Store build send the retired
        // 'parked-with-keys' when a valet finishes a park. Fold it in rather
        // than rejecting it — a hard 400 here would strand those valets
        // mid-park until they updated. Nothing ever reads it back out.
        set: (v) => (v === 'parked-with-keys' ? 'parked' : v),
        default: 'pending',
    },
    paymentMethod: {
        type: String,
        enum: ['card', 'pm_card_visa', 'Apple Pay'],
        required: true,
    },
    totalAmount: { type: Number, required: true }, // Total amount in cents
    paymentStatus: {
        type: String,
        enum: ['pending', 'paid', 'failed'],
        default: 'pending',
    },
    paymentIntentId: { type: String },
    // Checkout funnel, stamped entirely server-side — no client release needed.
    //
    // Between Aug 4 and Aug 13 2026 every paid order died somewhere after the
    // order was created and before a card was charged, and there was no way to
    // tell "customer walked away" from "the charge failed". These three
    // timestamps split that black box using calls the backend already receives:
    // the order POST, the create-intent POST, and the Stripe webhook.
    //
    // What it still cannot see is whether the card form rendered or was ever
    // touched — that lives in the browser and would need a client change.
    checkout: {
        intentCreatedAt: { type: Date },
        paidAt: { type: Date },
        failedAt: { type: Date },
        // Stripe's decline code and message, e.g. 'card_declined' /
        // 'insufficient_funds'. Absent failure rows mean no card was submitted
        // at all — Stripe records nothing when the customer never tries.
        failureCode: { type: String },
        failureMessage: { type: String },
    },
    paymentDetails: {
        amount: { type: Number }, // Amount in cents
        currency: { type: String, default: 'usd' },
        clientSecret: { type: String },
        chargeId: { type: String }, // Stripe charge ID
        receiptUrl: { type: String }, // Stripe receipt URL
        paymentMethodDetails: {
            type: { type: String }, // card, apple_pay, etc.
            last4: { type: String }, // Last 4 digits of card
            brand: { type: String }, // Card brand (visa, mastercard, etc.)
        },
        paidAt: { type: Date }, // When payment was completed
        failureReason: { type: String }, // Reason if payment failed
    },
    conversationId: { type: String },
    review: {
        rating: { type: Number, min: 0, max: 5 },
        comment: { type: String },
    },
    // Enterprise (doorman) account — end-customer details entered by the enterprise user at summon time.
    // When these are present, the valet's app displays them in place of the order creator's info.
    endCustomerName: {
        type: String,
    },
    endCustomerPhone: {
        type: String,
    },
    // Enterprise feature fields
    eventCode: {
        type: String, // Code for enterprise events (e.g., wedding, conference)
    },
    isFreeService: {
        type: Boolean,
        default: false, // Whether this service is free for enterprise event attendees
    },
    serviceType: {
        type: String,
        enum: ['standard', 'park-and-hold'], // park-and-hold keeps keys with valet
        default: 'standard',
    },
    // Car Watch add-on: customer paid $1/hr for a valet to keep eyes on the
    // parked car (deter tickets/damage/break-ins + be a witness). When true,
    // the valet's order view flags it so they know to watch the vehicle.
    carWatch: {
        type: Boolean,
        default: false,
    },
    carWatchAmount: {
        type: Number, // Car Watch portion of totalAmount, in cents
        default: 0,
    },
    linkedOrderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Order', // Links parking order to its retrieval order
    },
    // Subscriptions v2: set when a plan entitlement made this order $0.
    // listPriceCents preserves what the order would have cost at per-use
    // rates — the usage side of the subscriber's value indicator.
    coveredBySubscription: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Subscription',
    },
    listPriceCents: {
        type: Number,
    },
    // Away mode (2026-08-14): a multi-day park-and-hold. Keys are collected
    // once at the start (standard collect OTP), held for the whole window,
    // and returned at asp_time — which for away orders is the customer's
    // RETURN date, so the existing sweep job's auto-return machinery closes
    // it out with the return-key OTP. awayDays holds the street-cleaning
    // slots to move the car for while they're gone (empty = just hold it);
    // awayReminderLastKey dedupes the valet's per-occurrence move reminders.
    awayMode: {
        type: Boolean,
        default: false,
    },
    awayDays: [
        {
            _id: false,
            weekday: { type: Number, min: 0, max: 6 }, // 0 = Sunday
            hour: { type: Number, min: 0, max: 23 },
            minute: { type: Number, min: 0, max: 59 },
        },
    ],
    awayReminderLastKey: {
        type: String,
    },
    // Which away service was bought: scheduled street-cleaning moves (billed
    // per move, reconciled when the schedule is set/corrected) or a flat
    // hold (billed per day at booking).
    awayService: {
        type: String,
        enum: ['moves', 'hold'],
    },
    // What has actually been charged for this away order so far. The
    // schedule reconciler charges/refunds the difference against this when
    // the valet sets or corrects the sweep days.
    awayPaidCents: {
        type: Number,
    },
    // Every charge taken for an away order, oldest first: the $1 deposit,
    // then whatever the valet's schedule added. Refunds walk this ledger —
    // paymentIntentId alone only points at the deposit, so refunding it
    // would strand the larger balance charge.
    awayCharges: [
        {
            _id: false,
            paymentIntentId: { type: String },
            amountCents: { type: Number },
            refundedCents: { type: Number, default: 0 },
            at: { type: Date },
        },
    ],
    awayBilling: {
        status: {
            type: String,
            enum: ['pending_schedule', 'settled', 'charge_failed', 'refund_failed'],
        },
        lastDeltaCents: { type: Number },
        at: { type: Date },
        error: { type: String },
    },
    // Auto-ASP scheduler idempotency key: `asp:<subscriptionId>:<NY date>:<HHMM>`.
    // The unique sparse index makes duplicate auto-bookings a DB-level
    // impossibility — a second creation attempt for the same occurrence
    // throws E11000 no matter how many scheduler ticks race.
    autoBookKey: {
        type: String,
    },
    // When the valet closed the park out ("Swipe to End Order"). This is what
    // takes the job off their screen — the key handoff alone doesn't, because
    // the swipe still has to happen after it. Older clients signal this by
    // sending the retired 'parked-with-keys'; `updateOrder` translates that.
    parkClosedAt: {
        type: Date,
    },

    // Key-return handoff. Enterprise / front desk generates a short-lived
    // OTP; valet types it after physically dropping the keys to confirm
    // the handoff. Required gate for park-and-hold orders to reach
    // `completed`. Drives the insurance trail — the order can't close
    // until someone at the receiving end vouches for the key handoff.
    keyReturn: {
        otp: { type: String },               // 4-digit code, plain (short-lived)
        otpGeneratedAt: { type: Date },
        otpExpiresAt: { type: Date },        // typically generatedAt + 15 min
        otpAttempts: { type: Number, default: 0 },
        completedAt: { type: Date },
        // Who generated and who verified — useful for audit
        generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    // Vehicle information for car tracking/shuffling
    vehicle: {
        color: {
            type: String,
            trim: true,
        },
        model: {
            type: String,
            trim: true,
        },
        licensePlate: {
            type: String,
            trim: true,
            uppercase: true,
        },
        keyTagNumber: {
            type: String,
            trim: true,
        },
    },
    // OTP for order completion confirmation
    otp: {
        code: {
            type: String,
        },
        createdAt: {
            type: Date,
        },
        expiresAt: {
            type: Date,
        },
        verified: {
            type: Boolean,
            default: false,
        },
        verifiedAt: {
            type: Date,
        },
        type: {
            type: String,
            enum: ['order_creation', 'parking_location', 'return_key'],
        },
    },
    // A handoff the valet vouched for instead of the customer typing a code.
    //
    // It happens: the customer walks away before the ritual, and the valet is
    // standing there having just identified them face to face. The order still
    // has to close. Recording it here keeps `otp` honest — the code stays
    // unverified, because nobody entered it — while leaving a trail that says
    // who overrode the step and why. Never write this to stand in for a
    // customer action that did happen; that belongs in `otpVerifiedTimes`.
    otpOverride: {
        bypassedAt: { type: Date },
        bypassedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        method: { type: String },   // e.g. 'in-person-identity-check'
        note: { type: String },
    },
    otpVerifiedTimes: {
        orderCreation: {
            type: Date,
        },
        parkingLocation: {
            type: Date,
        },
        returnKey: {
            type: Date,
        },
    },
    aspMode: {
        type: Boolean,
        default: false,
    },
    asp_time: {
        type: Date,
    },
    aspNotificationSent: {
        type: Boolean,
        default: false,
    },
    aspOrderCreated: {
        type: Boolean,
        default: false,
    },
    notifiedValets: [{
        valet: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        notifiedAt: {
            type: Date,
        },
        accepted: {
            type: Boolean,
            default: false,
        },
        acceptedAt: {
            type: Date,
        },
    }],
    // --- Advance bookings --------------------------------------------------
    // When services/scheduledDispatch.js actually put this order in front of
    // valets. Only ever set on a booking made for later: a book-it-now order
    // is dispatched by the client the moment the card clears, and is
    // recognised by its already-populated `notifiedValets`. Absent on every
    // order written before advance dispatch shipped, which is exactly what
    // lets the job adopt them.
    dispatchedAt: {
        type: Date,
    },
    dispatchAttempts: {
        type: Number,
        default: 0,
    },
    dispatchError: {
        type: String,
    },
    // Set once when a booking's slot is nearly here and no valet has taken it.
    // Its only job is to keep that alert to one, not one a minute.
    dispatchEscalatedAt: {
        type: Date,
    },
    acceptanceLocation: {
        lat: {
            type: Number,
        },
        lng: {
            type: Number,
        },
    },
    pickupDistance: {
        type: Number, // Distance in meters from valet to customer at acceptance
    },
    parkedAt: {
        type: Date, // Timestamp when valet updated parking location
    },
    // Top-level timestamp of when the assigned valet accepted the order. Used by
    // the valet-cancel cooldown logic (valet can only cancel after a few minutes).
    acceptedAt: {
        type: Date,
    },
    // True once the valet has been credited for this order's earnings.
    // Used to ensure idempotency — re-saving a completed order won't double-pay.
    creditedValet: {
        type: Boolean,
        default: false,
    },
    // --- Park & Retrieve: the customer called off the prepaid return trip ---
    // Set by cancelRetrievalLeg. Deliberately additive: totalAmount,
    // serviceType and paymentStatus are left alone, because every receipt and
    // tip-base calculation on both clients carves the retrieval portion out of
    // a park-and-hold total itself. Editing the total would make the parking
    // receipt read $7 instead of $10.
    retrievalCancelled: {
        type: Boolean,
        default: false,
    },
    retrievalCancelledAt: {
        type: Date,
    },
    // The one place a refund is recorded anywhere in this system. Stripe is
    // otherwise the only record that money went back.
    retrievalRefund: {
        amountCents: { type: Number },
        refundId: { type: String },
        status: { type: String },
        refundedAt: { type: Date },
    },
}, {
    timestamps: true, // Adds createdAt and updatedAt automatically
});

/**
 * Speak the old dialect to old clients.
 *
 * We store ONE parked state. Every app and web build shipped before this
 * change instead looks for `parked-with-keys` to mean "the valet has finished
 * and closed out, the keys are with the customer, and a return trip is still
 * owed" — it's what gates the customer's free "bring it back" control and what
 * tells the valet the job is off their plate. Sending those clients a bare
 * `parked` silently costs the customer a return they already paid for.
 *
 * So the wire format keeps the old word for exactly that situation while the
 * database keeps one state. Clients from this change onward normalise it back
 * on the way in, so it reads as `parked` to them.
 *
 * REMOVE once App Store, TestFlight and web are all past the collapse.
 */
const speaksOldDialect = (o) =>
    o &&
    o.status === 'parked' &&
    o.orderType === 'parking' &&
    o.serviceType === 'park-and-hold' &&
    !!o.parkClosedAt;

OrderSchema.set('toJSON', {
    transform: (doc, ret) => {
        if (speaksOldDialect(ret)) ret.status = 'parked-with-keys';
        return ret;
    },
});

// The scheduler's duplicate-order guarantee (sparse: only auto-booked orders
// carry the key) plus the two lookups every scheduler/coverage query makes.
OrderSchema.index({ autoBookKey: 1 }, { unique: true, sparse: true });
OrderSchema.index({ customer: 1, status: 1 });
OrderSchema.index({ coveredBySubscription: 1, createdAt: -1 }, { sparse: true });

module.exports = mongoose.model('Order', OrderSchema);
