// Neighborhood unlocks (spec v2, 2026-10-09). They replace waitlists.
//
// Permanent valet runs a valet per neighborhood, so a neighborhood only goes
// live once it has enough customers to keep one busy:
//
//   - It unlocks at 10 members with a card saved, counting every rep's
//     invites and every self-signup (models/UnlockMember.js).
//   - Plans start 3 days after the unlock. Every saved card is charged at
//     8 AM ET that day, and Rishi gets an operator alert at the unlock to
//     station a valet.
//   - Once a neighborhood is unlocked, a new subscriber starts the moment
//     their card is saved.
//
// Until then nothing is charged. A self-signup in a locked neighborhood gets
// a SetupIntent from /create instead of a first invoice; a rep's invite gets
// one from the invite link. Either way the card is saved and the member
// waits, and is told before the plan goes live.
//
// Money moves in one place only, startMember, and only for a row this
// process claimed with a conditional update (scheduled → starting). The
// Stripe call carries an idempotency key on the member id, so a retry after a
// crash between Stripe and Mongo gets the same subscription back, not a
// second charge.

const crypto = require('crypto');
const UnlockMember = require('../models/UnlockMember');
const NeighborhoodUnlock = require('../models/NeighborhoodUnlock');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const stripeClient = require('./stripeClient');
const operatorAlert = require('./operatorAlert');
const realtime = require('./realtime');
const { phoneCode } = require('./phoneCodes');
const { getTable, neighborhoodByKey, garagePriceAt } = require('./neighborhoodPricing');
const { dollars, pricingSnapshot, resolveStripePrice } = require('./planPricing');
const { nyClock, nyWallTimeToInstant } = require('./nyTime');
const { getPlan } = require('./subscriptionPlans');

const UNLOCK_AT = 10;
const START_DELAY_DAYS = 3;
const START_HOUR_ET = 8;
// A start claimed this long ago and never finished is retried. The retry
// reuses the idempotency key, so Stripe hands back what the first try made.
const STUCK_START_MS = 10 * 60 * 1000;
const REMIND_BEFORE_MS = 24 * 60 * 60 * 1000;

const { LIVE_STATUSES, COUNTED_STATUSES } = UnlockMember;

function requireStripe() {
    const stripe = stripeClient.get();
    if (!stripe) {
        const err = new Error('Stripe API key not configured');
        err.status = 503;
        throw err;
    }
    return stripe;
}

// ---------------------------------------------------------------------------
// Dates and words
// ---------------------------------------------------------------------------

/** 8 AM ET on the third New York day after `at`. */
function startDateAfter(at) {
    const c = nyClock(at);
    const d = new Date(Date.UTC(c.year, c.month - 1, c.day + START_DELAY_DAYS));
    return nyWallTimeToInstant(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), START_HOUR_ET, 0);
}

const fmt = (date, opts) => new Date(date).toLocaleDateString('en-US', { timeZone: 'America/New_York', ...opts });
/** "Thursday, Oct 15" */
const longDay = (date) => fmt(date, { weekday: 'long', month: 'short', day: 'numeric' });
/** "Oct 15" */
const shortDay = (date) => fmt(date, { month: 'short', day: 'numeric' });

function ordinal(n) {
    const tens = n % 100;
    if (tens >= 11 && tens <= 13) return `${n}th`;
    return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

/** "200 W 20th St" out of "200 W 20th St, New York, NY 10011, USA". */
function shortStreet(address) {
    return String((address && address.streetAddress) || '').split(',')[0].trim();
}

// The neighborhoods a sentence puts "the" in front of: "12 neighbors in the
// Upper East Side". Price lines and headings use the bare name.
const TAKES_THE = /^(Upper |Lower |East Village|West Village|Financial District|Flatiron)/;
function inName(name) {
    return TAKES_THE.test(name) ? `the ${name}` : name;
}

const BRANDS = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover' };
function cardLabel(member) {
    if (!member.cardLast4) return null;
    const brand = BRANDS[member.cardBrand] || (member.cardBrand ? member.cardBrand[0].toUpperCase() + member.cardBrand.slice(1) : 'Card');
    return `${brand} ending ${member.cardLast4}`;
}

function firstName(name) {
    return String(name || '').trim().split(/\s+/)[0] || null;
}

/** "Chelsea doesn’t have a valet yet. 7 subscribers are on the waitlist, …" — the ⓘ box on the review screen. */
function waitlistNote(name, count) {
    const people = count === 1 ? '1 subscriber is' : `${count} subscribers are`;
    return `${name} doesn’t have a valet yet. ${people} on the waitlist, and it goes live at ${UNLOCK_AT}. We’ll alert you before your subscription starts, and you’re not charged until then.`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

async function countFor(key) {
    return UnlockMember.countDocuments({ neighborhood: key, status: { $in: COUNTED_STATUSES } });
}

/**
 * Where a neighborhood stands.
 *   { key, name, borough, offered, count, needed, unlocked, unlockedAt,
 *     startsAt, monthlyCents, commissionCents, note, lastNewSubscriberAt }
 */
async function stateFor(key, table = null) {
    const t = table || (await getTable());
    const row = neighborhoodByKey(t, key);
    if (!row) return null;
    const [doc, count] = await Promise.all([NeighborhoodUnlock.findOne({ key }).lean(), countFor(key)]);
    return {
        key,
        name: row.name,
        borough: row.borough,
        offered: row.offered,
        count,
        needed: UNLOCK_AT,
        unlocked: !!(doc && doc.unlockedAt),
        unlockedAt: (doc && doc.unlockedAt) || null,
        startsAt: (doc && doc.startsAt) || null,
        monthlyCents: row.monthlyCents,
        commissionCents: row.commissionCents,
        note: (doc && doc.noteToReps) || null,
        lastNewSubscriberAt: (doc && doc.lastNewSubscriberAt) || null,
    };
}

/**
 * For /price: the waitlist a Permanent valet quote would join, or null when
 * its neighborhood is unlocked (or the quote is for another plan).
 */
async function waitlistForQuote(quote) {
    if (!quote || !quote.plan || !quote.plan.pricedByAddress || !quote.area || !quote.area.key) return null;
    const state = await stateFor(quote.area.key);
    if (!state) return null;
    if (state.unlocked) {
        // Unlocked but not started: the card is charged on the start date.
        if (!state.startsAt || new Date(state.startsAt) <= new Date()) return null;
        return {
            neighborhood: state.name,
            key: state.key,
            count: state.count,
            needed: state.needed,
            startsAt: state.startsAt,
            note: `${state.name} unlocked. Plans start ${longDay(state.startsAt)}, and you’re not charged until then.`,
        };
    }
    return {
        neighborhood: state.name,
        key: state.key,
        count: state.count,
        needed: state.needed,
        note: waitlistNote(state.name, state.count),
    };
}

async function touchNeighborhood(key, fields) {
    const table = await getTable();
    const row = neighborhoodByKey(table, key);
    await NeighborhoodUnlock.updateOne(
        { key },
        {
            $setOnInsert: { key, borough: row ? row.borough : undefined, name: row ? row.name : undefined },
            ...(fields ? { $set: fields } : {}),
        },
        { upsert: true }
    );
}

// ---------------------------------------------------------------------------
// The unlock
// ---------------------------------------------------------------------------

async function pushTo(userId, title, body, data) {
    if (!userId) return;
    try {
        const user = await User.findById(userId).select('firebaseUid').lean();
        if (!user || !user.firebaseUid) return;
        const { sendPushNotification } = require('../controllers/notificationController');
        await sendPushNotification(user.firebaseUid, title, body, data || {});
    } catch (err) {
        console.error('neighborhoodUnlocks: push failed:', err.message);
    }
}

/**
 * Tells everyone waiting in a neighborhood that it moved (a card saved, a
 * member gone, the unlock), so an open app or /park page re-reads its count
 * then rather than on the next visit. Members already on a plan are left out:
 * nothing they see depends on the count.
 */
async function broadcast(key, reason) {
    try {
        const state = await stateFor(key);
        const members = await UnlockMember.find({
            neighborhood: key,
            status: { $in: ['invited', 'pending_card', 'waiting', 'scheduled', 'starting', 'failed'] },
            user: { $exists: true },
        })
            .select('user')
            .lean();
        const payload = {
            neighborhood: key,
            reason,
            count: state ? state.count : null,
            needed: UNLOCK_AT,
            unlocked: !!(state && state.unlocked),
            startsAt: (state && state.startsAt) || null,
        };
        for (const id of new Set(members.map((m) => String(m.user)))) realtime.toUser(id, 'waitlistUpdated', payload);
    } catch (err) {
        console.error('neighborhoodUnlocks: broadcast failed:', err.message);
    }
}

/** The same event for one member whose own plan moved (started, failed). */
function tellMember(member, reason) {
    realtime.toUser(member.user, 'waitlistUpdated', { neighborhood: member.neighborhood, reason });
}

/**
 * What the member's card is charged on the start day, after their code: a
 * free trial charges nothing for its days, a discount comes off the first
 * bill. { cents, freeDays }.
 */
async function startCharge(member) {
    const amount = member.plan.amountCents;
    if (!member.plan.promoCode) return { cents: amount, freeDays: 0 };
    const { findPromo, isDiscount, discountedCents } = require('./subscriptionPromos');
    let promo = null;
    try {
        promo = await findPromo(member.plan.promoCode);
    } catch (err) {
        console.error('neighborhoodUnlocks: promo lookup failed:', err.message);
    }
    if (promo && promo.kind === 'free_trial' && promo.trialDays) return { cents: 0, freeDays: promo.trialDays };
    if (promo && isDiscount(promo)) return { cents: discountedCents(promo, amount), freeDays: 0 };
    return { cents: amount, freeDays: 0 };
}

/** "Your card is charged $725 that morning." or "The first 90 days are free." */
function startChargeLine(charge, when = 'that morning') {
    return charge.freeDays
        ? `The first ${charge.freeDays} days are free.`
        : `Your card is charged ${dollars(charge.cents)} ${when}.`;
}

/**
 * Unlock the neighborhood if it has reached 10. Safe to call after every
 * saved card: the conditional update lets exactly one caller win.
 * Returns { unlocked: true, startsAt } for the winner, or { unlocked: false }.
 */
async function checkUnlock(key, now = new Date()) {
    const count = await countFor(key);
    if (count < UNLOCK_AT) return { unlocked: false, count };
    const startsAt = startDateAfter(now);
    const table = await getTable();
    const row = neighborhoodByKey(table, key);
    let won;
    try {
        won = await NeighborhoodUnlock.findOneAndUpdate(
            { key, unlockedAt: { $exists: false } },
            {
                $set: { unlockedAt: now, startsAt },
                $setOnInsert: { key, borough: row && row.borough, name: row && row.name },
            },
            { upsert: true, new: true }
        );
    } catch (err) {
        // The row exists and is already unlocked, so the upsert tried to
        // insert a second one. Someone else won.
        if (err && err.code === 11000) return { unlocked: false, count };
        throw err;
    }
    if (!won) return { unlocked: false, count };

    await UnlockMember.updateMany(
        { neighborhood: key, status: 'waiting' },
        { $set: { status: 'scheduled', startsAt } }
    );
    const name = (row && row.name) || key;
    await operatorAlert.raise({
        kind: 'neighborhood_unlocked',
        severity: operatorAlert.SEVERITY.WARN,
        dateKey: undefined,
        title: `${name} unlocked: station a valet`,
        detail: `${count} subscribers have a card saved in ${name}. Their plans start ${longDay(startsAt)} at 8 AM ET, and their cards are charged then.`,
        payload: { Neighborhood: name, Subscribers: count, Starts: startsAt.toISOString() },
    });
    await NeighborhoodUnlock.updateOne({ key }, { $set: { alertedAt: new Date() } });

    const members = await UnlockMember.find({ neighborhood: key, status: 'scheduled', unlockNotifiedAt: { $exists: false } });
    for (const m of members) {
        await pushTo(
            m.user,
            `${name} unlocked`,
            `Your Permanent valet plan starts ${longDay(startsAt)}. ${startChargeLine(await startCharge(m))}`,
            { type: 'NEIGHBORHOOD_UNLOCKED', neighborhood: key }
        );
        await UnlockMember.updateOne({ _id: m._id }, { $set: { unlockNotifiedAt: new Date() } });
    }
    console.log(`neighborhoodUnlocks: ${key} unlocked at ${count}, plans start ${startsAt.toISOString()}`);
    return { unlocked: true, startsAt, count };
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** A SetupIntent for this member's card: $0 today, saved for the start. */
async function setupIntentFor(member, user) {
    const stripe = requireStripe();
    const { ensureStripeCustomer } = require('../controllers/subscriptionController');
    const customerId = await ensureStripeCustomer(user);
    const intent = await stripe.setupIntents.create({
        customer: customerId,
        usage: 'off_session',
        automatic_payment_methods: { enabled: true },
        metadata: {
            // The webhook keys off this (paymentController).
            purpose: 'unlock_member',
            unlockMemberId: String(member._id),
            userId: String(user._id),
        },
    });
    member.stripeCustomerId = customerId;
    member.setupIntentId = intent.id;
    await member.save();
    const ephemeralKey = await stripe.ephemeralKeys.create(
        { customer: customerId },
        { apiVersion: '2024-06-20' }
    );
    return {
        mode: 'setup',
        clientSecret: intent.client_secret,
        setupIntentClientSecret: intent.client_secret,
        customerId,
        customerEphemeralKeySecret: ephemeralKey.secret,
        dueTodayCents: 0,
    };
}

/**
 * The SetupIntent cleared: record the card, then either wait, unlock the
 * neighborhood, or start the plan now if it is already unlocked.
 * Idempotent: a member past pending_card/invited is returned as it is.
 */
async function markCardSaved(member, paymentMethodId, now = new Date()) {
    if (!['pending_card', 'invited'].includes(member.status)) return member;
    const stripe = stripeClient.get();
    let brand;
    let last4;
    if (stripe && paymentMethodId) {
        try {
            const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
            brand = pm.card && pm.card.brand;
            last4 = pm.card && pm.card.last4;
        } catch (err) {
            console.error('neighborhoodUnlocks: card lookup failed:', err.message);
        }
        if (member.stripeCustomerId) {
            try {
                await stripe.customers.update(member.stripeCustomerId, {
                    invoice_settings: { default_payment_method: paymentMethodId },
                });
            } catch (err) {
                console.error('neighborhoodUnlocks: default card update failed:', err.message);
            }
        }
    }
    const state = await stateFor(member.neighborhood);
    // Unlocked: start with the neighborhood's start date, or now once that
    // has passed. Otherwise wait for the 10th.
    const startAt = state && state.unlocked ? (state.startsAt && new Date(state.startsAt) > now ? new Date(state.startsAt) : now) : null;
    const claimed = await UnlockMember.findOneAndUpdate(
        { _id: member._id, status: { $in: ['pending_card', 'invited'] } },
        {
            $set: {
                paymentMethodId,
                cardBrand: brand,
                cardLast4: last4,
                cardSavedAt: now,
                // Unlocked already: start now. Otherwise wait for the 10th.
                status: startAt ? 'scheduled' : 'waiting',
                ...(startAt ? { startsAt: startAt } : {}),
            },
        },
        { new: true }
    );
    if (!claimed) return UnlockMember.findById(member._id);
    await touchNeighborhood(member.neighborhood, { lastNewSubscriberAt: now });
    if (claimed.source === 'self') await closeOpenInvites(claimed, now);

    if (claimed.status === 'scheduled' && claimed.startsAt <= now) {
        await startMember(claimed, { now });
        await broadcast(member.neighborhood, 'count');
        return UnlockMember.findById(member._id);
    }
    const unlock = await checkUnlock(member.neighborhood, now);
    await broadcast(member.neighborhood, unlock.unlocked ? 'unlocked' : 'count');
    return unlock.unlocked ? UnlockMember.findById(member._id) : claimed;
}

/**
 * Someone who joined on their own (or with a code) leaves any rep's open
 * invite to their number unanswered. It is closed, so that rep's portal stops
 * chasing them; the invite they didn't use earns nothing (agreement, s. 4).
 */
async function closeOpenInvites(member, now) {
    const user = await User.findById(member.user).select('phone').lean();
    const ten = phoneCode(user && user.phone);
    if (!ten) return;
    await UnlockMember.updateMany(
        {
            _id: { $ne: member._id },
            source: 'rep',
            status: { $in: ['invited', 'pending_card'] },
            liveUser: { $exists: false },
            'contact.phone': { $in: [ten, `+1${ten}`, `1${ten}`] },
        },
        { $set: { status: 'left', endedAt: now, endedBecause: 'joined_elsewhere' } }
    );
}

/** Ask Stripe whether the member's SetupIntent has cleared, and act on it. */
async function confirmCard(member, now = new Date()) {
    if (!['pending_card', 'invited'].includes(member.status) || !member.setupIntentId) return member;
    const stripe = requireStripe();
    const intent = await stripe.setupIntents.retrieve(member.setupIntentId);
    if (intent.status !== 'succeeded') return member;
    const pm = typeof intent.payment_method === 'string' ? intent.payment_method : intent.payment_method && intent.payment_method.id;
    return markCardSaved(member, pm, now);
}

/** setup_intent.succeeded with purpose 'unlock_member'. */
async function applySetupIntentSucceeded(intent) {
    const id = intent && intent.metadata && intent.metadata.unlockMemberId;
    if (!id) return { handled: false, reason: 'no_member' };
    const member = await UnlockMember.findById(id);
    if (!member) return { handled: false, reason: 'unknown_member' };
    if (member.setupIntentId && member.setupIntentId !== intent.id) return { handled: true, ignored: 'stale_intent' };
    const pm = typeof intent.payment_method === 'string' ? intent.payment_method : intent.payment_method && intent.payment_method.id;
    const after = await markCardSaved(member, pm);
    return { handled: true, status: after && after.status };
}

// ---------------------------------------------------------------------------
// The start: the one place a member is charged
// ---------------------------------------------------------------------------

async function failStart(member, reason, { alert = true } = {}) {
    await UnlockMember.updateOne({ _id: member._id }, { $set: { status: 'failed', startError: String(reason).slice(0, 300) } });
    if (alert) {
        await operatorAlert.raise({
            kind: 'unlock_start_failed',
            severity: operatorAlert.SEVERITY.WARN,
            customer: member.user,
            title: `A ${member.neighborhoodName || member.neighborhood} plan did not start`,
            detail: String(reason).slice(0, 300),
            payload: { Member: String(member._id), Neighborhood: member.neighborhood },
        });
    }
    await pushTo(
        member.user,
        'Your plan did not start',
        'We could not charge your card for Permanent valet. Open the app to update it.',
        { type: 'UNLOCK_START_FAILED' }
    );
    tellMember(member, 'failed');
}

/**
 * Create and charge the member's subscription. Claims the row first, so two
 * job passes (or a job pass and a card saved in an unlocked neighborhood)
 * cannot both get here for the same member.
 * Returns { outcome: 'started' | 'not_claimed' | 'failed', subscription? }.
 */
async function startMember(member, { now = new Date() } = {}) {
    const claimed = await UnlockMember.findOneAndUpdate(
        {
            _id: member._id,
            subscription: { $exists: false },
            $or: [
                { status: 'scheduled', startsAt: { $lte: now } },
                { status: 'starting', startClaimedAt: { $lte: new Date(now.getTime() - STUCK_START_MS) } },
            ],
        },
        { $set: { status: 'starting', startClaimedAt: now } },
        { new: true }
    );
    if (!claimed) return { outcome: 'not_claimed' };
    const m = claimed;

    try {
        if (!m.user) return failStartWith(m, 'The invite was never claimed by an account.');
        if (!m.paymentMethodId || !m.stripeCustomerId) return failStartWith(m, 'No saved card.');
        const live = await Subscription.findOne({ user: m.user, status: { $in: ['active', 'past_due'] } });
        if (live && String(live.unlockMember || '') !== String(m._id)) {
            return failStartWith(m, 'The customer already has a live subscription.');
        }

        // A retry after a crash: the doc was made last time, Stripe's
        // idempotency key gives back the same subscription.
        let sub = await Subscription.findOne({ unlockMember: m._id });
        const stripe = requireStripe();
        const plan = getPlan(m.plan.tier || 'home_garage');
        const interval = m.plan.interval || 'month';
        const amountCents = m.plan.amountCents;
        const priceId = await resolveStripePrice({ garage: true, interval, unitAmountCents: amountCents });

        const { findPromo, isDiscount, ensureStripeCoupon } = require('./subscriptionPromos');
        const promo = m.plan.promoCode ? await findPromo(m.plan.promoCode) : null;
        const isTrial = !!promo && promo.kind === 'free_trial';
        const discounts = promo && isDiscount(promo) ? [{ coupon: await ensureStripeCoupon(promo) }] : undefined;

        const stripeSub = await stripe.subscriptions.create(
            {
                customer: m.stripeCustomerId,
                items: [{ price: priceId, quantity: 1 }],
                default_payment_method: m.paymentMethodId,
                off_session: true,
                // Nobody is at a payment sheet: a card that fails now fails
                // the call, and the member is marked for a human.
                payment_behavior: 'error_if_incomplete',
                ...(isTrial
                    ? {
                          trial_period_days: promo.trialDays,
                          trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
                      }
                    : {}),
                ...(discounts ? { discounts } : {}),
                metadata: {
                    userId: String(m.user),
                    tier: plan.tier,
                    interval,
                    unlockMemberId: String(m._id),
                    ...(promo ? { promoCode: promo.code } : {}),
                    ...(m.rep ? { repId: String(m.rep) } : {}),
                },
                expand: ['latest_invoice'],
            },
            { idempotencyKey: `unlock-start-${m._id}` }
        );

        const area = {
            borough: m.borough,
            neighborhood: m.neighborhoodName,
            key: m.neighborhood,
            label: m.neighborhoodName,
        };
        if (!sub) {
            sub = new Subscription({
                user: m.user,
                tier: plan.tier,
                interval,
                status: 'incomplete',
                amountCents,
                movesPerWeek: 2,
                stripeCustomerId: m.stripeCustomerId,
                stripeSubscriptionId: stripeSub.id,
                stripePriceId: priceId,
                homeAddress: m.homeAddress,
                ...(promo ? { promoCode: promo.code } : {}),
                ...(stripeSub.trial_end ? { trialEndsAt: new Date(stripeSub.trial_end * 1000) } : {}),
                pricing: pricingSnapshot({ amountCents, area, commissionCents: m.plan.commissionCents }, now),
                unlockMember: m._id,
                ...(m.rep
                    ? { rep: m.rep, ...(typeof m.plan.commissionCents === 'number' ? { repCommissionCents: m.plan.commissionCents } : {}) }
                    : promo && promo.rep
                    ? { rep: promo.rep, ...(typeof m.plan.commissionCents === 'number' ? { repCommissionCents: m.plan.commissionCents } : {}) }
                    : {}),
                ...(m.referredBy ? { referredBy: m.referredBy, referralCode: m.referralCode } : {}),
            });
            await sub.save();
        }

        if (!['active', 'trialing'].includes(stripeSub.status)) {
            return failStartWith(m, `Stripe left the subscription ${stripeSub.status}.`);
        }
        const { activateLocal } = require('../controllers/subscriptionController');
        const invoice = stripeSub.latest_invoice && typeof stripeSub.latest_invoice === 'object' ? stripeSub.latest_invoice : null;
        await activateLocal(sub, invoice, stripeSub);
        await UnlockMember.updateOne(
            { _id: m._id },
            { $set: { status: 'active', startedAt: now, subscription: sub._id }, $unset: { startError: 1 } }
        );
        await pushTo(
            m.user,
            'Your Permanent valet plan started',
            `Your valet in ${m.neighborhoodName} is ready. Park your car from the app.`,
            { type: 'UNLOCK_STARTED' }
        );
        tellMember(m, 'started');
        console.log(`neighborhoodUnlocks: started member ${m._id} -> subscription ${sub._id}`);
        return { outcome: 'started', subscription: sub };
    } catch (err) {
        console.error('neighborhoodUnlocks: start failed for', String(m._id), err.message);
        await failStart(m, err.message || 'The charge failed.');
        return { outcome: 'failed', error: err.message };
    }
}

async function failStartWith(member, reason) {
    await failStart(member, reason);
    return { outcome: 'failed', error: reason };
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/**
 * One pass, every minute from server.js:
 *   - start every scheduled member whose start time has come (and retry a
 *     start that was claimed and never finished)
 *   - the day-before reminder
 */
async function tick({ now = new Date() } = {}) {
    const results = { started: 0, failed: 0, reminded: 0 };
    const due = await UnlockMember.find({
        subscription: { $exists: false },
        $or: [
            { status: 'scheduled', startsAt: { $lte: now } },
            { status: 'starting', startClaimedAt: { $lte: new Date(now.getTime() - STUCK_START_MS) } },
        ],
    }).select('_id');
    for (const { _id } of due) {
        const member = await UnlockMember.findById(_id);
        const r = await startMember(member, { now });
        if (r.outcome === 'started') results.started += 1;
        if (r.outcome === 'failed') results.failed += 1;
    }

    const soon = await UnlockMember.find({
        status: 'scheduled',
        remindedAt: { $exists: false },
        startsAt: { $gt: now, $lte: new Date(now.getTime() + REMIND_BEFORE_MS) },
    });
    for (const m of soon) {
        // Claimed first, so two processes send one reminder.
        const won = await UnlockMember.updateOne({ _id: m._id, remindedAt: { $exists: false } }, { $set: { remindedAt: now } });
        if (!won.modifiedCount) continue;
        await pushTo(
            m.user,
            'Your plan starts tomorrow',
            `Your Permanent valet plan starts at 8 AM tomorrow. ${startChargeLine(await startCharge(m), 'then')}`,
            { type: 'UNLOCK_REMINDER' }
        );
        results.reminded += 1;
    }
    return results;
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

async function liveMemberFor(userId) {
    if (!userId) return null;
    return UnlockMember.findOne({ user: userId, status: { $in: LIVE_STATUSES } }).sort({ createdAt: -1 });
}

/** End a row's life: it no longer holds the customer's one live slot. */
async function endMember(member, status, now = new Date()) {
    const ended = await UnlockMember.findOneAndUpdate(
        { _id: member._id, status: { $in: ['invited', 'pending_card', 'waiting', 'scheduled', 'failed', 'active'] } },
        { $set: { status, endedAt: now }, $unset: { liveUser: 1 } },
        { new: true }
    );
    if (ended && COUNTED_STATUSES.includes(member.status)) await broadcast(member.neighborhood, 'count');
    return ended;
}

/**
 * A self-signup's membership in a locked neighborhood, made (or remade) by
 * /create. A pending_card row from an abandoned sheet is replaced; a member
 * whose card is already saved is told so.
 * Returns { member } or { error, status }.
 */
async function joinAsSelf({ user, quote, promo, referral, homeAddress, now = new Date() }) {
    const existing = await liveMemberFor(user._id);
    if (existing) {
        if (['pending_card', 'invited'].includes(existing.status) && existing.source === 'self') {
            await endMember(existing, 'left', now);
        } else if (existing.status !== 'active') {
            return {
                status: 400,
                error: `You’re already on the ${existing.neighborhoodName} waitlist.`,
                code: 'ALREADY_WAITING',
            };
        }
    }
    const member = await UnlockMember.create({
        neighborhood: quote.area.key,
        borough: quote.area.borough,
        neighborhoodName: quote.area.label,
        source: 'self',
        status: 'pending_card',
        user: user._id,
        liveUser: user._id,
        ...(promo && promo.rep ? { rep: promo.rep } : {}),
        ...(referral ? { referredBy: referral.userId, referralCode: referral.code } : {}),
        plan: {
            tier: quote.tier,
            interval: quote.interval,
            amountCents: quote.amountCents,
            commissionCents: quote.commissionCents,
            ...(promo && promo.kind !== 'referral' ? { promoCode: promo.code } : {}),
        },
        homeAddress: { streetAddress: homeAddress.streetAddress, lat: homeAddress.lat, lng: homeAddress.lng },
    });
    return { member };
}

/**
 * Keep the unlock tree honest about a plan that started outside a waitlist:
 * a customer who subscribed after their neighborhood unlocked. Called from
 * activateLocal, which also runs on every renewal, so it does nothing once
 * the subscription points at a member.
 */
async function recordActiveSubscription(sub, now = new Date()) {
    if (!sub || sub.unlockMember || sub.tier !== 'home_garage') return null;
    const key = sub.pricing && sub.pricing.neighborhoodKey;
    if (!key) return null;
    const existing = await liveMemberFor(sub.user);
    let member;
    if (existing && existing.status !== 'active') {
        // A waiting row they abandoned by buying here instead. It stops
        // counting toward its neighborhood.
        await endMember(existing, 'left', now);
    }
    try {
        member = await UnlockMember.create({
            neighborhood: key,
            borough: sub.pricing.borough,
            neighborhoodName: sub.pricing.neighborhood,
            source: 'self',
            status: 'active',
            user: sub.user,
            ...(existing && existing.status === 'active' ? {} : { liveUser: sub.user }),
            ...(sub.rep ? { rep: sub.rep } : {}),
            ...(sub.referredBy ? { referredBy: sub.referredBy, referralCode: sub.referralCode } : {}),
            plan: {
                tier: sub.tier,
                interval: sub.interval,
                amountCents: sub.amountCents,
                commissionCents: sub.pricing.commissionCents,
                ...(sub.promoCode ? { promoCode: sub.promoCode } : {}),
            },
            homeAddress: sub.homeAddress,
            cardSavedAt: now,
            startedAt: now,
            subscription: sub._id,
        });
    } catch (err) {
        console.error('neighborhoodUnlocks: could not record subscriber', String(sub._id), err.message);
        return null;
    }
    await Subscription.updateOne({ _id: sub._id }, { $set: { unlockMember: member._id } });
    sub.unlockMember = member._id;
    await touchNeighborhood(key, { lastNewSubscriberAt: now });
    await broadcast(key, 'count');
    return member;
}

/** The plan a member started was cancelled: they stop counting. */
async function subscriptionEnded(sub, now = new Date()) {
    if (!sub || !sub.unlockMember) return;
    const ended = await UnlockMember.findOneAndUpdate(
        { _id: sub.unlockMember, status: 'active' },
        { $set: { status: 'cancelled', endedAt: now }, $unset: { liveUser: 1 } }
    );
    if (ended) await broadcast(ended.neighborhood, 'count');
}

// ---------------------------------------------------------------------------
// Rep invites (the portal creates them; the customer takes them from here)
// ---------------------------------------------------------------------------

function newInviteToken() {
    return crypto.randomBytes(18).toString('base64url');
}

/**
 * A rep's new subscriber, waiting for the customer to open the link.
 * Phone and address are required (spec v2, 18). Returns { member } or { error }.
 */
async function createRepInvite({ rep, phone, homeAddress, name, email, vehicle, notes, interval = 'month' }) {
    if (!rep) return { error: 'A rep is required.' };
    if (!phone || !String(phone).trim()) return { error: 'Phone is required.' };
    if (!homeAddress || typeof homeAddress.lat !== 'number' || typeof homeAddress.lng !== 'number' || !homeAddress.streetAddress) {
        return { error: 'Address is required.' };
    }
    const table = await getTable();
    const price = garagePriceAt(table, homeAddress, interval);
    if (!price) {
        const { NOT_OFFERED_MESSAGE } = require('./neighborhoodPricing');
        return { error: NOT_OFFERED_MESSAGE };
    }
    const member = await UnlockMember.create({
        neighborhood: price.key,
        borough: price.borough,
        neighborhoodName: price.label,
        source: 'rep',
        status: 'invited',
        rep,
        plan: { tier: 'home_garage', interval, amountCents: price.amountCents, commissionCents: price.commissionCents },
        homeAddress: { streetAddress: homeAddress.streetAddress, lat: homeAddress.lat, lng: homeAddress.lng },
        ...(vehicle ? { vehicle } : {}),
        contact: { name, phone: String(phone).trim(), email },
        ...(notes ? { notes } : {}),
        inviteToken: newInviteToken(),
    });
    return { member };
}

/** Change the address or the car on a member who has not started. Repriced at the new address. */
async function editMember(member, { homeAddress, vehicle } = {}) {
    if (!['invited', 'pending_card', 'waiting', 'scheduled'].includes(member.status)) {
        return { error: 'This plan has already started. Change it from your subscription.' };
    }
    if (vehicle) {
        member.vehicle = {
            color: vehicle.color !== undefined ? vehicle.color : member.vehicle && member.vehicle.color,
            model: vehicle.model !== undefined ? vehicle.model : member.vehicle && member.vehicle.model,
            licensePlate:
                vehicle.licensePlate !== undefined ? vehicle.licensePlate : member.vehicle && member.vehicle.licensePlate,
        };
    }
    if (homeAddress) {
        if (typeof homeAddress.lat !== 'number' || typeof homeAddress.lng !== 'number' || !homeAddress.streetAddress) {
            return { error: 'Address is required.' };
        }
        const table = await getTable();
        const price = garagePriceAt(table, homeAddress, member.plan.interval || 'month');
        if (!price) {
            const { NOT_OFFERED_MESSAGE } = require('./neighborhoodPricing');
            return { error: NOT_OFFERED_MESSAGE, code: 'NOT_OFFERED' };
        }
        const moved = price.key !== member.neighborhood;
        if (moved && ['waiting', 'scheduled'].includes(member.status)) {
            // A saved card moves with them, but into the new neighborhood's
            // count, so the old one may un-schedule nothing (it is already
            // unlocked or still counting) and the new one may now unlock.
            member.status = 'waiting';
            member.startsAt = undefined;
        }
        member.neighborhood = price.key;
        member.borough = price.borough;
        member.neighborhoodName = price.label;
        member.plan.amountCents = price.amountCents;
        member.plan.commissionCents = price.commissionCents;
        member.homeAddress = { streetAddress: homeAddress.streetAddress, lat: homeAddress.lat, lng: homeAddress.lng };
        await member.save();
        if (moved && member.status === 'waiting') {
            const state = await stateFor(member.neighborhood);
            if (state && state.unlocked) {
                const now = new Date();
                const startAt = state.startsAt && new Date(state.startsAt) > now ? new Date(state.startsAt) : now;
                await UnlockMember.updateOne({ _id: member._id }, { $set: { status: 'scheduled', startsAt: startAt } });
                if (startAt <= now) await startMember(await UnlockMember.findById(member._id));
            } else {
                await checkUnlock(member.neighborhood);
            }
        }
        return { member: await UnlockMember.findById(member._id) };
    }
    await member.save();
    return { member };
}

// ---------------------------------------------------------------------------
// What the screens show
// ---------------------------------------------------------------------------

async function repFirstName(repId) {
    if (!repId) return null;
    try {
        const Rep = require('../models/Rep');
        const rep = await Rep.findById(repId).select('name').lean();
        return rep ? firstName(rep.name) : null;
    } catch (err) {
        return null;
    }
}

/**
 * Everything the invite, joined, scheduled and home screens render for a
 * member, with the mockups' copy filled in.
 */
async function memberView(member, now = new Date()) {
    const state = await stateFor(member.neighborhood);
    const name = member.neighborhoodName || (state && state.name);
    const unit = member.plan.interval === 'week' ? '/wk' : '/mo';
    const amount = dollars(member.plan.amountCents);
    const charge = await startCharge(member);
    const street = shortStreet(member.homeAddress);
    const rep = await repFirstName(member.rep);
    const count = state ? state.count : 0;
    const unlocked = !!(state && state.unlocked);
    const startsAt = member.startsAt || (state && state.startsAt) || null;
    const card = cardLabel(member);
    const repSet = rep ? ` ${rep}, your Valet Network rep, set this up.` : '';

    // Which invite screen: the neighborhood is live, they would be the 10th,
    // or it is still filling up.
    let variant = 'invite';
    if (unlocked) variant = 'live';
    else if (count === UNLOCK_AT - 1) variant = 'last';

    const copy = {
        priceLine: `${amount}${unit} · Permanent valet in ${name}`,
        progress: `${count} of ${UNLOCK_AT} in ${name}`,
    };
    if (variant === 'invite') {
        Object.assign(copy, {
            title: `Permanent valet at ${street}`,
            body: `${repSet.trim()} ${name} unlocks at ${UNLOCK_AT} subscribers. You’re not charged until it does.`.trim(),
            cta: 'Add a card and join',
            fine: `Your card is charged ${amount}${unit} after ${name} unlocks.`,
            secondary: 'Not for me',
        });
    } else if (variant === 'last') {
        const others = UNLOCK_AT - 1;
        Object.assign(copy, {
            eyebrow: `${name.toUpperCase()} · ${others} OF ${UNLOCK_AT}`,
            title: `You’re the last one ${name} needs!`,
            body: `Join your neighbors on Valet Network. When you join, Permanent valet unlocks for you and ${others} neighbors.${repSet}`,
            neighbors: `${others} neighbors in`,
            cta: `Add a card and unlock ${name}`,
            fine: `Plans start ${longDay(startDateAfter(now))}.`,
            secondary: 'Not for me',
        });
    } else {
        const people = count === 1 ? `1 neighbor in ${inName(name)} already has` : `${count} neighbors in ${inName(name)} already have`;
        Object.assign(copy, {
            eyebrow: `${name.toUpperCase()} IS LIVE`,
            title: 'Join your neighbors on Valet Network',
            body: `${people} Permanent valet.${rep ? ` ${rep}, your Valet Network rep, set yours up.` : ''}`,
            cta: 'Add a card and start',
            fine: 'Your plan starts as soon as your card is saved.',
            secondary: 'Not for me',
        });
    }

    // After the card: waiting, or a start date.
    let after = null;
    if (member.status === 'waiting') {
        after = {
            title: `You’re in. ${name} is almost there.`,
            body: `It starts when ${name} reaches ${UNLOCK_AT} subscribers. We’ll tell you the day before ${charge.freeDays ? 'it starts' : 'your card is charged'}.`,
            progress: copy.progress,
            secondary: 'Cancel before it starts',
            fine: 'Nothing is charged until the start date.',
        };
    } else if (member.status === 'scheduled' && startsAt) {
        const day = nyClock(startsAt);
        const renews =
            member.plan.interval === 'week'
                ? `After that it renews every ${fmt(startsAt, { weekday: 'long' })}.`
                : `After that it renews on the ${ordinal(day.day)} of each month.`;
        after = {
            title: `Starts ${longDay(startsAt)}`,
            body: charge.freeDays
                ? `Your Permanent valet plan starts that morning. The first ${charge.freeDays} days are free, then ${amount}${unit} on your ${card || 'card'}.`
                : `Your ${card || 'card'} is charged ${dollars(charge.cents)} that morning and your Permanent valet plan starts. ${renews}`,
            badge: `${name} unlocked`,
            secondary: 'Cancel before it starts',
        };
    }

    return {
        id: String(member._id),
        _id: String(member._id),
        status: member.status,
        source: member.source,
        variant,
        neighborhood: { key: member.neighborhood, name, borough: member.borough },
        count,
        needed: UNLOCK_AT,
        unlocked,
        startsAt,
        amountCents: member.plan.amountCents,
        interval: member.plan.interval,
        homeAddress: member.homeAddress,
        vehicle: member.vehicle || null,
        card,
        cardBrand: member.cardBrand || null,
        cardLast4: member.cardLast4 || null,
        startedAt: member.startedAt || null,
        unlock: {
            label: name,
            count,
            needed: UNLOCK_AT,
            unlocked,
            startsAt,
            // live = unlocked and its start date has come.
            status: unlocked ? (startsAt && new Date(startsAt) <= now ? 'live' : 'unlocked') : 'locked',
            live: !!(unlocked && startsAt && new Date(startsAt) <= now),
        },
        price: {
            amountCents: member.plan.amountCents,
            interval: member.plan.interval,
            label: copy.priceLine,
            // The start day's charge after their code, and a free trial's days.
            firstChargeCents: charge.cents,
            freeDays: charge.freeDays,
        },
        rep: rep ? { firstName: rep } : null,
        copy,
        after,
        // The home screen's invitation card (NewHomeInvite).
        home:
            member.status === 'invited'
                ? {
                      eyebrow: 'INVITATION',
                      title: `Permanent valet at ${street}`,
                      body: `${rep ? `${rep}, your Valet Network rep, set this up for you. ` : ''}${name} unlocks at ${UNLOCK_AT} subscribers.`,
                      progress: copy.progress,
                      cta: 'See the invite',
                  }
                : null,
    };
}

module.exports = {
    UNLOCK_AT,
    startDateAfter,
    waitlistNote,
    shortStreet,
    stateFor,
    countFor,
    waitlistForQuote,
    checkUnlock,
    broadcast,
    setupIntentFor,
    markCardSaved,
    confirmCard,
    applySetupIntentSucceeded,
    startMember,
    tick,
    liveMemberFor,
    endMember,
    joinAsSelf,
    recordActiveSubscription,
    subscriptionEnded,
    createRepInvite,
    editMember,
    memberView,
    newInviteToken,
};
