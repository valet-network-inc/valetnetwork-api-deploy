/**
 * Subscribers tab (2026-08-21).
 *
 * Until now the only way to answer "who is on a plan and what is it worth"
 * was to open Stripe. Stripe knows about billing; it does not know which
 * customer that is, what their street-cleaning schedule looks like, how many
 * orders the plan has actually covered, or how much we credited back when the
 * city suspended a sweep. All of that lives here, so the console can show the
 * whole picture in one read.
 *
 * One endpoint, one round trip: the tab is small enough that paging it would
 * cost more in complexity than it saves in bytes, and every filter the UI
 * offers is a filter over the same rows.
 */

const Subscription = require('../models/Subscription');
const User = require('../models/User');
const Order = require('../models/Order');
const AspCredit = require('../models/AspCredit');
const { PLANS, getPlan } = require('../services/subscriptionPlans');
const { nyDateKey } = require('../services/nyTime');
const { summarizeMany, describeShort } = require('../services/cleaningSchedule');

const DAY_MS = 24 * 60 * 60 * 1000;

// A weekly plan and a monthly plan are not comparable until both are stated
// in the same unit. 52 weeks / 12 months is the honest conversion — not 4
// weeks, which quietly undercounts a weekly plan by 8% a year.
function monthlyEquivalentCents(sub) {
    const amount = sub.amountCents || 0;
    if (sub.interval === 'week') return Math.round((amount * 52) / 12);
    return amount;
}

function customerName(u) {
    if (!u) return '(deleted customer)';
    if (u.isDoorman) return u.enterpriseBusinessName || '(Enterprise)';
    return `${u.firstName || ''} ${u.lastName || ''}`.trim() || '(no name)';
}

// The pre-v2 doorman-referral schema had no `status` field at all. Those docs
// are dead weight rather than subscribers, so they are flagged and kept out of
// every count instead of being silently normalised into "incomplete" and
// inflating the abandoned-checkout number.
function isLegacyDoc(sub) {
    return !sub.status || !getPlan(sub.tier);
}

// Two schedules are the same schedule when the same weekdays are set at the
// same times. Used only to tell the operator when the plan and the customer's
// own alarm have drifted apart — see `cleaning.matchesPlan` below.
function scheduleSignature(schedule) {
    return [...((schedule && schedule.days) || [])]
        .filter((d) => d && Number.isFinite(d.weekday))
        .map((d) => `${d.weekday}@${d.hour || 0}:${d.minute || 0}`)
        .sort()
        .join('|');
}

function hasDays(schedule) {
    return !!(schedule && (schedule.days || []).length);
}

/**
 * GET /api/admin/subscriptions
 *
 * Everything the Subscribers tab draws: one row per subscription with the
 * customer joined in, plus the roll-ups the UI would otherwise have to
 * recompute on every filter change.
 */
exports.getSubscriptionOverview = async (req, res) => {
    try {
        const now = Date.now();

        const subs = await Subscription.find({}).sort({ _id: -1 }).lean();

        const userIds = [...new Set(subs.map((s) => s.user && s.user.toString()).filter(Boolean))];
        const users = await User.find({ _id: { $in: userIds } })
            .select('_id firstName lastName phone isDoorman enterpriseBusinessName cleaningSchedule')
            .lean();
        const userById = {};
        users.forEach((u) => { userById[u._id.toString()] = u; });

        // How many orders each plan has actually paid for, and what those
        // orders would have cost at list price. That second number is the
        // whole argument for the plan — it is what the customer saved.
        const coverage = await Order.aggregate([
            { $match: { coveredBySubscription: { $ne: null } } },
            {
                $group: {
                    _id: '$coveredBySubscription',
                    orders: { $sum: 1 },
                    listValueCents: { $sum: { $ifNull: ['$listPriceCents', 0] } },
                    lastAt: { $max: '$createdAt' },
                },
            },
        ]);
        const coverageBySub = {};
        coverage.forEach((row) => {
            if (row._id) coverageBySub[row._id.toString()] = row;
        });

        // Suspension credits already handed back. 'skipped' and 'failed' are
        // excluded — money that never left is not a credit.
        const credits = await AspCredit.aggregate([
            { $match: { stripeStatus: { $in: ['pending', 'applied'] } } },
            {
                $group: {
                    _id: '$subscription',
                    cents: { $sum: '$amountCents' },
                    days: { $sum: 1 },
                },
            },
        ]);
        const creditsBySub = {};
        credits.forEach((row) => {
            if (row._id) creditsBySub[row._id.toString()] = row;
        });

        // The street-cleaning schedule, as the scheduler resolves it: the
        // customer's own home schedule is the source of truth and the copy on
        // the subscription is the fallback (services/aspScheduler reads them in
        // that order). Showing anything else here would have the console
        // disagreeing with the van.
        const effectiveSchedules = subs.map((s) => {
            const user = userById[s.user && s.user.toString()];
            const home = user && user.cleaningSchedule;
            return {
                key: s._id.toString(),
                schedule: hasDays(home) ? home : (s.aspSchedule || null),
            };
        });
        const cleaningBySub = await summarizeMany(effectiveSchedules);

        const rows = subs.map((s) => {
            const id = s._id.toString();
            const legacy = isLegacyDoc(s);
            const plan = getPlan(s.tier);
            const cov = coverageBySub[id];
            const cred = creditsBySub[id];
            const paid = (s.payments || []).reduce((sum, p) => sum + (p.amountCents || 0), 0);
            const lastPayment = (s.payments || [])
                .filter((p) => p.paidAt)
                .sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt))[0];
            const inTrial = !!(s.trialEndsAt && new Date(s.trialEndsAt).getTime() > now);
            const startedAt = s.activatedAt || s.createdAt || s._id.getTimestamp();

            return {
                _id: id,
                userId: s.user ? s.user.toString() : null,
                name: customerName(userById[s.user && s.user.toString()]),
                phone: (userById[s.user && s.user.toString()] || {}).phone || '',

                tier: s.tier || null,
                tierName: plan ? plan.name : (s.tier || 'Unknown plan'),
                interval: s.interval || null,
                status: legacy ? 'legacy' : s.status,
                legacy,

                amountCents: s.amountCents || 0,
                monthlyEquivalentCents: legacy ? 0 : monthlyEquivalentCents(s),
                movesPerWeek: s.tier === 'street_cleaning' ? (s.movesPerWeek || 2) : null,

                promoCode: s.promoCode || null,
                inTrial,
                trialEndsAt: s.trialEndsAt || null,

                startedAt,
                createdAt: s.createdAt || s._id.getTimestamp(),
                activatedAt: s.activatedAt || null,
                currentPeriodStart: s.currentPeriodStart || null,
                currentPeriodEnd: s.currentPeriodEnd || null,
                cancelAtPeriodEnd: !!s.cancelAtPeriodEnd,
                cancelledAt: s.cancelledAt || null,

                paidCents: paid,
                paymentsCount: (s.payments || []).length,
                lastPaymentAt: lastPayment ? lastPayment.paidAt : null,

                coveredOrders: cov ? cov.orders : 0,
                coveredValueCents: cov ? cov.listValueCents : 0,
                lastCoveredAt: cov ? cov.lastAt : null,

                creditedCents: cred ? cred.cents : 0,
                creditedDays: cred ? cred.days : 0,

                scheduleDays: (s.aspSchedule && s.aspSchedule.days ? s.aspSchedule.days.length : 0),
                cleaning: (() => {
                    const home = (userById[s.user && s.user.toString()] || {}).cleaningSchedule;
                    const summary = cleaningBySub.get(id) || { hasSchedule: false };
                    const fromCustomer = hasDays(home);
                    return {
                        ...summary,
                        // Which of the two copies the answer came from, so a
                        // wrong day can be corrected in the right place.
                        from: summary.hasSchedule ? (fromCustomer ? 'customer' : 'subscription') : null,
                        // Null when there is nothing to compare — only a real
                        // disagreement is worth an operator's attention.
                        matchesPlan:
                            fromCustomer && hasDays(s.aspSchedule)
                                ? scheduleSignature(home) === scheduleSignature(s.aspSchedule)
                                : null,
                        // What the plan itself was sold with, shown only when
                        // it disagrees with the schedule above.
                        planLabel: hasDays(s.aspSchedule) ? describeShort(s.aspSchedule) : null,
                    };
                })(),
                address:
                    (s.aspSchedule && s.aspSchedule.address && s.aspSchedule.address.streetAddress) ||
                    (s.homeAddress && s.homeAddress.streetAddress) ||
                    '',

                stripeSubscriptionId: s.stripeSubscriptionId || null,
                stripeCustomerId: s.stripeCustomerId || null,
            };
        });

        // ---- roll-ups -----------------------------------------------------
        const live = rows.filter((r) => r.status === 'active' || r.status === 'past_due');
        const active = rows.filter((r) => r.status === 'active');
        const billingNow = active.filter((r) => !r.inTrial);
        const trialing = active.filter((r) => r.inTrial);

        const sumMrr = (list) => list.reduce((n, r) => n + r.monthlyEquivalentCents, 0);
        const mrrCents = sumMrr(billingNow);
        const trialMrrCents = sumMrr(trialing);

        const byTier = Object.keys(PLANS)
            .sort((a, b) => PLANS[a].rank - PLANS[b].rank)
            .map((tier) => {
                const mine = active.filter((r) => r.tier === tier);
                return {
                    tier,
                    name: PLANS[tier].name,
                    active: mine.length,
                    mrrCents: sumMrr(mine.filter((r) => !r.inTrial)),
                };
            });

        const byInterval = {
            week: active.filter((r) => r.interval === 'week').length,
            month: active.filter((r) => r.interval === 'month').length,
        };

        const since = (days) => now - days * DAY_MS;
        const startedSince = (days) =>
            rows.filter((r) => !r.legacy && r.startedAt && new Date(r.startedAt).getTime() >= since(days)).length;
        const cancelledSince = (days) =>
            rows.filter((r) => r.cancelledAt && new Date(r.cancelledAt).getTime() >= since(days)).length;

        const lifetimeRevenueCents = rows.reduce((n, r) => n + r.paidCents, 0);
        // Revenue in the last 30 days has to walk the payment arrays rather
        // than the row totals — a plan can be years old and still have billed
        // last week.
        let revenue30 = 0;
        subs.forEach((s) => {
            (s.payments || []).forEach((p) => {
                if (p.paidAt && new Date(p.paidAt).getTime() >= since(30)) {
                    revenue30 += p.amountCents || 0;
                }
            });
        });

        // Six months of starts and cancels, newest month last, for the trend
        // strip. Buckets are New York months because that is the calendar the
        // business runs on.
        // The current month is read off the New York clock, not the server's —
        // Render runs UTC, so between midnight and 4am on the 1st the two
        // disagree about which month it is.
        const [nyYear, nyMonth] = nyDateKey(new Date(now)).split('-').map(Number);
        const monthKeys = [];
        for (let i = 5; i >= 0; i -= 1) {
            const d = new Date(Date.UTC(nyYear, nyMonth - 1 - i, 1));
            monthKeys.push(
                `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
            );
        }
        const monthOf = (value) => (value ? nyDateKey(new Date(value)).slice(0, 7) : null);
        const growth = monthKeys.map((key) => {
            const started = rows.filter((r) => !r.legacy && monthOf(r.startedAt) === key).length;
            const cancelled = rows.filter((r) => monthOf(r.cancelledAt) === key).length;
            return { month: key, started, cancelled, net: started - cancelled };
        });

        res.status(200).json({
            success: true,
            data: {
                generatedAt: new Date(),
                // New York's date, so the tab can say "today" without trusting
                // the operator's laptop clock or the server's UTC one.
                todayKey: nyDateKey(new Date(now)),
                summary: {
                    total: rows.length,
                    active: active.length,
                    live: live.length,
                    pastDue: rows.filter((r) => r.status === 'past_due').length,
                    incomplete: rows.filter((r) => r.status === 'incomplete').length,
                    cancelled: rows.filter((r) => r.status === 'cancelled').length,
                    legacy: rows.filter((r) => r.legacy).length,
                    trialing: trialing.length,
                    cancelAtPeriodEnd: active.filter((r) => r.cancelAtPeriodEnd).length,

                    mrrCents,
                    arrCents: mrrCents * 12,
                    trialMrrCents,
                    lifetimeRevenueCents,
                    revenueLast30Cents: revenue30,

                    newLast7: startedSince(7),
                    newLast30: startedSince(30),
                    cancelledLast30: cancelledSince(30),

                    coveredOrders: rows.reduce((n, r) => n + r.coveredOrders, 0),
                    coveredValueCents: rows.reduce((n, r) => n + r.coveredValueCents, 0),
                    creditedCents: rows.reduce((n, r) => n + r.creditedCents, 0),

                    byTier,
                    byInterval,
                    growth,
                },
                rows,
            },
        });
    } catch (err) {
        console.error('Error fetching subscription overview:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch subscribers',
            error: err.message,
        });
    }
};
