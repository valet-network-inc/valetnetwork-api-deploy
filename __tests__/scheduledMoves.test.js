/**
 * Park my car / Bring my car back, booked for later (spec v2, 8), and Park my
 * car while the customer holds the keys of a managed car (the pre-release
 * must-do of Oct 2 2026).
 *
 * Run: npx jest scheduledMoves
 *
 * The job's HTTP calls to our own order endpoints are stubbed: what is
 * asserted is which order it asks for, when, and that it asks once.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

jest.mock('firebase-admin', () => ({
    auth: () => ({
        verifyIdToken: async (token) => {
            const m = /^uid:(.+)$/.exec(String(token));
            if (!m) throw new Error('bad token');
            return { uid: m[1] };
        },
    }),
    messaging: () => ({ send: async () => 'mock', sendEachForMulticast: async () => ({ responses: [] }) }),
}));

const request = require('supertest');
const express = require('express');
const User = require('../models/User');
const Order = require('../models/Order');
const Subscription = require('../models/Subscription');
const ScheduledMove = require('../models/ScheduledMove');
const CurbCustody = require('../models/CurbCustody');
const moves = require('../services/scheduledMoves');
const stripeClient = require('../services/stripeClient');
const Payment = require('../models/Payment');
const curbCustody = require('../services/curbCustody');

const app = express();
app.use(express.json());
app.use('/api/schedule', require('../routes/schedule'));

const HOME = { streetAddress: '200 W 20th St, New York, NY 10011', lat: 40.7425, lng: -73.997 };
const at = (iso) => new Date(iso);

let mongo;
let user;
beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
    stripeClient.reset();
    await mongoose.disconnect();
    await mongo.stop();
});
beforeEach(async () => {
    stripeClient.set(null);
    await mongoose.connection.db.dropDatabase();
    user = await User.create({ verified: true, phone: '+19175550134', firebaseUid: 'sam' });
});

/** A Stripe with one saved Visa on cus_sam; `charge` decides each off-session charge. */
function stripeWithCard(charge = async (p) => ({ id: 'pi_1', status: 'succeeded', amount: p.amount, currency: 'usd' })) {
    const intents = [];
    stripeClient.set({
        customers: { retrieve: async () => ({ id: 'cus_sam', invoice_settings: { default_payment_method: 'pm_visa' } }) },
        paymentMethods: {
            retrieve: async () => ({ id: 'pm_visa', card: { brand: 'visa', last4: '4242' } }),
            list: async () => ({ data: [] }),
        },
        paymentIntents: { create: async (p, o) => { intents.push({ p, o }); return charge(p); } },
    });
    return intents;
}

async function givePlan(tier = 'home_garage') {
    await Subscription.collection.insertOne({
        user: user._id,
        tier,
        interval: 'month',
        status: 'active',
        amountCents: 52500,
        activatedAt: new Date('2026-09-01T12:00:00Z'),
        currentPeriodEnd: new Date('2099-01-01T00:00:00Z'),
        createdAt: new Date('2026-09-01T12:00:00Z'),
    });
}

describe('occurrences', () => {
    test('every weekday at 8 AM New York, across the November clock change', () => {
        const move = { repeat: 'weekdays', time: '08:00', days: [], skipped: [] };
        // Fri Oct 30 2026, 9 AM ET → Mon Nov 2, 8 AM EST (13:00 UTC).
        expect(moves.occurrenceAfter(move, at('2026-10-30T13:00:00Z')).toISOString()).toBe('2026-11-02T13:00:00.000Z');
        // Thu Oct 29 2026, 7 AM ET → the same day, 8 AM EDT (12:00 UTC).
        expect(moves.occurrenceAfter(move, at('2026-10-29T11:00:00Z')).toISOString()).toBe('2026-10-29T12:00:00.000Z');
    });

    test('picked days, and a skipped run', () => {
        const move = { repeat: 'days', days: [2, 4], time: '19:00', skipped: ['2026-10-13T23:00:00.000Z'] };
        // Sat Oct 10 → Tue Oct 13 is skipped → Thu Oct 15, 7 PM EDT.
        expect(moves.occurrenceAfter(move, at('2026-10-10T16:00:00Z')).toISOString()).toBe('2026-10-15T23:00:00.000Z');
    });
});

describe('booking', () => {
    test('everyone: without a plan a card has to be on file; on a plan it is included', async () => {
        const auth = { Authorization: 'Bearer uid:sam' };
        const body = { userId: String(user._id), kind: 'drop-off', repeat: 'once', at: new Date(Date.now() + 3 * 3600e3).toISOString(), address: HOME };
        const none = await request(app).post('/api/schedule').set(auth).send(body);
        expect(none.status).toBe(402);
        expect(none.body.code).toBe('CARD_REQUIRED');

        await User.updateOne({ _id: user._id }, { $set: { stripeCustomerId: 'cus_sam' } });
        stripeWithCard();
        const q = await request(app).get(`/api/schedule/quote/${user._id}`).set(auth);
        // A retrieval is priced like Bring my car back now: $5 unless it returns a Park + Retrieve.
        expect(q.body).toMatchObject({ plan: false, pickUpCents: 1300, dropOffCents: 500, cardRequired: false, card: { label: 'Visa ending 4242' }, payAtBooking: true });
        const paid = await request(app).post('/api/schedule').set(auth).send({ ...body, kind: 'pick-up' });
        expect(paid.status).toBe(201);
        expect(paid.body.move.detail).toBe('Valet meets you at 200 W 20th St · $13');
        const back = await request(app).post('/api/schedule').set(auth).send(body);
        expect(back.body.move.detail).toBe('Brought back to 200 W 20th St');
        await ScheduledMove.deleteMany({});

        await givePlan();
        const soon = await request(app).post('/api/schedule').set(auth).send({ ...body, at: new Date(Date.now() + 10 * 60e3).toISOString() });
        expect(soon.status).toBe(400);
        const ok = await request(app).post('/api/schedule').set(auth).send(body);
        expect(ok.status).toBe(201);
        expect(ok.body.move.detail).toBe('Brought back to 200 W 20th St');
        const list = await request(app).get(`/api/schedule/mine/${user._id}`).set(auth);
        expect(list.body.moves).toHaveLength(1);
        const other = await User.create({ verified: true, phone: '+12125550100', firebaseUid: 'eve' });
        const peek = await request(app).delete(`/api/schedule/${ok.body.move._id}`).set('Authorization', 'Bearer uid:eve').send({ userId: String(other._id) });
        expect(peek.status).toBe(404);
    });

    test('a scheduled park keeps the car’s own spot (Nov 5)', async () => {
        const auth = { Authorization: 'Bearer uid:sam' };
        await User.updateOne({ _id: user._id }, { $set: { stripeCustomerId: 'cus_sam' } });
        stripeWithCard();
        const CAR = { streetAddress: '210 W 20th St, New York, NY 10011', lat: 40.7431, lng: -73.9989 };
        const res = await request(app).post('/api/schedule').set(auth).send({
            userId: String(user._id), kind: 'pick-up', repeat: 'once',
            at: new Date(Date.now() + 3 * 3600e3).toISOString(), address: HOME, carLocation: CAR,
        });
        expect(res.status).toBe(201);
        expect(res.body.move.carLocation).toMatchObject(CAR);
        expect((await ScheduledMove.findById(res.body.move._id)).carLocation).toMatchObject(CAR);
    });
});

describe('the job, without a plan', () => {
    async function bookOne() {
        await User.updateOne({ _id: user._id }, { $set: { stripeCustomerId: 'cus_sam' } });
        const order = await Order.collection.insertOne({ customer: user._id, orderType: 'parking', status: 'pending', paymentStatus: 'pending', totalAmount: 1300, serviceType: 'park-and-hold', createdAt: new Date() });
        const move = await ScheduledMove.create({ user: user._id, kind: 'pick-up', repeat: 'weekdays', time: '19:00', address: HOME, nextAt: at('2026-10-13T23:00:00Z') });
        const calls = [];
        const http = { post: jest.fn(async (url, body) => {
            calls.push({ url, body });
            return { data: { success: true, order: { _id: order.insertedId, totalAmount: 1300 } } };
        }) };
        return { orderId: order.insertedId, move, calls, http };
    }

    test('a pick-up is a park-and-hold charged to the saved card when it is booked', async () => {
        const intents = stripeWithCard();
        const { orderId, move, calls, http } = await bookOne();
        const [r] = await moves.tick({ now: at('2026-10-13T22:15:00Z'), http });
        expect(r.outcome).toBe('booked');
        expect(calls[0].body).toMatchObject({ serviceType: 'park-and-hold', totalAmount: 1300, duration: 24 * 60 });
        expect(intents).toHaveLength(1);
        expect(intents[0].p).toMatchObject({ amount: 1300, customer: 'cus_sam', payment_method: 'pm_visa', off_session: true, confirm: true });
        expect(intents[0].p.metadata.orderId).toBe(String(orderId));
        expect(intents[0].o.idempotencyKey).toBe(`scheduled-pickup-${orderId}`);
        const order = await Order.findById(orderId).lean();
        expect(order.paymentStatus).toBe('paid');
        expect(order.paymentIntentId).toBe('pi_1');
        expect(await Payment.countDocuments({ order: orderId, status: 'succeeded' })).toBe(1);
        // A repeating move goes on to the next weekday.
        expect((await ScheduledMove.findById(move._id)).nextAt.toISOString()).toBe('2026-10-14T23:00:00.000Z');
    });

    test('the car’s own spot rides along to the park order (Nov 5)', async () => {
        stripeWithCard();
        const { move, calls, http } = await bookOne();
        const CAR = { streetAddress: '210 W 20th St, New York, NY 10011', lat: 40.7431, lng: -73.9989 };
        await ScheduledMove.updateOne({ _id: move._id }, { $set: { carLocation: CAR } });
        await moves.tick({ now: at('2026-10-13T22:15:00Z'), http });
        expect(calls[0].body.carLocation).toMatchObject(CAR);
        expect(calls[0].body.customerLocation).toMatchObject({ lat: HOME.lat, lng: HOME.lng });
    });

    test('a declined card cancels that run, and the schedule carries on', async () => {
        stripeWithCard(async () => {
            throw Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError' });
        });
        const { orderId, move, http } = await bookOne();
        const [r] = await moves.tick({ now: at('2026-10-13T22:15:00Z'), http });
        expect(r.outcome).toBe('payment_failed');
        expect((await Order.findById(orderId).lean()).status).toBe('cancelled');
        const after = await ScheduledMove.findById(move._id);
        expect(after.active).toBe(true);
        expect(after.lastOutcome).toBe('payment_failed');
    });
});

describe('the job', () => {
    test('a pick-up becomes one covered park order 50 minutes out, then the next weekday', async () => {
        await givePlan();
        const first = at('2026-10-13T23:00:00Z'); // Tue 7 PM EDT
        const move = await ScheduledMove.create({ user: user._id, kind: 'pick-up', repeat: 'weekdays', time: '19:00', address: HOME, nextAt: first });
        const calls = [];
        const http = { post: jest.fn(async (url, body) => {
            calls.push({ url, body });
            return { data: { success: true, coveredBySubscription: true, order: { _id: new mongoose.Types.ObjectId() } } };
        }) };
        // An hour out: too early.
        expect(await moves.tick({ now: at('2026-10-13T22:00:00Z'), http })).toHaveLength(0);
        const now = at('2026-10-13T22:15:00Z');
        const [a, b] = await Promise.all([moves.tick({ now, http }), moves.tick({ now, http })]);
        expect(a.length + b.length).toBe(1);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toMatch(/\/api\/order\/createOrder$/);
        // duration is required on the Order; without it every booking failed validation.
        expect(calls[0].body).toMatchObject({ customer: String(user._id), orderType: 'parking', totalAmount: 0, duration: 24 * 60 });
        expect(new Date(calls[0].body.pickUpTime).toISOString()).toBe(first.toISOString());
        const after = await ScheduledMove.findById(move._id);
        expect(after.nextAt.toISOString()).toBe('2026-10-14T23:00:00.000Z');
        expect(after.lastOutcome).toBe('booked');
    });

    test('a drop-off retrieves the parked car and dispatches it; a pick-up the plan doesn’t cover is cancelled', async () => {
        await givePlan();
        const park = await Order.collection.insertOne({ customer: user._id, orderType: 'parking', status: 'parked', createdAt: new Date() });
        await ScheduledMove.create({ user: user._id, kind: 'drop-off', repeat: 'once', time: '08:00', address: HOME, nextAt: at('2026-10-14T12:00:00Z') });
        const retrievalId = new mongoose.Types.ObjectId();
        const calls = [];
        const http = { post: jest.fn(async (url, body) => {
            calls.push({ url, body });
            if (url.endsWith('/createRetrievalOrder')) return { data: { success: true, order: { _id: retrievalId } } };
            return { data: { success: true } };
        }) };
        await moves.tick({ now: at('2026-10-14T11:20:00Z'), http });
        expect(calls.map((c) => c.url.split('/api/')[1])).toEqual(['order/createRetrievalOrder', 'notification/notify-closest-valets']);
        expect(calls[0].body.originalOrderId).toBe(String(park.insertedId));
        expect(await ScheduledMove.countDocuments({ active: true })).toBe(0);

        const pendingId = new mongoose.Types.ObjectId();
        await Order.collection.insertOne({ _id: pendingId, customer: user._id, orderType: 'parking', status: 'pending' });
        await ScheduledMove.create({ user: user._id, kind: 'pick-up', repeat: 'once', time: '19:00', address: HOME, nextAt: at('2026-10-14T23:00:00Z') });
        const http2 = { post: jest.fn(async () => ({ data: { success: true, order: { _id: pendingId } } })) };
        const [r] = await moves.tick({ now: at('2026-10-14T22:20:00Z'), http: http2 });
        expect(r.outcome).toBe('not_covered');
        expect((await Order.findById(pendingId)).status).toBe('cancelled');
    });
});

describe('Park my car while you hold the keys', () => {
    test('the managed park ends and custody closes, only when the customer has the keys', async () => {
        const parkId = new mongoose.Types.ObjectId();
        await Order.collection.insertOne({ _id: parkId, customer: user._id, orderType: 'parking', status: 'parked' });
        const custody = await CurbCustody.collection.insertOne({
            customer: user._id, currentOrder: parkId, tier: 'home_garage', subscription: new mongoose.Types.ObjectId(), keysWith: 'valet', state: 'armed', spots: [], openedAt: new Date(), keyHandoffs: [],
        });
        expect(await curbCustody.reparkCandidate(user._id)).toBeNull();
        expect(await curbCustody.endForRepark(user._id)).toBeNull();
        await CurbCustody.collection.updateOne({ _id: custody.insertedId }, { $set: { keysWith: 'customer' } });
        expect(String((await curbCustody.reparkCandidate(user._id))._id)).toBe(String(custody.insertedId));
        await curbCustody.endForRepark(user._id);
        expect((await Order.findById(parkId)).status).toBe('completed');
        const closed = await CurbCustody.findById(custody.insertedId);
        expect(closed.closedAt).toBeTruthy();
        expect(closed.closeReason).toBe('superseded');
    });
});

/**
 * Paid at booking (Rishi, Nov 5 2026: "i think you should charge it at booking
 * because what if there's no card on file?").
 */
describe('paid at booking', () => {
    const auth = { Authorization: 'Bearer uid:sam' };
    const notifications = require('../controllers/notificationController');
    let pushes;

    /** A Stripe whose booking intents succeed when `pay(id)` says so. */
    function stripeForBooking({ savedCard = false } = {}) {
        const s = { intents: {}, created: [], refunds: [], cancels: [], offSession: [] };
        let n = 0;
        stripeClient.set({
            customers: {
                retrieve: async (id) => ({ id, invoice_settings: { default_payment_method: savedCard ? 'pm_visa' : null } }),
                create: async () => ({ id: 'cus_sam' }),
            },
            paymentMethods: {
                retrieve: async (id) => ({ id, customer: 'cus_sam', card: { brand: 'visa', last4: id === 'pm_apple' ? '1111' : '4242' } }),
                list: async () => ({ data: [] }),
            },
            ephemeralKeys: { create: async () => ({ secret: 'ek_1' }) },
            paymentIntents: {
                create: async (p, o) => {
                    if (p.off_session) {
                        s.offSession.push(p);
                        return { id: `pi_off_${++n}`, status: 'succeeded', amount: p.amount, currency: 'usd' };
                    }
                    const pi = { id: `pi_book_${++n}`, client_secret: `pi_book_${n}_secret`, status: 'requires_payment_method', amount: p.amount, currency: 'usd', metadata: p.metadata, payment_method: null };
                    s.intents[pi.id] = pi;
                    s.created.push({ p, o });
                    return pi;
                },
                retrieve: async (id, opts) => {
                    const pi = s.intents[id];
                    if (opts && opts.expand && pi && pi.payment_method) return { ...pi, payment_method: { id: pi.payment_method, card: { brand: 'visa', last4: '1111' } } };
                    return pi;
                },
                cancel: async (id) => {
                    s.cancels.push(id);
                    s.intents[id].status = 'canceled';
                    return s.intents[id];
                },
            },
            refunds: {
                create: async (p, o) => {
                    s.refunds.push({ p, o });
                    return { id: `re_${s.refunds.length}` };
                },
            },
        });
        s.pay = (id, pm = 'pm_apple') => {
            s.intents[id].status = 'succeeded';
            s.intents[id].payment_method = pm;
        };
        return s;
    }

    const later = (h = 26) => new Date(Date.now() + h * 3600e3).toISOString();
    const book = (extra = {}) =>
        request(app)
            .post('/api/schedule')
            .set(auth)
            .send({ userId: String(user._id), kind: 'pick-up', repeat: 'once', at: later(), address: HOME, payNow: true, ...extra });
    const paidUp = (id) => request(app).post(`/api/schedule/${id}/paid`).set(auth).send({ userId: String(user._id) });
    const mineNow = async () => (await request(app).get(`/api/schedule/mine/${user._id}`).set(auth)).body.moves;

    beforeEach(async () => {
        await User.updateOne({ _id: user._id }, { $set: { stripeCustomerId: 'cus_sam' } });
        pushes = [];
        jest.spyOn(notifications, 'sendPushNotification').mockImplementation(async (uid, title, body) => {
            pushes.push({ title, body });
        });
    });
    afterEach(() => jest.restoreAllMocks());

    test('a parking is paid when it is booked, with no card on file, and shows on Home once paid', async () => {
        const s = stripeForBooking();
        const res = await book();
        expect(res.status).toBe(201);
        expect(res.body.payment).toMatchObject({ amountCents: 1300, customerId: 'cus_sam', customerEphemeralKeySecret: 'ek_1' });
        const pi = s.created[0].p;
        expect(pi).toMatchObject({ amount: 1300, customer: 'cus_sam', setup_future_usage: 'off_session' });
        expect(pi.metadata).toMatchObject({ purpose: 'scheduled_prepay', scheduledMoveId: res.body.move._id });
        // Unpaid: not on the schedule, not on Home.
        expect(await mineNow()).toHaveLength(0);
        expect((await paidUp(res.body.move._id)).status).toBe(402);

        s.pay(res.body.payment.paymentIntentId);
        const ok = await paidUp(res.body.move._id);
        expect(ok.status).toBe(200);
        const [shown] = await mineNow();
        expect(shown.detail).toBe('Valet meets you at 200 W 20th St');
        expect(shown.paidCents).toBe(1300);
        const move = await ScheduledMove.findById(res.body.move._id).lean();
        expect(move).toMatchObject({ active: true, priced: true, paymentMethodId: 'pm_apple', prepaid: { cents: 1300 } });
        // The client asking twice changes nothing.
        expect((await paidUp(res.body.move._id)).status).toBe(200);
    });

    test('the webhook puts a paid booking on the schedule too; the sheet closed drops it', async () => {
        const s = stripeForBooking();
        const a = await book();
        s.pay(a.body.payment.paymentIntentId);
        expect(await moves.paymentSucceeded(s.intents[a.body.payment.paymentIntentId])).toEqual({ activated: a.body.move._id });
        expect(await moves.paymentSucceeded(s.intents[a.body.payment.paymentIntentId])).toEqual({ already: true });

        const b = await book();
        const gone = await request(app).delete(`/api/schedule/${b.body.move._id}`).set(auth).send({ userId: String(user._id) });
        expect(gone.status).toBe(200);
        expect(s.cancels).toEqual([b.body.payment.paymentIntentId]);
        expect(await ScheduledMove.findById(b.body.move._id)).toBeNull();
    });

    test('the sweep settles a paid booking the app never confirmed, and drops an unpaid one', async () => {
        const s = stripeForBooking();
        const a = await book();
        const b = await book();
        s.pay(a.body.payment.paymentIntentId);
        await moves.tick({ now: new Date(Date.now() + 5 * 60e3), http: { post: jest.fn() } });
        expect((await ScheduledMove.findById(a.body.move._id)).active).toBe(false);
        await moves.tick({ now: new Date(Date.now() + 16 * 60e3), http: { post: jest.fn() } });
        expect((await ScheduledMove.findById(a.body.move._id)).active).toBe(true);
        expect(await ScheduledMove.findById(b.body.move._id)).toBeNull();
        expect(s.cancels).toEqual([b.body.payment.paymentIntentId]);
    });

    test('the run uses the booking’s payment: no second charge, and the order carries it', async () => {
        const s = stripeForBooking();
        // As POST /:id/paid leaves a booking (a past run time can't go through the route).
        const move = await ScheduledMove.create({
            user: user._id, kind: 'pick-up', repeat: 'once', time: '19:00', address: HOME, nextAt: at('2026-10-13T23:00:00Z'),
            priced: true, paymentMethodId: 'pm_apple', prepaid: { paymentIntentId: 'pi_book_9', cents: 1300, paidAt: at('2026-10-12T12:00:00Z') },
        });
        s.intents.pi_book_9 = { id: 'pi_book_9', status: 'succeeded', amount: 1300, payment_method: 'pm_apple' };
        const order = await Order.collection.insertOne({ customer: user._id, orderType: 'parking', status: 'pending', paymentStatus: 'pending', totalAmount: 1300, serviceType: 'park-and-hold', createdAt: new Date() });
        const http = { post: jest.fn(async () => ({ data: { success: true, order: { _id: order.insertedId, totalAmount: 1300 } } })) };
        const [r] = await moves.tick({ now: at('2026-10-13T22:15:00Z'), http });
        expect(r).toMatchObject({ outcome: 'booked', prepaidCents: 1300 });
        expect(s.offSession).toHaveLength(0);
        expect(s.refunds).toHaveLength(0);
        const paid = await Order.findById(order.insertedId).lean();
        expect(paid).toMatchObject({ paymentStatus: 'paid', paymentIntentId: 'pi_book_9', totalAmount: 1300 });
        expect(paid.paymentDetails.paymentMethodDetails).toMatchObject({ brand: 'visa', last4: '1111' });
        expect(await Payment.countDocuments({ order: order.insertedId, paymentIntentId: 'pi_book_9' })).toBe(1);
        expect(pushes).toEqual([{ title: 'Your parking is booked', body: 'A valet collects your car at 7:00 PM.' }]);
        expect((await ScheduledMove.findById(move._id)).active).toBe(false);
    });

    test('a repeat’s next run is charged when it is booked, to the card the booking paid with', async () => {
        const s = stripeForBooking();
        await ScheduledMove.create({
            user: user._id, kind: 'pick-up', repeat: 'weekdays', time: '19:00', address: HOME, nextAt: at('2026-10-14T23:00:00Z'),
            priced: true, paymentMethodId: 'pm_apple',
        });
        const order = await Order.collection.insertOne({ customer: user._id, orderType: 'parking', status: 'pending', paymentStatus: 'pending', totalAmount: 1300, serviceType: 'park-and-hold', createdAt: new Date() });
        const http = { post: jest.fn(async () => ({ data: { success: true, order: { _id: order.insertedId, totalAmount: 1300 } } })) };
        const [r] = await moves.tick({ now: at('2026-10-14T22:15:00Z'), http });
        expect(r.outcome).toBe('booked');
        expect(s.offSession[0]).toMatchObject({ amount: 1300, payment_method: 'pm_apple', off_session: true });
        expect(pushes[0]).toEqual({ title: 'Your parking is booked', body: 'A valet collects your car at 7:00 PM. $13 was charged to your Visa ending 1111.' });
    });

    test('cancelling a paid booking refunds it; so does a run a plan covers', async () => {
        const s = stripeForBooking();
        const res = await book();
        s.pay(res.body.payment.paymentIntentId);
        await paidUp(res.body.move._id);
        const gone = await request(app).delete(`/api/schedule/${res.body.move._id}`).set(auth).send({ userId: String(user._id) });
        expect(gone.body).toMatchObject({ ok: true, refundedCents: 1300 });
        expect(s.refunds[0].p.payment_intent).toBe(res.body.payment.paymentIntentId);

        const move = await ScheduledMove.create({
            user: user._id, kind: 'pick-up', repeat: 'once', time: '19:00', address: HOME, nextAt: at('2026-10-15T23:00:00Z'),
            priced: true, prepaid: { paymentIntentId: 'pi_book_7', cents: 1300 },
        });
        await givePlan();
        const http = { post: jest.fn(async () => ({ data: { success: true, coveredBySubscription: true, order: { _id: new mongoose.Types.ObjectId() } } })) };
        await moves.tick({ now: at('2026-10-15T22:15:00Z'), http });
        expect(s.refunds.map((x) => x.p.payment_intent)).toEqual([res.body.payment.paymentIntentId, 'pi_book_7']);
        expect(pushes.pop()).toEqual({ title: 'Your parking is booked', body: 'A valet collects your car at 7:00 PM. It’s already paid for, so the $13 you paid is on its way back.' });
        expect((await ScheduledMove.findById(move._id)).active).toBe(false);
    });

    test('a retrieval is priced like Bring my car back now, and paid at booking', async () => {
        const s = stripeForBooking();
        // A car parked on its own: $5, paid now.
        await Order.collection.insertOne({ customer: user._id, orderType: 'parking', status: 'parked', serviceType: 'standard', createdAt: new Date() });
        expect((await request(app).get(`/api/schedule/quote/${user._id}`).set(auth)).body.dropOffCents).toBe(500);
        const paid = await book({ kind: 'drop-off' });
        expect(paid.body.payment.amountCents).toBe(500);
        // A Park + Retrieve's return is already paid for: booked at once, free.
        await Order.deleteMany({});
        await Order.collection.insertOne({ customer: user._id, orderType: 'parking', status: 'parked', serviceType: 'park-and-hold', createdAt: new Date() });
        expect((await request(app).get(`/api/schedule/quote/${user._id}`).set(auth)).body.dropOffCents).toBe(0);
        const free = await book({ kind: 'drop-off' });
        expect(free.status).toBe(201);
        expect(free.body.payment).toBeUndefined();
        expect(s.created).toHaveLength(1);
        expect((await ScheduledMove.findById(free.body.move._id)).active).toBe(true);
    });

    test('the retrieval run takes the booking’s $5; an older booking’s stays free', async () => {
        const s = stripeForBooking();
        const park = await Order.collection.insertOne({ customer: user._id, orderType: 'parking', status: 'parked', serviceType: 'standard', createdAt: new Date() });
        const retrieval = await Order.collection.insertOne({ customer: user._id, orderType: 'retrieval', status: 'pending', paymentStatus: 'paid', totalAmount: 0, isFreeService: true, linkedOrderId: park.insertedId, createdAt: new Date() });
        const calls = [];
        const http = { post: jest.fn(async (url, body) => {
            calls.push(url.split('/api/')[1]);
            if (url.endsWith('/createRetrievalOrder')) return { data: { success: true, order: { _id: retrieval.insertedId } } };
            return { data: { success: true } };
        }) };
        await ScheduledMove.create({
            user: user._id, kind: 'drop-off', repeat: 'once', time: '08:00', address: HOME, nextAt: at('2026-10-14T12:00:00Z'),
            priced: true, prepaid: { paymentIntentId: 'pi_book_5', cents: 500 },
        });
        const [r] = await moves.tick({ now: at('2026-10-14T11:20:00Z'), http });
        expect(r).toMatchObject({ outcome: 'booked', prepaidCents: 500 });
        expect(calls).toEqual(['order/createRetrievalOrder', 'notification/notify-closest-valets']);
        expect(await Order.findById(retrieval.insertedId).lean()).toMatchObject({ totalAmount: 500, isFreeService: false, paymentStatus: 'paid', paymentIntentId: 'pi_book_5' });
        expect(s.refunds).toHaveLength(0);

        // Booked by an older client, which said it was included: still free.
        await Order.updateOne({ _id: retrieval.insertedId }, { $set: { totalAmount: 0, isFreeService: true, paymentIntentId: null } });
        await ScheduledMove.create({ user: user._id, kind: 'drop-off', repeat: 'once', time: '08:00', address: HOME, nextAt: at('2026-10-15T12:00:00Z') });
        await moves.tick({ now: at('2026-10-15T11:20:00Z'), http });
        expect(await Order.findById(retrieval.insertedId).lean()).toMatchObject({ totalAmount: 0, isFreeService: true });
        expect(s.offSession).toHaveLength(0);
    });

    test('nothing to bring back: the booking’s money goes back', async () => {
        const s = stripeForBooking();
        await ScheduledMove.create({
            user: user._id, kind: 'drop-off', repeat: 'once', time: '08:00', address: HOME, nextAt: at('2026-10-14T12:00:00Z'),
            priced: true, prepaid: { paymentIntentId: 'pi_book_3', cents: 500 },
        });
        const [r] = await moves.tick({ now: at('2026-10-14T11:20:00Z'), http: { post: jest.fn() } });
        expect(r.outcome).toBe('no_car');
        expect(s.refunds[0].p.payment_intent).toBe('pi_book_3');
        expect(pushes).toEqual([{ title: 'Nothing to bring back', body: 'Your car isn’t parked with us, so there was nothing to bring back at 8:00 AM. The $5 you paid is on its way back.' }]);
    });
});
