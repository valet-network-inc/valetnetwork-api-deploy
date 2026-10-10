/**
 * What the rep portal and admin show: commissions, bonuses, clusters,
 * customers, needs-attention, the unlock tree and customer referrals.
 *
 * Everything is computed from the subscriptions and unlock members as they
 * stand, never stored, so a late webhook or a cancelled plan can't leave a
 * ledger out of step. Only payouts are stored (models/SalesPayout.js).
 *
 * The /sales terms (spec v2, 18):
 *   - the neighborhood's commission for every paid month the subscription is
 *     active, from its first paid day (free and pilot months don't count) to
 *     its last; a month it is cancelled in still counts
 *   - $100 when it completes its first full paid month
 *   - a cluster: ten of the rep's subscriptions active at once in one
 *     neighborhood, each past its first full paid month = 1,500 shares
 * Customer referrals: $50 a month per referred subscription while active, for
 * up to 12 paid months each, no cap, only to the referrer.
 *
 * Months are 'YYYY-MM' in New York, compared as strings.
 */
const mongoose = require('mongoose');
const Subscription = require('../models/Subscription');
const UnlockMember = require('../models/UnlockMember');
const NeighborhoodUnlock = require('../models/NeighborhoodUnlock');
const SalesPayout = require('../models/SalesPayout');
const User = require('../models/User');
const Rep = require('../models/Rep');
const { getTable, allNeighborhoods } = require('./neighborhoodPricing');

const DAY = 24 * 60 * 60 * 1000;
const BONUS_CENTS = 10000;
const REFERRAL_CENTS = 5000;
const REFERRAL_MONTHS = 12;
const CLUSTER_SIZE = 10;
const CLUSTER_SHARES = 1500;
const UNLOCK_AT = 10;
const QUIET_DAYS = 14;
const NO_CARD_DAYS = 5;
const NOT_OPENED_DAYS = 3;
const RECENT_CANCEL_DAYS = 30;
const BOROUGHS = ['Manhattan', 'Brooklyn', 'Queens', 'Staten Island', 'Bronx'];
const WAITING = ['pending_card', 'waiting', 'scheduled', 'starting'];
const COUNTED = ['waiting', 'scheduled', 'starting', 'active'];

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function monthKey(date) {
    return new Date(date).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).slice(0, 7);
}

function nextMonth(key) {
    const [y, m] = key.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

function monthsBetween(fromKey, toKey) {
    const [y1, m1] = fromKey.split('-').map(Number);
    const [y2, m2] = toKey.split('-').map(Number);
    return (y2 - y1) * 12 + (m2 - m1);
}

function addMonths(date, n) {
    const d = new Date(date);
    const day = d.getUTCDate();
    d.setUTCMonth(d.getUTCMonth() + n);
    // Jan 31 + 1 month is the last day of February, not March 3.
    if (d.getUTCDate() < day) d.setUTCDate(0);
    return d;
}

function monthName(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
}

/** "Oct 2". */
function shortDay(date) {
    return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

function daysSince(date, now) {
    return Math.max(0, Math.floor((now - new Date(date)) / DAY));
}

function daysAgo(n) {
    if (n === 0) return 'today';
    return n === 1 ? '1 day ago' : `${n} days ago`;
}

// ---------------------------------------------------------------------------
// One subscription
// ---------------------------------------------------------------------------

/** The first paid day: after any free trial. Null for a plan that never started. */
function firstPaidAt(sub) {
    const started = sub.activatedAt || null;
    if (!started) return null;
    if (sub.trialEndsAt && new Date(sub.trialEndsAt) > new Date(started)) return new Date(sub.trialEndsAt);
    return new Date(started);
}

function endedAt(sub) {
    if (sub.cancelledAt) return new Date(sub.cancelledAt);
    if (sub.status === 'cancelled') return new Date(sub.updatedAt || Date.now());
    return null;
}

function commissionOf(sub) {
    if (typeof sub.repCommissionCents === 'number') return sub.repCommissionCents;
    return (sub.pricing && sub.pricing.commissionCents) || 0;
}

/** Earning right now: active and past its free time. */
function earningNow(sub, now) {
    const start = firstPaidAt(sub);
    return sub.status === 'active' && !!start && start <= now;
}

/** The months this subscription earned in, up to now. */
function earningMonths(sub, now) {
    const start = firstPaidAt(sub);
    if (!start || start > now) return [];
    const ended = endedAt(sub);
    const last = ended && ended < now ? monthKey(ended) : monthKey(now);
    const out = [];
    for (let k = monthKey(start); k <= last; k = nextMonth(k)) out.push(k);
    return out;
}

/** The month its $100 bonus was earned, or null. */
function bonusMonth(sub, now) {
    const start = firstPaidAt(sub);
    if (!start) return null;
    const done = addMonths(start, 1);
    if (done > now) return null;
    const ended = endedAt(sub);
    if (ended && ended < done) return null;
    return monthKey(done);
}

// ---------------------------------------------------------------------------
// Rep earnings
// ---------------------------------------------------------------------------

function scopeFor(repId) {
    return repId ? { rep: new mongoose.Types.ObjectId(String(repId)) } : { rep: { $exists: true, $ne: null } };
}

async function nameFor(userId) {
    if (!userId) return 'Customer';
    const u = await User.findById(userId).select('firstName lastName name phone').lean();
    return personName(u, null);
}

function personName(user, contact) {
    const fromContact = contact && contact.name && String(contact.name).trim();
    if (fromContact) return fromContact;
    if (!user) return 'Customer';
    const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || (user.name || '').trim();
    return full || 'Customer';
}

/**
 * { monthlyCents, months: [{month, label, commissionCents, bonusCents,
 *   totalCents, paidCents, paidAt, paidMethod}], lost, clusters }
 * repId null = every rep (admin).
 */
async function earnings(repId, now = new Date()) {
    const subs = await Subscription.find({ ...scopeFor(repId), activatedAt: { $exists: true } }).lean();
    const nowKey = monthKey(now);
    const months = new Map();
    const bump = (k, field, cents) => {
        const row = months.get(k) || { commissionCents: 0, bonusCents: 0 };
        row[field] += cents;
        months.set(k, row);
    };
    let monthlyCents = 0;
    for (const s of subs) {
        const c = commissionOf(s);
        for (const k of earningMonths(s, now)) bump(k, 'commissionCents', c);
        const b = bonusMonth(s, now);
        if (b) bump(b, 'bonusCents', BONUS_CENTS);
        if (earningNow(s, now) && !s.cancelAtPeriodEnd) monthlyCents += c;
    }
    if (!months.has(nowKey)) months.set(nowKey, { commissionCents: 0, bonusCents: 0 });

    const payouts = await SalesPayout.find({ kind: 'rep', ...(repId ? { rep: repId } : {}) }).sort({ createdAt: 1 }).lean();
    const paid = new Map();
    for (const p of payouts) {
        const row = paid.get(p.month) || { cents: 0, at: null, method: null };
        row.cents += p.amountCents;
        row.at = p.createdAt;
        row.method = p.method || row.method;
        paid.set(p.month, row);
    }
    const rows = [...months.entries()]
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .map(([month, r]) => {
            const p = paid.get(month);
            return {
                month,
                label: monthName(month),
                commissionCents: r.commissionCents,
                bonusCents: r.bonusCents,
                totalCents: r.commissionCents + r.bonusCents,
                paidCents: p ? p.cents : 0,
                paidAt: p ? p.at : null,
                paidMethod: p ? p.method : null,
            };
        });

    // Lost this month: cancelled in it, or set to end.
    const lost = [];
    for (const s of subs) {
        const ended = endedAt(s);
        const leaving = (ended && monthKey(ended) === nowKey) || (s.status === 'active' && s.cancelAtPeriodEnd);
        if (!leaving || !commissionOf(s)) continue;
        lost.push({
            customerId: String(s.user),
            name: await nameFor(s.user),
            neighborhood: (s.pricing && s.pricing.neighborhood) || null,
            commissionCents: commissionOf(s),
        });
    }

    // Clusters: per neighborhood, the rep's subscriptions active now and past
    // their first full paid month.
    const byHood = new Map();
    for (const s of subs) {
        if (!earningNow(s, now) || !s.pricing || !s.pricing.neighborhoodKey) continue;
        const key = s.pricing.neighborhoodKey;
        const row = byHood.get(key) || { name: s.pricing.neighborhood, count: 0, qualified: 0 };
        row.count += 1;
        if (addMonths(firstPaidAt(s), 1) <= now) row.qualified += 1;
        byHood.set(key, row);
    }
    const clusters = [...byHood.values()]
        .filter((r) => r.count >= CLUSTER_SIZE)
        .map((r) => ({
            name: r.name,
            shares: CLUSTER_SHARES * Math.max(1, Math.floor(r.qualified / CLUSTER_SIZE)),
            count: r.count,
            needed: CLUSTER_SIZE,
            qualified: r.qualified >= CLUSTER_SIZE,
        }));

    return { monthlyCents, months: rows, lost, clusters };
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

/** One portal row for an unlock member (and its subscription, if any). */
function customerRow(m, sub, user, now) {
    const name = personName(user, m.contact);
    const [firstName, ...rest] = name.split(' ');
    const base = {
        _id: String(m._id),
        name,
        firstName,
        lastName: rest.join(' ') || undefined,
        phone: (m.contact && m.contact.phone) || (user && user.phone) || '',
        email: (m.contact && m.contact.email) || (user && user.email) || undefined,
        neighborhood: m.neighborhoodName || null,
        neighborhoodKey: m.neighborhood,
        priceCents: (sub && sub.amountCents) || m.plan.amountCents,
        interval: (sub && sub.interval) || m.plan.interval || 'month',
        invitedAt: m.source === 'rep' ? m.createdAt : null,
        openedAt: m.inviteOpenedAt || m.claimedAt || null,
        cardSavedAt: m.cardSavedAt || null,
        activeSince: null,
        cancelledAt: null,
        commissionCents: null,
        inviteUrl: m.inviteToken ? inviteUrl(m.inviteToken) : undefined,
    };
    const subEnded = sub && (sub.status === 'cancelled' || sub.cancelAtPeriodEnd);
    if (m.status === 'active' && !subEnded) {
        const since = (sub && firstPaidAt(sub)) || m.startedAt || m.createdAt;
        return {
            ...base,
            status: 'active',
            activeSince: since,
            commissionCents: (sub && commissionOf(sub)) || m.plan.commissionCents || 0,
            statusLine: `Active since ${shortDay(since)}`,
        };
    }
    if (m.status === 'cancelled' || (m.status === 'active' && subEnded)) {
        const at = (sub && (sub.cancelledAt || sub.updatedAt)) || m.endedAt || m.updatedAt;
        return { ...base, status: 'cancelled', cancelledAt: at, statusLine: `Cancelled ${shortDay(at)} · commission ended` };
    }
    if (['left', 'declined'].includes(m.status)) {
        const at = m.endedAt || m.updatedAt;
        return { ...base, status: 'cancelled', cancelledAt: at, statusLine: `Cancelled ${shortDay(at)}` };
    }
    if (m.status === 'failed') {
        return { ...base, status: 'not_joined', statusLine: 'Card declined · plan not started' };
    }
    if (m.cardSavedAt && WAITING.includes(m.status)) {
        const line =
            m.status === 'scheduled' && m.startsAt ? `Card saved · starts ${shortDay(m.startsAt)}` : 'Card saved · waiting for unlock';
        return { ...base, status: 'waiting', statusLine: line };
    }
    const days = daysSince(m.createdAt, now);
    const opened = !!(m.inviteOpenedAt || m.claimedAt);
    return {
        ...base,
        status: 'not_joined',
        statusLine: `Invited ${daysAgo(days)} · ${opened ? 'no card' : 'not opened'}`,
    };
}

function inviteUrl(token) {
    const base = (process.env.PUBLIC_WEB_URL || 'https://valetnetwork.co').replace(/\/$/, '');
    return `${base}/join/${token}`;
}

/** The rep's own customers (repId null = everyone, for admin), newest first. */
async function customers(repId, now = new Date()) {
    const members = await UnlockMember.find(repId ? { rep: repId } : {}).sort({ createdAt: -1 }).lean();
    const userIds = members.map((m) => m.user).filter(Boolean);
    const subIds = members.map((m) => m.subscription).filter(Boolean);
    const [users, subs] = await Promise.all([
        User.find({ _id: { $in: userIds } }).select('firstName lastName name phone email').lean(),
        Subscription.find({ _id: { $in: subIds } }).lean(),
    ]);
    const u = new Map(users.map((x) => [String(x._id), x]));
    const s = new Map(subs.map((x) => [String(x._id), x]));
    const rows = members.map((m) =>
        customerRow(m, m.subscription ? s.get(String(m.subscription)) : null, m.user ? u.get(String(m.user)) : null, now)
    );
    if (repId) {
        // A rep's code used on a plan with no neighborhood (street cleaning).
        const loose = await Subscription.find({
            rep: repId,
            unlockMember: { $exists: false },
            _id: { $nin: subIds },
            activatedAt: { $exists: true },
        }).lean();
        for (const sub of loose) {
            const user = await User.findById(sub.user).select('firstName lastName name phone email').lean();
            const name = personName(user, null);
            const ended = endedAt(sub);
            rows.push({
                _id: String(sub._id),
                name,
                firstName: name.split(' ')[0],
                phone: (user && user.phone) || '',
                email: (user && user.email) || undefined,
                neighborhood: (sub.pricing && sub.pricing.neighborhood) || null,
                priceCents: sub.amountCents,
                interval: sub.interval,
                status: ended || sub.cancelAtPeriodEnd ? 'cancelled' : 'active',
                activeSince: firstPaidAt(sub),
                cancelledAt: ended,
                commissionCents: commissionOf(sub),
                statusLine: ended ? `Cancelled ${shortDay(ended)} · commission ended` : `Active since ${shortDay(firstPaidAt(sub))}`,
            });
        }
    }
    return rows;
}

// ---------------------------------------------------------------------------
// The unlock tree
// ---------------------------------------------------------------------------

/**
 * { boroughs: [{ name, label, offered, summary, neighborhoods: [...] }] }
 * Each neighborhood: key, name, priceCents, commissionCents, total, yours,
 * needed, unlocked, startsAt, quiet, lastNewSubscriberAt, note, byRep (admin).
 */
async function unlockTree({ repId = null, admin = false, now = new Date() } = {}) {
    const table = await getTable();
    const rows = allNeighborhoods(table);
    const [docs, counts] = await Promise.all([
        NeighborhoodUnlock.find({}).lean(),
        UnlockMember.aggregate([
            { $match: { status: { $in: COUNTED } } },
            { $group: { _id: { n: '$neighborhood', r: '$rep' }, c: { $sum: 1 } } },
        ]),
    ]);
    const doc = new Map(docs.map((d) => [d.key, d]));
    const total = new Map();
    const byRep = new Map();
    for (const { _id, c } of counts) {
        total.set(_id.n, (total.get(_id.n) || 0) + c);
        if (_id.r) {
            const list = byRep.get(_id.n) || [];
            list.push({ repId: String(_id.r), count: c });
            byRep.set(_id.n, list);
        }
    }
    let repNames = new Map();
    if (admin) {
        const reps = await Rep.find({}).select('name').lean();
        repNames = new Map(reps.map((r) => [String(r._id), r.name]));
    }
    const boroughs = BOROUGHS.map((b) => ({ name: b, label: b === 'Bronx' ? 'The Bronx' : b, neighborhoods: [] }));
    for (const r of rows) {
        const borough = boroughs.find((b) => b.name === r.borough);
        if (!borough) continue;
        const d = doc.get(r.key) || {};
        const t = total.get(r.key) || 0;
        const reps = byRep.get(r.key) || [];
        const mine = repId ? (reps.find((x) => x.repId === String(repId)) || { count: 0 }).count : 0;
        const unlocked = !!d.unlockedAt;
        const last = d.lastNewSubscriberAt || null;
        borough.neighborhoods.push({
            key: r.key,
            name: r.name,
            offered: r.offered,
            priceCents: r.monthlyCents,
            ...(admin ? { commissionCents: r.commissionCents } : {}),
            interval: 'month',
            total: t,
            yours: mine,
            needed: UNLOCK_AT,
            unlocked,
            unlockedAt: d.unlockedAt || null,
            startsAt: d.startsAt || null,
            quiet: r.offered && !unlocked && t > 0 && !!last && daysSince(last, now) >= QUIET_DAYS,
            quietDays: last ? daysSince(last, now) : null,
            lastNewSubscriberAt: last,
            note: d.noteToReps || '',
            ...(admin
                ? {
                      byRep: reps
                          .map((x) => ({ repId: x.repId, name: repNames.get(x.repId) || 'Rep', count: x.count }))
                          .sort((a, b) => b.count - a.count),
                  }
                : {}),
        });
    }
    for (const b of boroughs) {
        b.offered = b.neighborhoods.some((n) => n.offered);
        const unlocked = b.neighborhoods.filter((n) => n.unlocked).length;
        if (!b.offered) b.summary = 'Not offered yet';
        else if (b.name === 'Manhattan') b.summary = `${b.neighborhoods.length} neighborhoods · ${unlocked} unlocked`;
        else {
            const price = b.neighborhoods[0] ? b.neighborhoods[0].priceCents : null;
            b.summary = `${b.neighborhoods.length} neighborhoods · $${Math.round((price || 0) / 100)}/mo`;
        }
        if (!b.offered) b.neighborhoods = [];
    }
    return { boroughs };
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

/** Needs attention, red on Home (spec v2, 18). */
function attention(rows, tree, now) {
    const out = [];
    for (const c of rows) {
        if (c.status === 'not_joined' && c.invitedAt) {
            const days = daysSince(c.invitedAt, now);
            const opened = !!c.openedAt;
            if (opened && days >= NO_CARD_DAYS) {
                out.push({ kind: 'no_card', customerId: c._id, name: c.name, phone: c.phone, email: c.email,
                    text: `hasn’t added a card · invited ${daysAgo(days)}`, short: `No card · invited ${daysAgo(days)}` });
            } else if (!opened && days >= NOT_OPENED_DAYS) {
                out.push({ kind: 'not_opened', customerId: c._id, name: c.name, phone: c.phone, email: c.email,
                    text: `hasn’t opened the invite · ${days} days`, short: `Invite not opened · ${days} days` });
            }
        }
        if (c.status === 'not_joined' && c.statusLine.startsWith('Card declined')) {
            out.push({ kind: 'declined', customerId: c._id, name: c.name, phone: c.phone, email: c.email,
                text: 'card was declined', short: 'Card declined' });
        }
        if (c.status === 'cancelled' && c.commissionCents === null && c.statusLine.endsWith('commission ended')
            && c.cancelledAt && daysSince(c.cancelledAt, now) <= RECENT_CANCEL_DAYS) {
            out.push({ kind: 'cancelled', customerId: c._id, name: c.name, phone: c.phone, email: c.email,
                text: `cancelled on ${shortDay(c.cancelledAt)}`, short: `Cancelled ${shortDay(c.cancelledAt)}` });
        }
    }
    for (const b of tree.boroughs) {
        for (const n of b.neighborhoods) {
            if (n.quiet && (n.yours > 0 || n.total > 0)) {
                out.push({ kind: 'quiet', neighborhoodKey: n.key, name: n.name,
                    text: `no new subscriber in ${n.quietDays} days`, short: `No new subscriber in ${n.quietDays} days` });
            }
        }
    }
    return out;
}

async function home(repId, now = new Date()) {
    const [money, rows, tree] = await Promise.all([
        earnings(repId, now),
        customers(repId, now),
        unlockTree({ repId, admin: !repId, now }),
    ]);
    const nowKey = monthKey(now);
    const thisMonth = money.months.find((m) => m.month === nowKey) || { bonusCents: 0 };
    const newThisMonth = rows.filter((c) => c.cardSavedAt && monthKey(c.cardSavedAt) === nowKey && c.status !== 'cancelled').length;
    // Quiet only where this rep has people: other reps' quiet corners are not theirs to fix.
    const scopedTree = repId
        ? { boroughs: tree.boroughs.map((b) => ({ ...b, neighborhoods: b.neighborhoods.filter((n) => n.yours > 0) })) }
        : tree;
    const mine = [];
    for (const b of tree.boroughs) {
        for (const n of b.neighborhoods) if (repId ? n.yours > 0 : n.total > 0) mine.push(n);
    }
    mine.sort((a, b) => (b.unlocked - a.unlocked) || (b.total - a.total));
    return {
        monthlyCents: money.monthlyCents,
        newThisMonth,
        bonusThisMonthCents: thisMonth.bonusCents,
        attention: attention(rows, scopedTree, now),
        unlocks: mine.slice(0, 5),
    };
}

// ---------------------------------------------------------------------------
// Customer referrals
// ---------------------------------------------------------------------------

/** The Refer a friend screen's list and total for one customer. */
async function referralSummary(userId, now = new Date()) {
    const nowKey = monthKey(now);
    const subs = await Subscription.find({ referredBy: userId, activatedAt: { $exists: true } }).lean();
    const rows = [];
    let earningCents = 0;
    for (const s of subs) {
        const start = firstPaidAt(s);
        const ended = endedAt(s);
        const name = await nameFor(s.user);
        if (ended || s.status !== 'active') {
            rows.push({ name, status: 'cancelled', line: `Cancelled ${shortDay(ended || s.updatedAt)}`, rewardCents: null });
            continue;
        }
        const used = start && start <= now ? monthsBetween(monthKey(start), nowKey) : 0;
        const left = Math.max(0, REFERRAL_MONTHS - used);
        if (!start || start > now) {
            rows.push({ name, status: 'waiting', line: `Starts ${shortDay(start || now)}`, rewardCents: null });
        } else if (left > 0) {
            rows.push({ name, status: 'active', since: start, monthsLeft: left, line: `Active since ${shortDay(start)} · ${left} month${left === 1 ? '' : 's'} left`, rewardCents: REFERRAL_CENTS });
            earningCents += REFERRAL_CENTS;
        } else {
            rows.push({ name, status: 'ended', since: start, line: `Active since ${shortDay(start)} · year complete`, rewardCents: null });
        }
    }
    const waiting = await UnlockMember.find({ referredBy: userId, status: { $in: ['waiting', 'scheduled', 'starting'] } }).lean();
    for (const m of waiting) {
        const user = m.user ? await User.findById(m.user).select('firstName lastName name').lean() : null;
        rows.push({ name: personName(user, m.contact), status: 'waiting', line: `Waiting for ${m.neighborhoodName} to go live`, rewardCents: null });
    }
    return { referrals: rows, earningCents };
}

/** What each referrer is owed for a month (admin). */
async function referralPayouts(month, now = new Date()) {
    const subs = await Subscription.find({ referredBy: { $exists: true, $ne: null }, activatedAt: { $exists: true } }).lean();
    const owed = new Map();
    for (const s of subs) {
        const start = firstPaidAt(s);
        if (!start) continue;
        const months = earningMonths(s, now);
        if (!months.includes(month)) continue;
        if (monthsBetween(monthKey(start), month) >= REFERRAL_MONTHS) continue;
        const key = String(s.referredBy);
        const row = owed.get(key) || { activeReferrals: 0, owedCents: 0 };
        row.activeReferrals += 1;
        row.owedCents += REFERRAL_CENTS;
        owed.set(key, row);
    }
    const ids = [...owed.keys()];
    const [users, payouts] = await Promise.all([
        User.find({ _id: { $in: ids } }).select('firstName lastName name phone email referral').lean(),
        SalesPayout.find({ kind: 'referral', user: { $in: ids } }).lean(),
    ]);
    return ids.map((id) => {
        const u = users.find((x) => String(x._id) === id) || {};
        const mine = payouts.filter((p) => String(p.user) === id);
        const thisMonth = mine.filter((p) => p.month === month);
        return {
            userId: id,
            name: personName(u, null),
            phone: u.phone,
            email: u.email,
            method: (u.referral && u.referral.method) || null,
            handle: (u.referral && u.referral.handle) || null,
            activeReferrals: owed.get(id).activeReferrals,
            owedCents: Math.max(0, owed.get(id).owedCents - thisMonth.reduce((a, p) => a + p.amountCents, 0)),
            paidToDateCents: mine.reduce((a, p) => a + p.amountCents, 0),
            paidAt: thisMonth.length ? thisMonth[thisMonth.length - 1].createdAt : null,
        };
    });
}

module.exports = {
    monthKey,
    nextMonth,
    addMonths,
    shortDay,
    firstPaidAt,
    earningMonths,
    bonusMonth,
    commissionOf,
    earnings,
    customers,
    customerRow,
    unlockTree,
    home,
    referralSummary,
    referralPayouts,
    inviteUrl,
    personName,
    BONUS_CENTS,
    REFERRAL_CENTS,
};
