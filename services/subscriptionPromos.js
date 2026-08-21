// Subscription promo codes (2026-08-20).
//
// HANDSFREE is the trial code: the first month of the $50 street-cleaning
// plan is on us, and the plan renews at the normal price after it.
//
// It runs as a real Stripe TRIAL rather than a 100%-off coupon, because a
// coupon that zeroes the first invoice settles with no PaymentIntent — the
// customer never enters a card, so month two has nothing to charge and the
// plan lapses at the exact moment it was supposed to convert. A trial keeps
// the card on file from day one and bills itself when the free month ends,
// which is the only version of a free trial that is worth running.
//
// The customer-facing promise: free for 30 days, cancel before it ends and
// nothing is ever charged.

const { getPlan, priceFor } = require('./subscriptionPlans');
const Subscription = require('../models/Subscription');

const PROMOS = {
    HANDSFREE: {
        code: 'HANDSFREE',
        kind: 'free_trial',
        trialDays: 30,
        headline: 'First month free',
        detail:
            'Your first month of street-cleaning moves is on us. Cancel any time before it ends and you are never charged.',
        // Locked to the $50/mo plan: street cleaning, monthly, one move a
        // week. Widening it to the two-move ($100/mo) plan is a one-line
        // change to movesPerWeek below.
        appliesTo: { tier: 'street_cleaning', interval: 'month', movesPerWeek: 1 },
        // A trial is for people who have not tried it. One per customer,
        // and only before their first plan ever starts.
        firstTimeOnly: true,
        active: true,
    },
};

function normalizeCode(code) {
    return String(code || '').trim().toUpperCase();
}

// Codes configured in the environment as CODE:couponId. This is the older
// hook, kept because E2E runs against live mode lean on it to zero out a
// purchase; it attaches a Stripe coupon and collects a card the normal way.
function envCouponPromos() {
    return (process.env.SUB_PROMO_CODES || '')
        .split(',')
        .map((pair) => pair.trim().split(':'))
        .filter((pair) => pair.length === 2 && pair[0] && pair[1])
        .map(([code, couponId]) => ({
            code: normalizeCode(code),
            kind: 'coupon',
            couponId,
            headline: 'Code applied',
            detail: 'Your discount is applied at checkout.',
            appliesTo: null,
            firstTimeOnly: false,
            active: true,
        }));
}

function findPromo(code) {
    const c = normalizeCode(code);
    if (!c) return null;
    const promo = PROMOS[c];
    if (promo && promo.active) return promo;
    return envCouponPromos().find((p) => p.code === c) || null;
}

// Does the promo cover the plan the customer picked? Returns null when it
// does, or the sentence to show them when it does not.
function planMismatch(promo, { tier, interval, movesPerWeek }) {
    const wants = promo && promo.appliesTo;
    if (!wants) return null;
    const plan = getPlan(wants.tier);
    const price = priceFor(wants.tier, wants.interval);
    const dollars = price ? Math.round((price.amountCents * (wants.movesPerWeek || 1)) / 100) : null;
    const name = plan ? plan.name : wants.tier;
    const fits =
        (!wants.tier || tier === wants.tier) &&
        (!wants.interval || interval === wants.interval) &&
        (!wants.movesPerWeek || Number(movesPerWeek) === wants.movesPerWeek);
    if (fits) return null;
    return `${promo.code} covers the ${name} plan at $${dollars} a month — one move a week, billed monthly.`;
}

// Has this customer already had their free month? Trial codes are for a
// first plan, so a customer whose plan has ever started is past it.
async function promoRedemptionBlock(promo, userId) {
    if (!promo || !promo.firstTimeOnly || !userId) return null;
    // Only a plan that actually STARTED counts as a plan they have had. A
    // purchase abandoned at the payment sheet leaves a voided doc behind,
    // and that must not lock the customer out of their own free month when
    // they come back and try again.
    const prior = await Subscription.findOne({
        user: userId,
        $or: [{ activatedAt: { $exists: true, $ne: null } }, { 'payments.0': { $exists: true } }],
    })
        .select('_id promoCode')
        .lean();
    if (!prior) return null;
    return prior.promoCode === promo.code
        ? `You have already used ${promo.code}.`
        : `${promo.code} is for a first plan, and yours has already started once.`;
}

// What the customer is shown before they subscribe.
function describe(promo, { amountCents, interval, now = new Date() } = {}) {
    const base = {
        code: promo.code,
        kind: promo.kind,
        headline: promo.headline,
        detail: promo.detail,
    };
    if (promo.kind !== 'free_trial') {
        return { ...base, dueTodayCents: null, requiresCard: true };
    }
    const endsAt = new Date(now.getTime() + promo.trialDays * 24 * 60 * 60 * 1000);
    return {
        ...base,
        trialDays: promo.trialDays,
        trialEndsAt: endsAt,
        dueTodayCents: 0,
        // What lands on the card when the free month ends.
        thenCents: amountCents ?? null,
        thenInterval: interval || (promo.appliesTo && promo.appliesTo.interval) || 'month',
        // A card is taken up front so the plan converts instead of lapsing.
        requiresCard: true,
    };
}

module.exports = {
    PROMOS,
    normalizeCode,
    findPromo,
    planMismatch,
    promoRedemptionBlock,
    describe,
};
