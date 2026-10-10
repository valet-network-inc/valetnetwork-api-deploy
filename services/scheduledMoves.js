/**
 * Park my car and Bring my car back, booked for later (spec v2, 8).
 *
 * The customer picks Now or Schedule inside those flows; Schedule stores a
 * ScheduledMove (once, every weekday, every day, or picked days, at a New
 * York wall-clock time). This job turns each occurrence into the same order
 * the app would have made, through the same endpoints, so coverage, pricing,
 * custody and dispatch are exactly today's:
 *   - a pick-up becomes a park order with pickUpTime = the occurrence,
 *     created PICKUP_LEAD before it; services/scheduledDispatch.js sends it to
 *     valets 45 minutes out, as with any advance booking;
 *   - a drop-off becomes a retrieval of the parked car, created DROPOFF_LEAD
 *     before the time the customer wants the car, and dispatched at once.
 * Each occurrence is claimed atomically (lastKey) before anything is made, so
 * two ticks or two servers make one order.
 *
 * Everyone can schedule.
 *   - On a plan that includes the move (Permanent valet, Valet anywhere) a
 *     run is covered. A run the plan doesn't cover is never charged: the
 *     order is cancelled and the customer is told.
 *   - Without a plan, a pick-up is a park-and-hold at the per-use price,
 *     charged off-session to the customer's saved card when the job books it
 *     (PICKUP_LEAD before). The valet keeps the keys, so the drop-off that
 *     brings it back is already paid for. A declined card cancels that run
 *     and tells the customer; a repeating move tries again next time. A card
 *     has to be on file to schedule: POST /card saves one at $0.
 */
const axios = require('axios');
const ScheduledMove = require('../models/ScheduledMove');
const Order = require('../models/Order');
const User = require('../models/User');
const { nyClock, nyWallTimeToInstant } = require('./nyTime');
const stripeClient = require('./stripeClient');
const orderPricing = require('./orderPricing');

const PICKUP_LEAD_MS = 50 * 60 * 1000;
const DROPOFF_LEAD_MS = 45 * 60 * 1000;
const MIN_NOTICE_MS = 45 * 60 * 1000;
const GIVE_UP_AFTER_MS = 15 * 60 * 1000;
const MANAGED_TIERS = ['home_garage', 'valet_anywhere'];
const REPEATS = ['once', 'weekdays', 'daily', 'days'];

function base() {
    return process.env.PUBLIC_BACKEND_URL || `http://127.0.0.1:${process.env.PORT || 8080}`;
}

function parseTime(time) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(time || ''));
    return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

function keyOf(at) {
    return new Date(at).toISOString();
}

function runsOn(move, weekday) {
    if (move.repeat === 'daily' || move.repeat === 'once') return true;
    if (move.repeat === 'weekdays') return weekday >= 1 && weekday <= 5;
    return (move.days || []).includes(weekday);
}

/** The first occurrence strictly after `from`, or null (a 'once' that has passed). */
function occurrenceAfter(move, from) {
    const t = parseTime(move.time);
    if (!t) return null;
    const start = nyClock(from);
    for (let i = 0; i < 9; i++) {
        const noon = nyWallTimeToInstant(start.year, start.month, start.day, 12, 0);
        const day = nyClock(new Date(noon.getTime() + i * 24 * 60 * 60 * 1000));
        if (!runsOn(move, day.weekday)) continue;
        const at = nyWallTimeToInstant(day.year, day.month, day.day, t.hour, t.minute);
        if (at <= from) continue;
        if ((move.skipped || []).includes(keyOf(at))) continue;
        return at;
    }
    return null;
}

/** "08:00" for an instant, in New York. */
function timeOf(at) {
    const c = nyClock(at);
    return `${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`;
}

async function managedSubscription(userId) {
    const subscriptionService = require('./subscriptionService');
    const sub = await subscriptionService.getActiveSubscription(userId);
    return sub && MANAGED_TIERS.includes(sub.tier) ? sub : null;
}

/** A plan's park has no end time; the app sends 24 hours for one, and a
 *  scheduled park without a plan is held overnight the same way. */
const PARK_MINUTES = 24 * 60;

/** What a scheduled pick-up costs without a plan: a park-and-hold. */
async function pickUpCents() {
    const q = await orderPricing.priceOrderCents({ orderType: 'parking', serviceType: 'park-and-hold', duration: PARK_MINUTES, carWatch: false, aspMode: false });
    return q.amountCents;
}

/**
 * The card a pick-up without a plan is charged to: the customer's default
 * card, else the newest one on their Stripe customer. Null when there is none.
 */
async function savedCard(userId) {
    const stripe = stripeClient.get();
    if (!stripe) return null;
    const user = await User.findById(userId).select('stripeCustomerId').lean();
    if (!user || !user.stripeCustomerId) return null;
    try {
        const customer = await stripe.customers.retrieve(user.stripeCustomerId);
        const preferred = customer && !customer.deleted && customer.invoice_settings && customer.invoice_settings.default_payment_method;
        let pm = null;
        if (preferred) pm = typeof preferred === 'string' ? await stripe.paymentMethods.retrieve(preferred) : preferred;
        if (!pm || !pm.card) {
            const list = await stripe.paymentMethods.list({ customer: user.stripeCustomerId, type: 'card', limit: 1 });
            pm = (list && list.data && list.data[0]) || null;
        }
        if (!pm || !pm.card) return null;
        return { customerId: user.stripeCustomerId, paymentMethodId: pm.id, brand: pm.card.brand, last4: pm.card.last4 };
    } catch (err) {
        console.error('scheduledMoves: card lookup failed:', err.message);
        return null;
    }
}

const dollars = (cents) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const brandName = (b) => (b ? b.charAt(0).toUpperCase() + b.slice(1) : 'Card');

/** For the review screen: what a run costs this customer, and the card it goes on. */
async function quote(userId) {
    const sub = await managedSubscription(userId);
    if (sub) return { plan: true, pickUpCents: 0, dropOffCents: 0, card: null, cardRequired: false };
    const [cents, card] = await Promise.all([pickUpCents(), savedCard(userId)]);
    return {
        plan: false,
        pickUpCents: cents,
        dropOffCents: 0,
        card: card ? { brand: card.brand, last4: card.last4, label: `${brandName(card.brand)} ending ${card.last4}` } : null,
        cardRequired: !card,
    };
}

/** A $0 card save for scheduling without a plan (the clients' setup sheet). */
async function cardSetup(userId) {
    const stripe = stripeClient.get();
    if (!stripe) return { status: 503, error: 'Payments are unavailable right now. Try again soon.' };
    const user = await User.findById(userId);
    if (!user) return { status: 404, error: 'Not found.' };
    const { ensureStripeCustomer } = require('../controllers/subscriptionController');
    const customerId = await ensureStripeCustomer(user);
    const intent = await stripe.setupIntents.create({
        customer: customerId,
        usage: 'off_session',
        automatic_payment_methods: { enabled: true },
        metadata: { purpose: 'schedule_card', userId: String(user._id) },
    });
    const ephemeralKey = await stripe.ephemeralKeys.create({ customer: customerId }, { apiVersion: '2024-06-20' });
    return {
        clientSecret: intent.client_secret,
        setupIntentClientSecret: intent.client_secret,
        setupIntentId: intent.id,
        customerId,
        customerEphemeralKeySecret: ephemeralKey.secret,
    };
}

function shortStreet(address) {
    return String((address && address.streetAddress) || '').split(',')[0].trim();
}

/** What the app and web render for a move (Home's "Coming up"). */
function view(move, sub, pickUpPriceCents = null) {
    const included = !!sub;
    const street = shortStreet(move.address);
    const verb = move.kind === 'drop-off' ? `Brought to ${street}` : `Collected from ${street}`;
    // Without a plan a pick-up is charged when it's booked; the drop-off
    // brings back a car whose return is already paid for.
    const priceCents = included || move.kind === 'drop-off' ? 0 : pickUpPriceCents;
    const detail = included
        ? `${verb} · Included`
        : move.kind === 'drop-off'
        ? `${verb} · Included with your park`
        : typeof priceCents === 'number'
        ? `${verb} · ${dollars(priceCents)}`
        : verb;
    return {
        _id: String(move._id),
        kind: move.kind,
        at: move.nextAt,
        repeat: move.repeat,
        days: move.days || [],
        time: move.time,
        address: move.address,
        included,
        priceCents,
        detail,
    };
}

function validate(input, { partial = false } = {}) {
    const out = {};
    if (!partial || input.kind !== undefined) {
        if (!['pick-up', 'drop-off'].includes(input.kind)) return { error: 'kind is pick-up or drop-off.' };
        out.kind = input.kind;
    }
    if (!partial || input.repeat !== undefined) {
        const repeat = input.repeat || 'once';
        if (!REPEATS.includes(repeat)) return { error: 'repeat is once, weekdays, daily or days.' };
        out.repeat = repeat;
        if (repeat === 'days') {
            const days = [...new Set((input.days || []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
            if (!days.length) return { error: 'Pick at least one day.' };
            out.days = days.sort();
        } else out.days = [];
    }
    if (!partial || input.address !== undefined) {
        const a = input.address || {};
        if (typeof a.lat !== 'number' || typeof a.lng !== 'number' || !a.streetAddress) return { error: 'Pick an address.' };
        out.address = { streetAddress: String(a.streetAddress), lat: a.lat, lng: a.lng };
    }
    if (!partial || input.at !== undefined) {
        const at = new Date(input.at);
        if (!Number.isFinite(at.getTime())) return { error: 'Pick a day and time.' };
        out.at = at;
    }
    return { value: out };
}

/** Book one. Returns { move } or { status, error }. */
async function create(userId, input, now = new Date()) {
    const sub = await managedSubscription(userId);
    // Without a plan each pick-up is charged when it's booked, so a card has
    // to be on file first.
    if (!sub && !(await savedCard(userId))) {
        return { status: 402, code: 'CARD_REQUIRED', error: 'Add a card first. Each pick-up is charged to it when it’s booked.' };
    }
    const { value, error } = validate(input);
    if (error) return { status: 400, error };
    if (value.at.getTime() - now.getTime() < MIN_NOTICE_MS) {
        return { status: 400, error: 'Pick a time at least 45 minutes from now.' };
    }
    const move = new ScheduledMove({ user: userId, kind: value.kind, repeat: value.repeat, days: value.days, time: timeOf(value.at), address: value.address });
    // The first run is the time they picked; repeats follow its wall-clock time.
    move.nextAt = value.repeat === 'once' || runsOn(move, nyClock(value.at).weekday) ? value.at : occurrenceAfter(move, value.at);
    await move.save();
    return { move: view(move, sub, sub ? null : await pickUpCents()) };
}

/** Change it. scope 'once' moves only the next run of a repeating move. */
async function update(userId, id, input, now = new Date()) {
    const move = await ScheduledMove.findOne({ _id: id, user: userId, active: true });
    if (!move) return { status: 404, error: 'Not found.' };
    const sub = await managedSubscription(userId);
    const { value, error } = validate(input, { partial: true });
    if (error) return { status: 400, error };
    if (value.at && value.at.getTime() - now.getTime() < MIN_NOTICE_MS) {
        return { status: 400, error: 'Pick a time at least 45 minutes from now.' };
    }
    if (input.scope === 'once' && move.repeat !== 'once') {
        // This run moves on its own: skip it on the rule, book a one-off.
        move.skipped.push(keyOf(move.nextAt));
        move.nextAt = occurrenceAfter(move, move.nextAt);
        await move.save();
        const one = await create(userId, {
            kind: move.kind,
            repeat: 'once',
            at: value.at || move.nextAt,
            address: value.address || move.address,
        }, now);
        return one;
    }
    if (value.kind) move.kind = value.kind;
    if (value.address) move.address = value.address;
    if (value.repeat) {
        move.repeat = value.repeat;
        move.days = value.days;
    }
    if (value.at) move.time = timeOf(value.at);
    move.nextAt = value.at && (move.repeat === 'once' || runsOn(move, nyClock(value.at).weekday))
        ? value.at
        : occurrenceAfter(move, now);
    move.lastKey = undefined;
    await move.save();
    return { move: view(move, sub, sub ? null : await pickUpCents()) };
}

/** Cancel it, or with scope 'once' just its next run. */
async function cancel(userId, id, { scope } = {}) {
    const move = await ScheduledMove.findOne({ _id: id, user: userId, active: true });
    if (!move) return { status: 404, error: 'Not found.' };
    if (scope === 'once' && move.repeat !== 'once') {
        move.skipped.push(keyOf(move.nextAt));
        move.nextAt = occurrenceAfter(move, move.nextAt);
    } else {
        move.active = false;
    }
    await move.save();
    return { ok: true };
}

async function mine(userId) {
    const sub = await managedSubscription(userId);
    const moves = await ScheduledMove.find({ user: userId, active: true, nextAt: { $ne: null } }).sort({ nextAt: 1 }).lean();
    const cents = !sub && moves.some((m) => m.kind === 'pick-up') ? await pickUpCents() : null;
    return moves.map((m) => view(m, sub, cents));
}

async function push(userId, title, body, data) {
    try {
        const user = await User.findById(userId).select('firebaseUid').lean();
        if (!user || !user.firebaseUid) return;
        const { sendPushNotification } = require('../controllers/notificationController');
        await sendPushNotification(user.firebaseUid, title, body, data);
    } catch (err) {
        console.error('scheduledMoves: push failed:', err.message);
    }
}

function clock(at) {
    return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
}

/**
 * Charge a pick-up without a plan to the saved card, off-session, as the
 * customer would at checkout, and mark the order paid the way the Stripe
 * webhook does (it repeats this harmlessly when payment_intent.succeeded
 * arrives). A paid pending order goes to valets 45 minutes out through
 * services/scheduledDispatch.js. Anything short of a charge cancels the order.
 */
async function payForOrder(move, order) {
    const cancelOrder = () => Order.updateOne({ _id: order._id, status: 'pending' }, { $set: { status: 'cancelled' } });
    const stripe = stripeClient.get();
    const card = await savedCard(move.user);
    if (!stripe || !card) {
        await cancelOrder();
        return { outcome: 'no_card', orderId: order._id };
    }
    const amount = Math.round(order.totalAmount || 0);
    let pi;
    try {
        pi = await stripe.paymentIntents.create(
            {
                amount,
                currency: 'usd',
                customer: card.customerId,
                payment_method: card.paymentMethodId,
                off_session: true,
                confirm: true,
                description: `Scheduled pick-up (order ${order._id})`,
                metadata: { orderId: String(order._id), customerId: String(move.user), scheduledMoveId: String(move._id), type: 'scheduled_move' },
            },
            { idempotencyKey: `scheduled-pickup-${order._id}` }
        );
    } catch (err) {
        await cancelOrder();
        return { outcome: 'payment_failed', orderId: order._id, error: err.message };
    }
    if (pi.status !== 'succeeded') {
        await cancelOrder();
        return { outcome: 'payment_failed', orderId: order._id, error: `Payment ${pi.status}` };
    }
    const paidAt = new Date();
    const details = { type: 'card', last4: card.last4, brand: card.brand };
    await Order.updateOne(
        { _id: order._id },
        {
            $set: {
                paymentStatus: 'paid',
                paymentIntentId: pi.id,
                'checkout.paidAt': paidAt,
                paymentDetails: { amount: pi.amount, currency: pi.currency, paymentMethodDetails: details, paidAt },
            },
        }
    );
    try {
        const Payment = require('../models/Payment');
        await Payment.create({ order: order._id, customer: move.user, paymentIntentId: pi.id, amount, currency: 'usd', status: 'succeeded', paymentMethodDetails: details, paidAt, metadata: { scheduledMove: String(move._id) } });
    } catch (err) {
        console.error('scheduledMoves: payment record failed for', String(order._id), err.message);
    }
    return { outcome: 'booked', orderId: order._id, chargedCents: amount, card };
}

/** Make the order for one occurrence. Returns { outcome, orderId?, retry? }. */
async function runOne(move, http) {
    const userId = String(move.user);
    const sub = await managedSubscription(userId);
    if (move.kind === 'pick-up') {
        // Without a plan this is a paid park-and-hold, quoted at the price
        // createOrder will charge so the two agree.
        const priceCents = sub ? 0 : await pickUpCents();
        let res;
        try {
            res = await http.post(`${base()}/api/order/createOrder`, {
                customer: userId,
                customerLocation: move.address,
                parkingType: 'street',
                pickUpTime: move.nextAt,
                // Required on the Order. A plan's park has no end time; the app
                // sends 24 hours for it (INDEFINITE_DURATION_MINUTES) and the
                // server stamps it indefinite.
                duration: PARK_MINUTES,
                paymentMethod: 'card',
                totalAmount: priceCents,
                orderType: 'parking',
                serviceType: 'park-and-hold',
                carWatch: false,
                carWatchAmount: 0,
                aspMode: false,
            });
        } catch (err) {
            const body = (err.response && err.response.data) || {};
            // Still out with the car from the morning: try again next minute.
            if (body.existingOrderId) return { outcome: 'busy', retry: true, error: body.message };
            return { outcome: 'failed', error: body.message || err.message };
        }
        const order = res.data && res.data.order;
        if (res.data.coveredBySubscription) return { outcome: 'booked', orderId: order && order._id };
        // A plan is never charged by a schedule: a run it doesn't cover is
        // dropped and the customer told.
        if (sub || !order || !order._id) {
            if (order && order._id) await Order.updateOne({ _id: order._id, status: 'pending' }, { $set: { status: 'cancelled' } });
            return { outcome: 'not_covered', orderId: order && order._id };
        }
        return payForOrder(move, order);
    }
    const park = await Order.findOne({ customer: move.user, orderType: 'parking', status: 'parked' }).sort({ createdAt: -1 });
    if (!park) return { outcome: 'no_car' };
    let res;
    try {
        res = await http.post(`${base()}/api/order/createRetrievalOrder`, {
            customer: userId,
            customerLocation: move.address,
            originalOrderId: String(park._id),
            paymentMethod: 'card',
        });
    } catch (err) {
        const body = (err.response && err.response.data) || {};
        return { outcome: 'failed', error: body.message || err.message };
    }
    const order = res.data && res.data.order;
    if (order && order._id && !res.data.alreadyRequested) {
        try {
            await http.post(`${base()}/api/notification/notify-closest-valets`, { orderId: String(order._id) }, { timeout: 20000 });
        } catch (err) {
            console.error('scheduledMoves: dispatch failed for', String(order._id), err.message);
        }
    }
    return { outcome: 'booked', orderId: order && order._id };
}

/** One pass, every minute from server.js. */
async function tick({ now = new Date(), http = axios } = {}) {
    const horizon = new Date(now.getTime() + Math.max(PICKUP_LEAD_MS, DROPOFF_LEAD_MS));
    const due = await ScheduledMove.find({ active: true, nextAt: { $ne: null, $lte: horizon } });
    const results = [];
    for (const move of due) {
        const lead = move.kind === 'pick-up' ? PICKUP_LEAD_MS : DROPOFF_LEAD_MS;
        if (move.nextAt.getTime() - lead > now.getTime()) continue;
        const key = keyOf(move.nextAt);
        const claimed = await ScheduledMove.findOneAndUpdate(
            { _id: move._id, active: true, nextAt: move.nextAt, lastKey: { $ne: key } },
            { $set: { lastKey: key } },
            { new: true }
        );
        if (!claimed) continue;
        const r = await runOne(claimed, http);
        if (r.retry && now.getTime() < claimed.nextAt.getTime() + GIVE_UP_AFTER_MS) {
            // Let the next tick try this occurrence again.
            await ScheduledMove.updateOne({ _id: claimed._id, lastKey: key }, { $unset: { lastKey: 1 }, $set: { lastOutcome: r.outcome, lastError: r.error } });
            results.push({ id: String(claimed._id), ...r });
            continue;
        }
        const label = claimed.kind === 'pick-up' ? 'pick-up' : 'drop-off';
        if (r.outcome === 'not_covered') {
            await push(claimed.user, `Your ${label} wasn’t booked`, `Your ${clock(claimed.nextAt)} ${label} isn’t included in your plan today. Book it in the app.`, { type: 'SCHEDULED_MOVE_SKIPPED' });
        } else if (r.outcome === 'payment_failed' || r.outcome === 'no_card') {
            await push(
                claimed.user,
                `Your ${label} wasn’t booked`,
                `We couldn’t charge your card for your ${clock(claimed.nextAt)} ${label}. Update your card in the app${claimed.repeat === 'once' ? '' : ' to keep your schedule'}.`,
                { type: 'SCHEDULED_MOVE_FAILED' }
            );
        } else if (r.outcome === 'booked' && r.chargedCents) {
            await push(
                claimed.user,
                `Your ${label} is booked`,
                `A valet collects your car at ${clock(claimed.nextAt)}. ${dollars(r.chargedCents)} was charged to your ${brandName(r.card && r.card.brand)} ending ${r.card && r.card.last4}.`,
                { type: 'SCHEDULED_MOVE_BOOKED' }
            );
        } else if (r.outcome === 'no_car') {
            await push(claimed.user, 'Nothing to bring back', `Your car isn’t parked with us, so there was nothing to bring back at ${clock(claimed.nextAt)}.`, { type: 'SCHEDULED_MOVE_SKIPPED' });
        } else if (r.outcome !== 'booked') {
            await push(claimed.user, `Your ${label} wasn’t booked`, `We couldn’t book your ${clock(claimed.nextAt)} ${label}. Book it in the app.`, { type: 'SCHEDULED_MOVE_FAILED' });
        }
        const next = claimed.repeat === 'once' ? null : occurrenceAfter(claimed, claimed.nextAt);
        await ScheduledMove.updateOne(
            { _id: claimed._id },
            {
                $set: {
                    lastOutcome: r.outcome,
                    ...(r.orderId ? { lastOrder: r.orderId } : {}),
                    ...(r.error ? { lastError: r.error } : {}),
                    nextAt: next,
                    active: !!next,
                },
            }
        );
        results.push({ id: String(claimed._id), ...r });
    }
    return results;
}

module.exports = { occurrenceAfter, timeOf, create, update, cancel, mine, tick, view, quote, cardSetup, savedCard, pickUpCents, PICKUP_LEAD_MS, DROPOFF_LEAD_MS };
