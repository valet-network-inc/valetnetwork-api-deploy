const mongoose = require('mongoose');

// Subscriptions v2 (2026-08-14): Stripe Billing recurring plans.
//
// Three tiers, weekly or monthly. The Stripe subscription object is the
// billing source of truth; this doc mirrors the state we act on (webhooks
// keep it in sync) plus the service-side config Stripe knows nothing about:
// the customer's street-cleaning schedule and home address.
//
// The pre-v2 doorman-referral schema (subscriptionType Standard/Garage,
// nextBillingDate, commission fields) is retired. Old docs — there is one
// seeded test doc in prod — have no `status` field and therefore never match
// v2 queries, which always filter on status.
const SubscriptionSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        tier: {
            type: String,
            enum: ['street_cleaning', 'home_garage', 'valet_anywhere'],
            required: true,
        },
        interval: {
            type: String,
            enum: ['week', 'month'],
            required: true,
        },
        // Mirrors the Stripe subscription lifecycle. Entitlements exist only
        // while 'active'; 'past_due' pauses them (Stripe keeps retrying the
        // card); 'cancelled' is terminal.
        status: {
            type: String,
            enum: ['incomplete', 'active', 'past_due', 'cancelled'],
            default: 'incomplete',
        },
        amountCents: {
            type: Number,
            required: true,
        },
        stripeCustomerId: {
            type: String,
        },
        stripeSubscriptionId: {
            type: String,
            unique: true,
            sparse: true,
        },
        stripePriceId: {
            type: String,
        },
        currentPeriodStart: {
            type: Date,
        },
        currentPeriodEnd: {
            type: Date,
        },
        cancelAtPeriodEnd: {
            type: Boolean,
            default: false,
        },
        cancelledAt: {
            type: Date,
        },
        // Street-cleaning schedule driving the auto-ASP scheduler. Times are
        // the sweep start in America/New_York local clock time.
        aspSchedule: {
            address: {
                streetAddress: { type: String },
                lat: { type: Number },
                lng: { type: Number },
            },
            days: [
                {
                    _id: false,
                    weekday: { type: Number, min: 0, max: 6 }, // 0 = Sunday (JS convention)
                    hour: { type: Number, min: 0, max: 23 },
                    minute: { type: Number, min: 0, max: 59 },
                },
            ],
            source: {
                type: String,
                enum: ['onboarding', 'first_booking', 'edited'],
                default: 'onboarding',
            },
        },
        // Where the free daily park+retrieval applies for home_garage.
        homeAddress: {
            streetAddress: { type: String },
            lat: { type: Number },
            lng: { type: Number },
        },
        // Every settled Stripe invoice, for the value indicator's "what you
        // paid" side. Usage lives on Order.coveredBySubscription.
        payments: [
            {
                _id: false,
                invoiceId: { type: String },
                amountCents: { type: Number },
                paidAt: { type: Date },
            },
        ],
    },
    {
        timestamps: true,
    }
);

SubscriptionSchema.index({ user: 1, status: 1 });

// One live subscription per user, enforced by the database. Concurrent
// purchases both pass the app-level check; the second activation hits this
// index and activateLocal voids it on Stripe instead of double-billing.
SubscriptionSchema.index(
    { user: 1 },
    {
        unique: true,
        partialFilterExpression: { status: { $in: ['active', 'past_due'] } },
    }
);

module.exports = mongoose.model('Subscription', SubscriptionSchema);
