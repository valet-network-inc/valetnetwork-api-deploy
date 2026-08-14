// Subscriptions v2 entitlement engine.
//
// Answers one question for order creation — "does this subscriber's plan make
// this order $0?" — and builds the status payload the app renders (next move,
// free-park-today flag, value indicator). The scheduler and createOrder both
// come through here so the rules live in exactly one place.

const Subscription = require('../models/Subscription');
const Order = require('../models/Order');
const PricingConfig = require('../models/PricingConfig');
const {
    ASP_MOVES_PER_WEEK,
    HOME_RADIUS_METERS,
    getPlan,
    tierRank,
} = require('./subscriptionPlans');
const { nyStartOfDay, nyStartOfWeek, nextNyOccurrence } = require('./nyTime');

// A day of grace over the paid period so a webhook that lands late doesn't
// strand an entitled subscriber; a truly lapsed sub flips to past_due /
// cancelled via webhook and fails the status check first.
const PERIOD_GRACE_MS = 24 * 60 * 60 * 1000;

function isEntitled(sub, now = new Date()) {
    if (!sub || sub.status !== 'active') return false;
    if (!sub.currentPeriodEnd) return true; // just-activated, period not synced yet
    return now.getTime() < sub.currentPeriodEnd.getTime() + PERIOD_GRACE_MS;
}

// The subscriber's live subscription doc, or null.
async function getActiveSubscription(userId, now = new Date()) {
    if (!userId) return null;
    const sub = await Subscription.findOne({
        user: userId,
        status: { $in: ['active', 'past_due'] },
    }).sort({ createdAt: -1 });
    return isEntitled(sub, now) ? sub : null;
}

function haversineMeters(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

// Covered street-cleaning moves already used this NY week (Mon-Sun).
// Counted by pickUpTime, not createdAt: the scheduler books up to 45 minutes
// ahead, so a just-past-midnight Monday sweep booked Sunday night must count
// against the week the move actually happens in.
async function aspMovesUsedThisWeek(sub, now = new Date()) {
    const weekStart = nyStartOfWeek(now);
    return Order.countDocuments({
        coveredBySubscription: sub._id,
        aspMode: true,
        orderType: 'parking',
        status: { $ne: 'cancelled' },
        pickUpTime: { $gte: weekStart },
    });
}

// Covered non-ASP parks already used today (NY day).
async function freeParksUsedToday(sub, now = new Date()) {
    const dayStart = nyStartOfDay(now);
    return Order.countDocuments({
        coveredBySubscription: sub._id,
        aspMode: { $ne: true },
        orderType: 'parking',
        status: { $ne: 'cancelled' },
        pickUpTime: { $gte: dayStart },
    });
}

// Server-side per-use price of a park order, for coverage stamps. Never trust
// the client's totalAmount for this — it feeds valet pay and the value
// indicator.
async function parkListPriceCents({ aspMode, serviceType }) {
    try {
        const cfg = await PricingConfig.getSingleton();
        if (aspMode) return cfg.aspCents || 1500;
        if (serviceType === 'park-and-hold') return cfg.parkAndRetrieveCents || 1300;
        return cfg.parkingCents || 1000;
    } catch (e) {
        return aspMode ? 1500 : serviceType === 'park-and-hold' ? 1300 : 1000;
    }
}

// The coverage decision for a parking order about to be created.
// Returns { covered, listPriceCents, reason } — reason is for logs/response
// copy, listPriceCents is what the order would have cost per-use.
async function evaluateParkCoverage(sub, { aspMode, lat, lng, listPriceCents }, now = new Date()) {
    if (!isEntitled(sub, now)) return { covered: false, reason: 'no_active_subscription' };

    if (aspMode) {
        const used = await aspMovesUsedThisWeek(sub, now);
        if (used >= (sub.movesPerWeek || ASP_MOVES_PER_WEEK)) {
            return { covered: false, reason: 'weekly_asp_limit_reached' };
        }
        return { covered: true, listPriceCents, reason: 'asp_move_covered' };
    }

    // Free daily park needs home_garage or better.
    if (tierRank(sub.tier) < tierRank('home_garage')) {
        return { covered: false, reason: 'tier_has_no_free_park' };
    }

    const used = await freeParksUsedToday(sub, now);
    if (used > 0) return { covered: false, reason: 'daily_free_park_used' };

    if (sub.tier === 'home_garage') {
        const home = sub.homeAddress;
        if (!home || typeof home.lat !== 'number' || typeof home.lng !== 'number') {
            return { covered: false, reason: 'no_home_address_on_file' };
        }
        if (typeof lat !== 'number' || typeof lng !== 'number') {
            return { covered: false, reason: 'order_location_missing' };
        }
        const meters = haversineMeters({ lat, lng }, { lat: home.lat, lng: home.lng });
        if (meters > HOME_RADIUS_METERS) {
            return { covered: false, reason: 'not_at_home_address' };
        }
    }

    return { covered: true, listPriceCents, reason: 'daily_free_park' };
}

// Next auto-ASP occurrence across the schedule, or null.
function nextAspMove(sub, now = new Date()) {
    const days = sub && sub.aspSchedule && sub.aspSchedule.days;
    if (!days || days.length === 0) return null;
    let best = null;
    for (const d of days) {
        const occ = nextNyOccurrence(d, now);
        if (occ && (!best || occ < best)) best = occ;
    }
    return best;
}

// Everything the app's subscription surfaces render.
async function buildStatusPayload(sub, now = new Date()) {
    const plan = getPlan(sub.tier);
    const entitled = isEntitled(sub, now);

    const [usageAgg, periodUsageAgg, aspUsed, parksUsed] = await Promise.all([
        Order.aggregate([
            {
                $match: {
                    coveredBySubscription: sub._id,
                    status: { $ne: 'cancelled' },
                },
            },
            { $group: { _id: null, cents: { $sum: { $ifNull: ['$listPriceCents', 0] } }, count: { $sum: 1 } } },
        ]),
        // Usage inside the CURRENT billing period — what a cancel-now refund
        // would be computed against.
        Order.aggregate([
            {
                $match: {
                    coveredBySubscription: sub._id,
                    status: { $ne: 'cancelled' },
                    ...(sub.currentPeriodStart ? { createdAt: { $gte: sub.currentPeriodStart } } : {}),
                },
            },
            { $group: { _id: null, cents: { $sum: { $ifNull: ['$listPriceCents', 0] } } } },
        ]),
        entitled ? aspMovesUsedThisWeek(sub, now) : 0,
        entitled ? freeParksUsedToday(sub, now) : 0,
    ]);

    const usageCents = usageAgg.length > 0 ? usageAgg[0].cents : 0;
    const usageCount = usageAgg.length > 0 ? usageAgg[0].count : 0;
    const paidCents = (sub.payments || []).reduce((s, p) => s + (p.amountCents || 0), 0);

    return {
        _id: sub._id,
        tier: sub.tier,
        tierName: plan ? plan.name : sub.tier,
        interval: sub.interval,
        status: sub.status,
        amountCents: sub.amountCents,
        currentPeriodEnd: sub.currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        aspSchedule: sub.aspSchedule,
        homeAddress: sub.homeAddress,
        nextAspMove: entitled ? nextAspMove(sub, now) : null,
        aspMovesUsedThisWeek: aspUsed,
        aspMovesPerWeek: sub.movesPerWeek || ASP_MOVES_PER_WEEK,
        movesPerWeek: sub.movesPerWeek || ASP_MOVES_PER_WEEK,
        homeAddressChangedAt: sub.homeAddressChangedAt,
        // What a cancel-right-now refund would look like: the period's
        // payment minus usage priced at per-use rates.
        periodUsageCents: periodUsageAgg.length ? periodUsageAgg[0].cents : 0,
        refundIfCancelledCents: Math.max(
            0,
            (sub.amountCents || 0) - (periodUsageAgg.length ? periodUsageAgg[0].cents : 0)
        ),
        freeParkAvailableToday:
            entitled && tierRank(sub.tier) >= tierRank('home_garage') && parksUsed === 0,
        valueIndicator: {
            usageCents,
            usageCount,
            paidCents,
            // Negative early in a period; the app decides how to phrase it.
            savedCents: usageCents - paidCents,
        },
    };
}

// Per-use price of one covered ASP move, from the live pricing config.
async function aspListPriceCents() {
    try {
        const cfg = await PricingConfig.getSingleton();
        return cfg.aspCents || 1500;
    } catch (e) {
        return 1500;
    }
}

module.exports = {
    PERIOD_GRACE_MS,
    isEntitled,
    getActiveSubscription,
    aspMovesUsedThisWeek,
    freeParksUsedToday,
    evaluateParkCoverage,
    nextAspMove,
    buildStatusPayload,
    aspListPriceCents,
    parkListPriceCents,
    haversineMeters,
};
