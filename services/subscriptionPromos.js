// Subscription promo codes (2026-08-20).
//
// HANDSFREE is the trial code: the first month of the $50 street-cleaning
// plan is on us, and the plan renews at the normal price after it.
// HANDSFREE2 is the same offer for the block that is swept twice a week —
// the $100 two-move plan.
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
        // week. The two-move plan has its own code, HANDSFREE2.
        appliesTo: { tier: 'street_cleaning', interval: 'month', movesPerWeek: 1 },
        // A trial is for people who have not tried it. One per customer,
        // and only before their first plan ever starts.
        firstTimeOnly: true,
        active: true,
    },

    // The same free month for a block that is swept twice a week: two covered
    // moves instead of one, $100/mo instead of $50.
    //
    // It is a second code rather than a widening of HANDSFREE. A promo whose
    // appliesTo leaves movesPerWeek open has nothing to snap the customer
    // onto — `applyTo` goes back to the app with movesPerWeek undefined, the
    // review screen falls through to a quantity of one, and the customer is
    // shown $50 for a plan that will bill $100 the month the trial ends. A
    // code that lies about the price it converts to is worse than no code.
    HANDSFREE2: {
        code: 'HANDSFREE2',
        kind: 'free_trial',
        trialDays: 30,
        headline: 'First month free',
        detail:
            'Your first month of street-cleaning moves is on us — both days a week. Cancel any time before it ends and you are never charged.',
        appliesTo: { tier: 'street_cleaning', interval: 'month', movesPerWeek: 2 },
        firstTimeOnly: true,
        active: true,
    },

    // The same free month on the Fixed garage plan — the $250 one, where the
    // covered moves come with a free park and retrieval every day at one spot.
    //
    // It exists because the plan is the hardest of the three to buy on faith:
    // $250 is four times the street-cleaning plan, and the part that justifies
    // it is the daily park, which nobody believes until they have used it for a
    // few weeks. A month of actually living with it is the argument.
    //
    // Fixed garage is not a per-move plan (subscriptionPlans.js), so quantity
    // is always 1 and `movesPerWeek` is deliberately absent from appliesTo —
    // pinning it would make the code refuse the only plan it is for.
    LOLGARAGE: {
        code: 'LOLGARAGE',
        kind: 'free_trial',
        trialDays: 30,
        headline: 'First month free',
        detail:
            'Your first month of Fixed garage is on us — the street-cleaning moves and a free park and retrieval every day at your spot. Cancel any time before it ends and you are never charged.',
        appliesTo: { tier: 'home_garage', interval: 'month' },
        firstTimeOnly: true,
        active: true,
    },

    // A second door onto the same free month of Fixed garage. Nothing about
    // the offer differs from LOLGARAGE — it exists so one code can be handed
    // out in a place the other one has not been, and so the Subscribers tab
    // says which one brought the customer in (`Subscription.promoCode`).
    //
    // A code here has no redemption cap of its own; firstTimeOnly is per
    // customer, not per code, so someone who has already started any plan is
    // turned away by this one exactly as they are by LOLGARAGE.
    PARKONME: {
        code: 'PARKONME',
        kind: 'free_trial',
        trialDays: 30,
        headline: 'First month free',
        detail:
            'Your first month of Fixed garage is on us — the street-cleaning moves and a free park and retrieval every day at your spot. Cancel any time before it ends and you are never charged.',
        appliesTo: { tier: 'home_garage', interval: 'month' },
        firstTimeOnly: true,
        active: true,
    },
};

// Codes are typed by hand on a phone. Inner spaces and dashes are the
// customer's, not the code's — "hands free 2" and "HANDSFREE-2" are both
// HANDSFREE2, and a code that turns those away only generates a support text.
function normalizeCode(code) {
    return String(code || '')
        .replace(/[\s-]+/g, '')
        .toUpperCase();
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
    // Describe the plan the code actually covers. This sentence used to be
    // written for HANDSFREE alone and said "one move a week, billed monthly"
    // no matter which promo produced it — with a second code in the table it
    // would have told a two-move customer the wrong thing about their own
    // offer.
    const unit = wants.interval === 'week' ? 'week' : 'month';
    // Only a per-move plan is bought by the move. Spelling a weekly cadence on
    // a flat plan describes a product we do not sell — LOLGARAGE is for Fixed
    // garage, which has no moves-per-week to name, and would otherwise be
    // advertised to the customer as "one move a week" at $250.
    const perMove = plan && plan.perMove;
    if (!perMove) {
        return `${promo.code} covers the ${name} plan at $${dollars} a ${unit}.`;
    }
    const moves = wants.movesPerWeek || 1;
    const spelled = ['', 'one', 'two', 'three', 'four'][moves] || String(moves);
    const cadence = `${spelled} move${moves === 1 ? '' : 's'} a week`;
    return `${promo.code} covers the ${name} plan at $${dollars} a ${unit} — ${cadence}.`;
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
