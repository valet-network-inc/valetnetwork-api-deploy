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
 *   - Without a plan it is paid at booking (Rishi, Nov 5 2026: "charge it at
 *     booking because what if there's no card on file?"). POST / with payNow
 *     books the move unseen and hands back a payment intent; the client pays
 *     it like a booking for now (Apple Pay or a saved card) and POST /:id/paid
 *     (or the webhook, or the job's sweep) puts the move on the schedule. A
 *     pick-up is a park-and-hold at the per-use price. A drop-off is priced
 *     like Bring my car back now: free when it returns a Park + Retrieve, a
 *     paid retrieval for a car parked on its own. The next run uses what the
 *     booking paid; anything a run doesn't use is refunded, and so is a
 *     cancel. A repeat's later runs are charged when the job books them, to
 *     the card the booking paid with.
 *   - An older client books without payNow: a card has to be on file (POST
 *     /card saves one at $0), each pick-up is charged off-session when the
 *     job books it (PICKUP_LEAD before), and its drop-offs stay free. A
 *     declined card cancels that run and tells the customer; a repeating
 *     move tries again next time.
 */
const axios = require('axios');
const ScheduledMove = require('../models/ScheduledMove');
const Order = require('../models/Order');
const User = require('../models/User');
const { nyClock, nyWallTimeToInstant } = require('./nyTime');
const stripeClient = require('./stripeClient');
const giftBalance = require('./giftBalance');
const orderPricing = require('./orderPricing');

const PICKUP_LEAD_MS = 50 * 60 * 1000;
const DROPOFF_LEAD_MS = 45 * 60 * 1000;
const MIN_NOTICE_MS = 45 * 60 * 1000;
const GIVE_UP_AFTER_MS = 15 * 60 * 1000;
// A booking still unpaid this long after its payment started is swept.
const UNPAID_GRACE_MS = 15 * 60 * 1000;
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

/** What Bring my car back costs on its own, from the live price table. */
async function retrievalCents() {
    const q = await orderPricing.priceOrderCents({ orderType: 'retrieval' });
    return q.amountCents;
}

/** The car we have parked for this customer, newest first. */
function parkedCar(userId) {
    return Order.findOne({ customer: userId, orderType: 'parking', status: 'parked' }).sort({ createdAt: -1 });
}

/**
 * What a scheduled retrieval costs without a plan, priced like Bring my car
 * back now (Nov 5 2026: tomorrow's said "Included with your park" while the
 * same one now cost $5): the return a Park + Retrieve paid for is free; any
 * other car comes back as a paid retrieval.
 */
async function dropOffCents(userId) {
    const park = await parkedCar(userId).select('serviceType').lean();
    return park && park.serviceType === 'park-and-hold' ? 0 : retrievalCents();
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

/** The card a run is charged to: the one its booking paid with, else the saved card. */
async function cardFor(move) {
    const stripe = stripeClient.get();
    if (stripe && move.paymentMethodId) {
        try {
            const pm = await stripe.paymentMethods.retrieve(move.paymentMethodId);
            const customerId = pm && pm.customer && (typeof pm.customer === 'string' ? pm.customer : pm.customer.id);
            if (pm && pm.card && customerId) return { customerId, paymentMethodId: pm.id, brand: pm.card.brand, last4: pm.card.last4 };
        } catch (err) {
            console.error('scheduledMoves: booking card lookup failed:', err.message);
        }
    }
    return savedCard(move.user);
}

const dollars = (cents) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const brandName = (b) => (b ? b.charAt(0).toUpperCase() + b.slice(1) : 'Card');

/** For the review screen: what a run costs this customer, and the card it goes on. */
async function quote(userId) {
    const sub = await managedSubscription(userId);
    // payAtBooking: this server takes payNow (Nov 5 2026), so the clients put
    // the Pay with row on the review. An older server never says it.
    if (sub) return { plan: true, pickUpCents: 0, dropOffCents: 0, card: null, cardRequired: false, payAtBooking: true };
    const [cents, dropCents, card] = await Promise.all([pickUpCents(), dropOffCents(userId), savedCard(userId)]);
    return {
        plan: false,
        pickUpCents: cents,
        dropOffCents: dropCents,
        card: card ? { brand: card.brand, last4: card.last4, label: `${brandName(card.brand)} ending ${card.last4}` } : null,
        cardRequired: !card,
        payAtBooking: true,
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
    // Cards only (Apple Pay and Google Pay are cards too): a run is charged to
    // a saved card, and anything else saved here would leave the customer
    // asked for a card again.
    const intent = await stripe.setupIntents.create({
        customer: customerId,
        usage: 'off_session',
        payment_method_types: ['card'],
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
function view(move, sub, pickUpPriceCents = null, dropOffPriceCents = null) {
    const included = !!sub;
    const street = shortStreet(move.address);
    // Parking and retrieval, the words users read (Nov 4 2026); the kinds stay.
    const verb = move.kind === 'drop-off' ? `Brought back to ${street}` : `Valet meets you at ${street}`;
    // Paid at booking: nothing more to pay for this run.
    const paid = !!(move.prepaid && move.prepaid.paymentIntentId);
    // Otherwise a pick-up is charged when it's booked, and so is a priced
    // drop-off of a car parked on its own; an older booking's drop-off is free.
    const priceCents =
        included || paid ? 0 : move.kind === 'drop-off' ? (move.priced ? dropOffPriceCents : 0) : pickUpPriceCents;
    // No "Included" (Rishi, Nov 4 2026: "remove 'Included' in the coming up
    // section"): a covered or already-paid run says only where; a run that
    // will be charged still says its price.
    const detail = !included && !paid && typeof priceCents === 'number' && priceCents > 0 ? `${verb} · ${dollars(priceCents)}` : verb;
    return {
        _id: String(move._id),
        kind: move.kind,
        at: move.nextAt,
        repeat: move.repeat,
        days: move.days || [],
        time: move.time,
        address: move.address,
        ...(move.carLocation?.lat != null ? { carLocation: move.carLocation } : {}),
        included,
        priceCents,
        detail,
        // What the booking paid: cancelling gives it back.
        ...(paid ? { paidCents: move.prepaid.cents || 0 } : {}),
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
    // Optional: the car's spot when it isn't at the keys; null clears it.
    if (input.carLocation !== undefined) {
        const c = input.carLocation;
        out.carLocation =
            c && typeof c.lat === 'number' && typeof c.lng === 'number'
                ? { streetAddress: String(c.streetAddress || ''), lat: c.lat, lng: c.lng }
                : null;
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
    // payNow: paid here, at booking, like a booking for now (Nov 5 2026). An
    // older client's runs are charged when they're booked, so it needs a card
    // on file first.
    const payNow = !sub && input.payNow === true;
    if (!sub && !payNow && !(await savedCard(userId))) {
        return { status: 402, code: 'CARD_REQUIRED', error: 'Add a card first. Each parking is charged to it when it’s booked.' };
    }
    const { value, error } = validate(input);
    if (error) return { status: 400, error };
    if (value.at.getTime() - now.getTime() < MIN_NOTICE_MS) {
        return { status: 400, error: 'Pick a time at least 45 minutes from now.' };
    }
    const move = new ScheduledMove({
        user: userId,
        kind: value.kind,
        repeat: value.repeat,
        days: value.days,
        time: timeOf(value.at),
        address: value.address,
        ...(value.carLocation ? { carLocation: value.carLocation } : {}),
        ...(payNow ? { priced: true } : {}),
    });
    // The first run is the time they picked; repeats follow its wall-clock time.
    move.nextAt = value.repeat === 'once' || runsOn(move, nyClock(value.at).weekday) ? value.at : occurrenceAfter(move, value.at);
    if (payNow) {
        const cents = value.kind === 'pick-up' ? await pickUpCents() : await dropOffCents(userId);
        if (cents > 0) return startPayment(userId, move, cents);
    }
    await move.save();
    return { move: view(move, sub, sub ? null : await pickUpCents(), sub ? null : await dropOffCents(userId)) };
}

/**
 * Take the booking's payment (payNow). The move is saved inactive, out of the
 * job and Home, with a payment intent the client confirms the way it pays for
 * a booking for now; it joins the schedule once that succeeds. Gift card money
 * that covers the run is spent when the job books it instead, as before.
 */
async function startPayment(userId, move, cents) {
    const gift = await giftBalance.giftFor(userId);
    if (gift.cents >= cents) {
        await move.save();
        return { move: view(move, null, await pickUpCents(), cents) };
    }
    const stripe = stripeClient.get();
    if (!stripe) return { status: 503, error: 'Payments are unavailable right now. Try again soon.' };
    const user = await User.findById(userId);
    if (!user) return { status: 404, error: 'Not found.' };
    const { ensureStripeCustomer } = require('../controllers/subscriptionController');
    const customerId = await ensureStripeCustomer(user);
    move.active = false;
    move.awaitingPayment = { cents, since: new Date() };
    await move.save();
    let intent;
    let ephemeralKey;
    try {
        intent = await stripe.paymentIntents.create(
            {
                amount: cents,
                currency: 'usd',
                customer: customerId,
                // Cards (Apple Pay is one), saved like a booking for now saves
                // them: a repeat's later runs are charged to this one.
                payment_method_types: ['card'],
                setup_future_usage: 'off_session',
                description: `Scheduled ${move.kind === 'drop-off' ? 'retrieval' : 'parking'}, paid at booking`,
                // `purpose` keeps the webhook's order and guest-payment matchers
                // away from it: it names a scheduled move, never an order.
                metadata: { purpose: 'scheduled_prepay', scheduledMoveId: String(move._id), customerId: String(userId) },
            },
            { idempotencyKey: `scheduled-prepay-${move._id}` }
        );
        ephemeralKey = await stripe.ephemeralKeys.create({ customer: customerId }, { apiVersion: '2024-06-20' });
    } catch (err) {
        if (!intent) await ScheduledMove.deleteOne({ _id: move._id });
        else await dropUnpaid(Object.assign(move, { awaitingPayment: { ...move.awaitingPayment, paymentIntentId: intent.id } }));
        throw err;
    }
    await ScheduledMove.updateOne({ _id: move._id }, { $set: { 'awaitingPayment.paymentIntentId': intent.id } });
    return {
        move: { ...view(move, null, null, null), awaitingPayment: true },
        payment: {
            clientSecret: intent.client_secret,
            paymentIntentId: intent.id,
            amountCents: cents,
            customerId,
            customerEphemeralKeySecret: ephemeralKey.secret,
        },
    };
}

/**
 * The booking's payment went through: the move joins the schedule, paid, with
 * the card it paid with kept for a repeat's later runs. Returns { move },
 * { unpaid, status } while the intent hasn't succeeded, or { refunded } when
 * it came back too late to run (the sheet sat open past the time).
 */
async function settlePayment(move, now = new Date()) {
    const id = move.awaitingPayment && move.awaitingPayment.paymentIntentId;
    if (!id) return move.active ? { move } : { unpaid: true, status: 'none' };
    const stripe = stripeClient.get();
    if (!stripe) return { unpaid: true, status: 'unavailable' };
    const pi = await stripe.paymentIntents.retrieve(id);
    if (!pi || pi.status !== 'succeeded') return { unpaid: true, status: pi && pi.status };
    if (!move.nextAt || move.nextAt.getTime() <= now.getTime()) {
        await dropUnpaid(move);
        return { refunded: true };
    }
    const pm = typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method && pi.payment_method.id;
    const done = await ScheduledMove.findOneAndUpdate(
        { _id: move._id, 'awaitingPayment.paymentIntentId': id },
        {
            $set: { active: true, prepaid: { paymentIntentId: id, cents: pi.amount, paidAt: now }, ...(pm ? { paymentMethodId: pm } : {}) },
            $unset: { awaitingPayment: 1 },
        },
        { new: true }
    );
    return { move: done || (await ScheduledMove.findById(move._id)) };
}

/** POST /:id/paid — the client's word that the booking's payment went through. */
async function confirmPaid(userId, id, now = new Date()) {
    const move = await ScheduledMove.findOne({ _id: id, user: userId });
    if (!move) return { status: 404, error: 'Not found.' };
    const r = await settlePayment(move, now);
    if (r.refunded) return { status: 400, error: 'That time has passed, so nothing is booked. Your money is on its way back.' };
    if (!r.move || !r.move.active) return { status: 402, error: 'That payment didn’t go through. Try again.' };
    return { move: view(r.move, null, null, null) };
}

/** The webhook's half of confirmPaid: Stripe says a booking's payment succeeded. */
async function paymentSucceeded(pi) {
    const id = pi && pi.metadata && pi.metadata.scheduledMoveId;
    if (!id) return { skipped: 'no move named' };
    const move = await ScheduledMove.findById(id);
    if (!move) return { skipped: 'no such move' };
    if (move.active && move.prepaid && move.prepaid.paymentIntentId === pi.id) return { already: true };
    const r = await settlePayment(move);
    return r.move ? { activated: String(move._id) } : r;
}

/** A booking whose payment never finished: call off its intent (or refund it) and forget it. */
async function dropUnpaid(move) {
    const id = move.awaitingPayment && move.awaitingPayment.paymentIntentId;
    const stripe = stripeClient.get();
    if (id && stripe) {
        try {
            const pi = await stripe.paymentIntents.retrieve(id);
            if (pi.status === 'succeeded') {
                await stripe.refunds.create({ payment_intent: id, metadata: { scheduledMoveId: String(move._id) } }, { idempotencyKey: `scheduled-prepay-refund-${id}` });
            } else if (pi.status !== 'canceled') {
                await stripe.paymentIntents.cancel(id);
            }
        } catch (err) {
            // Kept, so the job's sweep tries again.
            console.error('scheduledMoves: could not drop unpaid booking', String(move._id), err.message);
            return false;
        }
    }
    await ScheduledMove.deleteOne({ _id: move._id, active: false });
    return true;
}

/**
 * Give back what a booking paid when its run doesn't use it (cancelled,
 * skipped, covered by a plan, nothing to bring back, or not booked).
 * Claimed off the move first, so it is never refunded twice. Returns cents.
 */
async function refundPrepaid(move, why) {
    const pre = move.prepaid;
    if (!pre || !pre.paymentIntentId) return 0;
    const claimed = await ScheduledMove.findOneAndUpdate(
        { _id: move._id, 'prepaid.paymentIntentId': pre.paymentIntentId },
        { $unset: { prepaid: 1 } }
    );
    if (!claimed) return 0;
    const stripe = stripeClient.get();
    try {
        if (!stripe) throw new Error('payments unavailable');
        await stripe.refunds.create(
            { payment_intent: pre.paymentIntentId, metadata: { scheduledMoveId: String(move._id), why: String(why || '') } },
            { idempotencyKey: `scheduled-prepay-refund-${pre.paymentIntentId}` }
        );
        return pre.cents || 0;
    } catch (err) {
        // Put it back where a person (or a later pass) finds it.
        console.error('scheduledMoves: refund failed for', pre.paymentIntentId, err.message);
        await ScheduledMove.updateOne(
            { _id: move._id },
            { $set: { prepaid: { paymentIntentId: pre.paymentIntentId, cents: pre.cents, paidAt: pre.paidAt }, lastError: `refund failed: ${err.message}` } }
        );
        return 0;
    }
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
        // The one-off is the run the booking paid for: the payment goes with it.
        const paidFor = move.prepaid && move.prepaid.paymentIntentId ? { ...move.prepaid } : null;
        if (paidFor) {
            move.prepaid = undefined;
            await move.save();
        }
        const one = await create(userId, {
            kind: move.kind,
            repeat: 'once',
            at: value.at || move.nextAt,
            address: value.address || move.address,
            carLocation: value.carLocation !== undefined ? value.carLocation : move.carLocation?.lat != null ? move.carLocation : undefined,
        }, now);
        if (one.move && (paidFor || move.priced)) {
            await ScheduledMove.updateOne(
                { _id: one.move._id },
                { $set: { priced: !!move.priced, ...(paidFor ? { prepaid: paidFor } : {}), ...(move.paymentMethodId ? { paymentMethodId: move.paymentMethodId } : {}) } }
            );
            const fresh = await ScheduledMove.findById(one.move._id);
            return { move: view(fresh, sub, sub ? null : await pickUpCents(), sub ? null : await dropOffCents(userId)) };
        }
        if (one.error && paidFor) await ScheduledMove.updateOne({ _id: move._id }, { $set: { prepaid: paidFor } });
        return one;
    }
    if (value.kind) move.kind = value.kind;
    if (value.address) move.address = value.address;
    if (value.carLocation !== undefined) move.carLocation = value.carLocation || undefined;
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
    return { move: view(move, sub, sub ? null : await pickUpCents(), sub ? null : await dropOffCents(userId)) };
}

/** Cancel it, or with scope 'once' just its next run. */
async function cancel(userId, id, { scope } = {}) {
    // A booking whose payment never finished (the sheet was closed): drop it.
    const unpaid = await ScheduledMove.findOne({ _id: id, user: userId, active: false, 'awaitingPayment.since': { $ne: null } });
    if (unpaid) {
        await dropUnpaid(unpaid);
        return { ok: true };
    }
    const move = await ScheduledMove.findOne({ _id: id, user: userId, active: true });
    if (!move) return { status: 404, error: 'Not found.' };
    if (scope === 'once' && move.repeat !== 'once') {
        move.skipped.push(keyOf(move.nextAt));
        move.nextAt = occurrenceAfter(move, move.nextAt);
    } else {
        move.active = false;
    }
    await move.save();
    // Money follows the run: what the booking paid for it goes back.
    const refundedCents = await refundPrepaid(move, scope === 'once' ? 'skipped' : 'cancelled');
    return { ok: true, ...(refundedCents ? { refundedCents } : {}) };
}

async function mine(userId) {
    const sub = await managedSubscription(userId);
    const moves = await ScheduledMove.find({ user: userId, active: true, nextAt: { $ne: null } }).sort({ nextAt: 1 }).lean();
    const cents = !sub && moves.some((m) => m.kind === 'pick-up') ? await pickUpCents() : null;
    const dropCents = !sub && moves.some((m) => m.kind === 'drop-off' && m.priced) ? await dropOffCents(userId) : null;
    return moves.map((m) => view(m, sub, cents, dropCents));
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
    const total = Math.round(order.totalAmount || 0);
    // Gift card money pays first: a pick-up it covers needs no card at all.
    const giftCents = await giftBalance.takeGift(order, total, 'order', { minCardCents: giftBalance.MIN_CARD_CENTS });
    const unpaid = async () => {
        if (giftCents > 0) await giftBalance.giveBack(order, giftCents, 'scheduled-unpaid');
        await cancelOrder();
    };
    if (total > 0 && giftCents >= total) {
        await Order.updateOne({ _id: order._id }, { $set: { paymentStatus: 'paid', 'checkout.paidAt': new Date() } });
        return { outcome: 'booked', orderId: order._id, chargedCents: 0, giftCents, card: null };
    }
    const card = await cardFor(move);
    if (!stripe || !card) {
        await unpaid();
        return { outcome: 'no_card', orderId: order._id };
    }
    const amount = total - giftCents;
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
                description: `Scheduled ${move.kind === 'drop-off' ? 'retrieval' : 'parking'} (order ${order._id})`,
                metadata: { orderId: String(order._id), customerId: String(move.user), scheduledMoveId: String(move._id), type: 'scheduled_move' },
            },
            { idempotencyKey: `scheduled-pickup-${order._id}` }
        );
    } catch (err) {
        await unpaid();
        return { outcome: 'payment_failed', orderId: order._id, error: err.message };
    }
    if (pi.status !== 'succeeded') {
        await unpaid();
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
    return { outcome: 'booked', orderId: order._id, chargedCents: amount, giftCents, card };
}

/** The card a payment intent was paid with, for the order's receipt. */
async function cardOf(paymentIntentId) {
    try {
        const pi = await stripeClient.get().paymentIntents.retrieve(paymentIntentId, { expand: ['payment_method'] });
        const pm = pi && pi.payment_method;
        if (pm && pm.card) return { type: 'card', brand: pm.card.brand, last4: pm.card.last4 };
    } catch (err) {
        console.error('scheduledMoves: card lookup failed for', paymentIntentId, err.message);
    }
    return { type: 'card' };
}

/**
 * Pay a run with what its booking paid (Nov 5 2026): no new charge. The order
 * takes the booking's payment as its own, so a cancel refunds against it.
 * Claimed off the move first, so it pays for one run only.
 */
async function usePrepaid(move, order) {
    const pre = move.prepaid;
    const taken = await ScheduledMove.findOneAndUpdate(
        { _id: move._id, 'prepaid.paymentIntentId': pre.paymentIntentId },
        { $unset: { prepaid: 1 } }
    );
    if (!taken) return payForOrder(move, order);
    const paidAt = pre.paidAt || new Date();
    const details = await cardOf(pre.paymentIntentId);
    await Order.updateOne(
        { _id: order._id },
        {
            $set: {
                paymentStatus: 'paid',
                paymentIntentId: pre.paymentIntentId,
                totalAmount: pre.cents,
                'checkout.paidAt': paidAt,
                paymentDetails: { amount: pre.cents, currency: 'usd', paymentMethodDetails: details, paidAt },
            },
        }
    );
    try {
        const Payment = require('../models/Payment');
        await Payment.create({
            order: order._id,
            customer: move.user,
            paymentIntentId: pre.paymentIntentId,
            amount: pre.cents,
            currency: 'usd',
            status: 'succeeded',
            paymentMethodDetails: details,
            paidAt,
            metadata: { scheduledMove: String(move._id), paidAtBooking: true },
        });
    } catch (err) {
        console.error('scheduledMoves: payment record failed for', String(order._id), err.message);
    }
    return { outcome: 'booked', orderId: order._id, prepaidCents: pre.cents };
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
                // The car's own spot, when it isn't at the keys.
                ...(move.carLocation?.lat != null ? { carLocation: move.carLocation } : {}),
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
        // Paid at booking: that payment is this run's. Otherwise charge now.
        return move.prepaid && move.prepaid.paymentIntentId ? usePrepaid(move, order) : payForOrder(move, order);
    }
    const park = await parkedCar(move.user);
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
    // A car parked on its own comes back as a paid retrieval, like Bring my
    // car back now (Nov 5 2026); a Park + Retrieve's return, and a plan's, are
    // already paid for. Only a booking that showed the price pays (priced): an
    // older one was told it was included.
    let paid = null;
    if (order && order._id && !res.data.alreadyRequested && !sub && move.priced && park.serviceType !== 'park-and-hold') {
        const cents = (move.prepaid && move.prepaid.paymentIntentId && move.prepaid.cents) || (await retrievalCents());
        await Order.updateOne({ _id: order._id }, { $set: { totalAmount: cents, isFreeService: false, paymentStatus: 'pending' } });
        const owed = { ...order, _id: order._id, totalAmount: cents, giftSpends: [] };
        paid = move.prepaid && move.prepaid.paymentIntentId ? await usePrepaid(move, owed) : await payForOrder(move, owed);
        if (paid.outcome !== 'booked') return paid;
    }
    if (order && order._id && !res.data.alreadyRequested) {
        try {
            await http.post(`${base()}/api/notification/notify-closest-valets`, { orderId: String(order._id) }, { timeout: 20000 });
        } catch (err) {
            console.error('scheduledMoves: dispatch failed for', String(order._id), err.message);
        }
    }
    return { ...(paid || {}), outcome: 'booked', orderId: order && order._id };
}

/** One pass, every minute from server.js. */
/**
 * Bookings whose payment never came back to us (the app closed mid-payment,
 * the webhook went astray): put the paid ones on the schedule, drop the rest.
 */
async function sweepUnpaid(now) {
    if (!stripeClient.get()) return;
    const stale = await ScheduledMove.find({
        active: false,
        'awaitingPayment.since': { $ne: null, $lte: new Date(now.getTime() - UNPAID_GRACE_MS) },
    }).limit(20);
    for (const m of stale) {
        try {
            const r = await settlePayment(m, now);
            if (r.move || r.refunded) continue;
            // Still being paid (a bank's check, a slow card): wait, up to an hour.
            if (['processing', 'requires_action'].includes(r.status) && now.getTime() - m.awaitingPayment.since.getTime() < 60 * 60 * 1000) continue;
            await dropUnpaid(m);
        } catch (err) {
            console.error('scheduledMoves: unpaid sweep failed for', String(m._id), err.message);
        }
    }
}

async function tick({ now = new Date(), http = axios } = {}) {
    await sweepUnpaid(now);
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
        // What the booking paid and this run didn't use goes back: a plan
        // covered it, the return was already paid for, or nothing was booked.
        const left = await ScheduledMove.findById(claimed._id).select('prepaid').lean();
        const refundedCents =
            left && left.prepaid && left.prepaid.paymentIntentId ? await refundPrepaid({ _id: claimed._id, prepaid: left.prepaid }, r.outcome) : 0;
        const back = refundedCents ? ` The ${dollars(refundedCents)} you paid is on its way back.` : '';
        // Parking and retrieval, the words users read (Nov 4 2026).
        const label = claimed.kind === 'pick-up' ? 'parking' : 'retrieval';
        const when = clock(claimed.nextAt);
        const meets = claimed.kind === 'pick-up' ? `A valet collects your car at ${when}.` : `A valet brings your car back by ${when}.`;
        if (r.outcome === 'not_covered') {
            await push(claimed.user, `Your ${label} wasn’t booked`, `Your ${when} ${label} isn’t included in your plan today. Book it in the app.${back}`, { type: 'SCHEDULED_MOVE_SKIPPED' });
        } else if (r.outcome === 'payment_failed' || r.outcome === 'no_card') {
            await push(
                claimed.user,
                `Your ${label} wasn’t booked`,
                `We couldn’t charge your card for your ${when} ${label}. Update your card in the app${claimed.repeat === 'once' ? '' : ' to keep your schedule'}.${back}`,
                { type: 'SCHEDULED_MOVE_FAILED' }
            );
        } else if (r.outcome === 'booked' && r.chargedCents) {
            await push(
                claimed.user,
                `Your ${label} is booked`,
                `${meets} ${dollars(r.chargedCents)} was charged to your ${brandName(r.card && r.card.brand)} ending ${r.card && r.card.last4}.`,
                { type: 'SCHEDULED_MOVE_BOOKED' }
            );
        } else if (r.outcome === 'booked' && r.giftCents) {
            await push(claimed.user, `Your ${label} is booked`, `${meets} Your gift card paid for it.`, { type: 'SCHEDULED_MOVE_BOOKED' });
        } else if (r.outcome === 'booked' && refundedCents) {
            await push(claimed.user, `Your ${label} is booked`, `${meets} It’s already paid for, so the ${dollars(refundedCents)} you paid is on its way back.`, { type: 'SCHEDULED_MOVE_BOOKED' });
        } else if (r.outcome === 'booked' && r.prepaidCents && claimed.kind === 'pick-up') {
            // Paid at booking: the reminder that it's on, with nothing charged now.
            await push(claimed.user, `Your ${label} is booked`, meets, { type: 'SCHEDULED_MOVE_BOOKED' });
        } else if (r.outcome === 'no_car') {
            await push(claimed.user, 'Nothing to bring back', `Your car isn’t parked with us, so there was nothing to bring back at ${when}.${back}`, { type: 'SCHEDULED_MOVE_SKIPPED' });
        } else if (r.outcome !== 'booked') {
            await push(claimed.user, `Your ${label} wasn’t booked`, `We couldn’t book your ${when} ${label}. Book it in the app.${back}`, { type: 'SCHEDULED_MOVE_FAILED' });
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

module.exports = {
    payForOrder,
    occurrenceAfter,
    timeOf,
    create,
    update,
    cancel,
    mine,
    tick,
    view,
    quote,
    cardSetup,
    savedCard,
    pickUpCents,
    dropOffCents,
    confirmPaid,
    paymentSucceeded,
    PICKUP_LEAD_MS,
    DROPOFF_LEAD_MS,
};
