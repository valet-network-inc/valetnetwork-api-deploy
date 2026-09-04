// Subscriptions v2 entitlement engine.
//
// Answers one question for order creation — "does this subscriber's plan make
// this order $0?" — and builds the status payload the app renders (next move,
// free-park-today flag, value indicator). The scheduler and createOrder both
// come through here so the rules live in exactly one place.

const Subscription = require('../models/Subscription');
const Order = require('../models/Order');

// Kept here rather than imported from services/curbCustody so the status
// payload cannot pull the dispatcher into every request that reads a plan.
const MANAGED_TIERS = ['home_garage', 'valet_anywhere'];
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
//
// Bounded at BOTH ends. /park books a sweep move up to 8 days out and the order
// is stamped covered the moment it is made, so with only a lower bound one
// booking for next Tuesday counted as a move already spent in every week
// between now and its pickup. That cost the customer twice: the plan refused to
// cover a move they still had ('weekly_asp_limit_reached', $15 charged), and the
// auto-sweep booker read the cap as reached and quietly booked nothing on their
// cleaning day — no order, no valet, no push — leaving the car on the block for
// a $65 ticket. The upper bound is next week's NY Monday, taken by asking
// nyStartOfWeek about a moment 8 days on so a DST hour cannot slide it a week.
async function aspMovesUsedThisWeek(sub, now = new Date()) {
    const weekStart = nyStartOfWeek(now);
    const weekEnd = nyStartOfWeek(new Date(weekStart.getTime() + 8 * 24 * 60 * 60 * 1000));
    return Order.countDocuments({
        coveredBySubscription: sub._id,
        aspMode: true,
        orderType: 'parking',
        status: { $ne: 'cancelled' },
        pickUpTime: { $gte: weekStart, $lt: weekEnd },
    });
}

// Covered non-ASP parks already used today (NY day).
//
// Bounded at BOTH ends. A park booked for a later day is covered when it is
// booked, and its pickUpTime sits days out — with only a lower bound the plan's
// free park read as spent on every day in between, so a $250/$300 customer who
// booked next Friday was charged $10 a day to park in the meantime, on screens
// telling them today's free park was already used. It never was. The upper
// bound is the next NY midnight, taken by asking nyStartOfDay about a moment
// ~36h on so a DST hour cannot land it on the wrong calendar day.
async function freeParksUsedToday(sub, now = new Date()) {
    const dayStart = nyStartOfDay(now);
    const dayEnd = nyStartOfDay(new Date(dayStart.getTime() + 36 * 60 * 60 * 1000));
    return Order.countDocuments({
        coveredBySubscription: sub._id,
        aspMode: { $ne: true },
        orderType: 'parking',
        status: { $ne: 'cancelled' },
        pickUpTime: { $gte: dayStart, $lt: dayEnd },
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

/**
 * Does a park on this plan, at this spot, have no end time?
 *
 * On the flat plans we hold the car and the keys until the customer asks for it
 * back, so a duration was always a fiction on them — there is nothing to expire
 * and nothing to extend. Rishi, 2026-09-04.
 *
 * This is NOT the same question as coverage, and the difference matters: the
 * free park is once a day, but the SECOND park of the day is still indefinite
 * so long as it is somewhere the plan looks after. The customer pays for that
 * one; they do not get billed by the hour for it.
 *
 *   valet_anywhere — anywhere we operate, which is what its extra $50 buys.
 *   home_garage    — within HOME_RADIUS_METERS of the fixed address, the same
 *                    circle `evaluateParkCoverage` pays inside.
 *
 * Fails toward FALSE: a park wrongly marked indefinite never expires and never
 * prompts anyone, so a car could sit on a sweep block with nobody watching the
 * clock. A park wrongly left finite just shows a duration nobody acts on.
 */
function parkIsIndefinite(sub, { lat, lng } = {}, now = new Date()) {
    if (!sub || !isEntitled(sub, now)) return false;
    if (!MANAGED_TIERS.includes(sub.tier)) return false;
    if (sub.tier === 'valet_anywhere') return true;

    const home = sub.homeAddress;
    if (!home || typeof home.lat !== 'number' || typeof home.lng !== 'number') return false;
    if (typeof lat !== 'number' || typeof lng !== 'number') return false;
    return haversineMeters({ lat, lng }, { lat: home.lat, lng: home.lng }) <= HOME_RADIUS_METERS;
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
    // Inside a free month: full service, nothing charged yet, and therefore
    // nothing to refund if they walk away.
    const inTrial = !!(sub.trialEndsAt && now.getTime() < sub.trialEndsAt.getTime());

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

    // What the flat plans replaced the sweep-day question with.
    //
    // On home_garage and valet_anywhere the customer is never asked when their
    // street is cleaned, so there is no schedule to show them. What there IS, is
    // a car we are holding and a block we have read — so the app states the fact
    // instead of asking the question. `blind` is the honest case: we have the
    // car and cannot read the block yet, and the customer is still never asked
    // to fill that gap; a human is (services/curbSweepDispatcher.js watch()).
    let managed = null;
    let keys = null;
    if (MANAGED_TIERS.includes(sub.tier)) {
        managed = { active: false, blind: false };
        try {
            const CurbCustody = require('../models/CurbCustody');
            const sweepWindows = require('./sweepWindows');
            const custody = await CurbCustody.findOne({
                subscription: sub._id,
                closedAt: { $exists: false },
            })
                .sort({ openedAt: -1 })
                .lean();
            if (custody) {
                const windows = (custody.rules && custody.rules.windows) || [];
                const next = windows.length ? sweepWindows.nextSweep(windows, now) : null;
                managed = {
                    active: true,
                    spotAddress: (custody.spot && custody.spot.streetAddress) || null,
                    nextMoveAt: next ? next.at : null,
                    windowsLabel: windows.length ? sweepWindows.describeWindows(windows) : null,
                    blind: custody.rules && custody.rules.source === 'unknown',
                    movesThisPeriod: custody.movesThisPeriod || 0,
                };

                // Who has the keys, and whether they can be asked for.
                //
                // On these plans the valet keeps them after every park — that is
                // what lets us move the car before a sweep without the customer
                // being there. Holding somebody's keys is only reasonable while
                // getting them back is one tap, so the app needs this on the
                // screen the customer opens first.
                const kr = custody.keyRequest || {};
                const requestRunning = !!(kr.requestedAt && !kr.deliveredAt && !kr.cancelledAt);
                let holderName = null;
                if (custody.keyHolder) {
                    try {
                        const User = require('../models/User');
                        const v = await User.findById(custody.keyHolder)
                            .select('firstName lastName')
                            .lean();
                        if (v) {
                            holderName =
                                [v.firstName, v.lastName].filter(Boolean).join(' ').trim() || null;
                        }
                    } catch (nameErr) {
                        // A missing name is cosmetic. The key state is not.
                        console.error('buildStatusPayload: key holder lookup failed:', nameErr.message);
                    }
                }
                keys = {
                    with: custody.keysWith || 'valet',
                    holderName,
                    canRequest: custody.keysWith === 'valet' && !requestRunning,
                    requestedAt: requestRunning ? kr.requestedAt : null,
                    deliveryOrderId:
                        requestRunning && kr.deliveryOrder ? String(kr.deliveryOrder) : null,
                };
            }
        } catch (err) {
            // A status screen must never fail because of this. An absent
            // `managed` reads as "nothing parked with us", which is the safe
            // thing to say when we cannot tell.
            console.error('buildStatusPayload: managed lookup failed:', err.message);
        }
    }

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
        managed,
        keys,
        // The radius the server actually pays coverage inside. Sent so the app's
        // map default and this check can never drift apart.
        homeRadiusMeters: HOME_RADIUS_METERS,
        // What a cancel-right-now refund would look like: the period's
        // payment minus usage priced at per-use rates.
        periodUsageCents: periodUsageAgg.length ? periodUsageAgg[0].cents : 0,
        refundIfCancelledCents: inTrial
            ? 0
            : Math.max(
                  0,
                  (sub.amountCents || 0) - (periodUsageAgg.length ? periodUsageAgg[0].cents : 0)
              ),
        promoCode: sub.promoCode || null,
        // The app reads this to say "free until September 19, then $50/mo"
        // instead of showing a price the customer is not paying yet.
        trial: inTrial
            ? {
                  endsAt: sub.trialEndsAt,
                  code: sub.promoCode || null,
                  thenCents: sub.amountCents || 0,
                  thenInterval: sub.interval,
              }
            : null,
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
    parkIsIndefinite,
    nextAspMove,
    buildStatusPayload,
    aspListPriceCents,
    parkListPriceCents,
    haversineMeters,
};
