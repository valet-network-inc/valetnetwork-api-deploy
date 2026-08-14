// Subscriptions v2 plan catalog (2026-08-14).
//
// Weekly price is 30% of monthly across every tier — the same ratio Rishi set
// on ASP ($30/wk vs $100/mo), applied to the other two. Monthly is therefore
// ~23% cheaper than paying weekly. Stripe prices are minted from this table by
// scripts/ensureSubscriptionCatalog.js and matched at runtime by lookup_key.
//
// Entitlements are cumulative up the tier ladder:
//   street_cleaning  → up to 2 covered street-cleaning moves per week
//                      (auto-scheduled, or manual ASP bookings — both count)
//   home_garage      → + first park (+its retrieval) of each day free at the
//                      customer's home address
//   valet_anywhere   → + that free daily park works anywhere we operate

const TIERS = ['street_cleaning', 'home_garage', 'valet_anywhere'];

const PLANS = {
    street_cleaning: {
        tier: 'street_cleaning',
        name: 'Street cleaning moves',
        blurb: 'Your car moves itself for street cleaning — as often as your block needs.',
        features: [
            'Pick 1 or 2 covered moves a week to match your sign',
            'Valet takes the car, waits out the sweep, parks it back',
            'You never touch the app on cleaning day',
        ],
        // Priced PER WEEKLY MOVE via Stripe quantity: 1 move = $15/wk or
        // $50/mo, 2 moves = $30/wk or $100/mo (weekly stays 30% of monthly).
        perMove: true,
        weekly: { amountCents: 1500, lookupKey: 'vn_street_move_weekly' },
        monthly: { amountCents: 5000, lookupKey: 'vn_street_move_monthly' },
        rank: 1,
    },
    home_garage: {
        tier: 'home_garage',
        name: 'Fixed garage',
        blurb: 'Everything in Street cleaning, plus a free park & retrieval every day at your fixed spot.',
        features: [
            'Everything in Street cleaning moves',
            'Pick one fixed spot — first park & retrieval there is free every day',
            'The spot can be changed once a month',
        ],
        weekly: { amountCents: 7500, lookupKey: 'vn_home_garage_weekly' },
        monthly: { amountCents: 25000, lookupKey: 'vn_home_garage_monthly' },
        rank: 2,
    },
    valet_anywhere: {
        tier: 'valet_anywhere',
        name: 'Valet anywhere',
        blurb: 'Home garage, but your free daily park works anywhere we operate.',
        features: [
            'Everything in Home garage',
            'Free daily park & retrieval anywhere in the service area',
            'Coverage grows as we do',
        ],
        weekly: { amountCents: 9000, lookupKey: 'vn_valet_anywhere_weekly' },
        monthly: { amountCents: 30000, lookupKey: 'vn_valet_anywhere_monthly' },
        rank: 3,
    },
};

// Covered street-cleaning moves per calendar week (NY time, Monday start).
const ASP_MOVES_PER_WEEK = 2;

// How far from the stored home address a park still counts as "at home"
// for the home_garage tier. GPS pins drift; a block is ~80m.
const HOME_RADIUS_METERS = 250;

function getPlan(tier) {
    return PLANS[tier] || null;
}

function priceFor(tier, interval) {
    const plan = getPlan(tier);
    if (!plan) return null;
    if (interval === 'week') return plan.weekly;
    if (interval === 'month') return plan.monthly;
    return null;
}

function tierRank(tier) {
    const plan = getPlan(tier);
    return plan ? plan.rank : 0;
}

module.exports = {
    TIERS,
    PLANS,
    ASP_MOVES_PER_WEEK,
    HOME_RADIUS_METERS,
    getPlan,
    priceFor,
    tierRank,
};
