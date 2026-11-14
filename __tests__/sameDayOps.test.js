/**
 * Same-day bookings reach ops at once (Rishi, Nov 14 2026): a push to every
 * alwaysNotify valet, today's parkings booked the moment they're requested,
 * and the rest of today in that valet's order list.
 *
 * Run: npx jest sameDayOps
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
const ScheduledMove = require('../models/ScheduledMove');
const moves = require('../services/scheduledMoves');
const opsAlert = require('../services/opsAlert');
const stripeClient = require('../services/stripeClient');
const notificationController = require('../controllers/notificationController');

const app = express();
app.use(express.json());
app.use('/api/order', require('../routes/order'));
app.use('/api/notification', require('../routes/notification'));

const HOME = { streetAddress: '134 Boerum Pl, Brooklyn, NY 11201, USA', lat: 40.6869, lng: -73.9905 };
const at = (iso) => new Date(iso);
// Saturday Nov 14 2026, New York is UTC-5.
const NOW = at('2026-11-14T15:00:00Z'); // 10:00 AM
const THREE_PM = at('2026-11-14T20:00:00Z');
const YESTERDAY = at('2026-11-13T22:00:00Z');

let mongo;
let user;
let ops;
let pushes;
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
    user = await User.create({ verified: true, phone: '+19175550134', firebaseUid: 'marcie', firstName: 'Marcie', lastName: 'B' });
    ops = await User.create({ verified: true, phone: '+19175550100', firebaseUid: 'rishi', isValet: true, isActive: true, alwaysNotify: true });
    await User.create({ verified: true, phone: '+19175550101', firebaseUid: 'jules', isValet: true, isActive: true });
    pushes = [];
    jest.spyOn(notificationController, 'sendPushNotification').mockImplementation(async (uid, title, body, data) => {
        pushes.push({ uid, title, body, data });
    });
});
afterEach(() => jest.restoreAllMocks());

/** A move written straight to the collection, so its timestamps are ours. */
async function insertMove(fields) {
    const doc = { user: user._id, repeat: 'once', time: '15:00', address: HOME, active: true, nextAt: THREE_PM, createdAt: NOW, updatedAt: NOW, ...fields };
    const r = await ScheduledMove.collection.insertOne(doc);
    return ScheduledMove.findById(r.insertedId);
}

function stubHttp(orderId) {
    const calls = [];
    const http = { post: jest.fn(async (url, body) => {
        calls.push({ url: url.split('/api/')[1], body });
        return { data: { success: true, coveredBySubscription: true, order: { _id: orderId } } };
    }) };
    return { calls, http };
}

describe('the push to ops', () => {
    test('a move for later today tells every alwaysNotify valet, once', async () => {
        const move = await insertMove({ kind: 'drop-off' });
        expect(await opsAlert.scheduledMove(move, NOW)).toBe(true);
        expect(await opsAlert.scheduledMove(move, NOW)).toBe(false);
        expect(pushes).toHaveLength(1);
        expect(pushes[0]).toMatchObject({ uid: 'rishi', title: 'New booking for today' });
        expect(pushes[0].body).toBe('Marcie B · retrieval at 3:00 PM · 134 Boerum Pl');
    });

    test('a move for tomorrow, or one already past, tells nobody', async () => {
        const tomorrow = await insertMove({ kind: 'pick-up', nextAt: at('2026-11-15T20:00:00Z') });
        const past = await insertMove({ kind: 'pick-up', nextAt: at('2026-11-14T14:00:00Z') });
        expect(await opsAlert.scheduledMove(tomorrow, NOW)).toBe(false);
        expect(await opsAlert.scheduledMove(past, NOW)).toBe(false);
        expect(pushes).toHaveLength(0);
    });

    test('a move booked through the schedule service pushes on save', async () => {
        await User.updateOne({ _id: user._id }, { $set: { stripeCustomerId: 'cus_m' } });
        stripeClient.set({
            customers: { retrieve: async () => ({ id: 'cus_m', invoice_settings: { default_payment_method: 'pm_visa' } }) },
            paymentMethods: { retrieve: async () => ({ id: 'pm_visa', card: { brand: 'visa', last4: '4242' } }), list: async () => ({ data: [] }) },
        });
        const r = await moves.create(String(user._id), { kind: 'drop-off', repeat: 'once', at: THREE_PM.toISOString(), address: HOME }, NOW);
        expect(r.error).toBeUndefined();
        expect(pushes.map((p) => p.body)).toEqual(['Marcie B · retrieval at 3:00 PM · 134 Boerum Pl']);
    });

    test('a paid order booked for later today pushes when its dispatch is deferred', async () => {
        const o = await Order.collection.insertOne({ customer: user._id, orderType: 'parking', status: 'pending', paymentStatus: 'paid', pickUpTime: new Date(Date.now() + 3 * 3600e3), customerLocation: HOME, createdAt: new Date() });
        const sameDay = opsAlert.isLaterToday(new Date(Date.now() + 3 * 3600e3));
        const res = await request(app).post('/api/notification/notify-closest-valets').send({ orderId: String(o.insertedId) });
        expect(res.body.deferred).toBe(true);
        await request(app).post('/api/notification/notify-closest-valets').send({ orderId: String(o.insertedId) });
        // Late in the evening "3 hours from now" is tomorrow: then nobody hears.
        expect(pushes).toHaveLength(sameDay ? 1 : 0);
    });
});

describe('today’s parkings are booked at once', () => {
    test('a parking requested today for later today is booked on the next tick, once', async () => {
        const orderId = new mongoose.Types.ObjectId();
        const move = await insertMove({ kind: 'pick-up' });
        const { calls, http } = stubHttp(orderId);
        const [r] = await moves.tick({ now: NOW, http });
        expect(r.outcome).toBe('booked');
        expect(calls.map((c) => c.url)).toEqual(['order/createOrder']);
        expect(new Date(calls[0].body.pickUpTime).toISOString()).toBe(THREE_PM.toISOString());
        await moves.tick({ now: at('2026-11-14T15:01:00Z'), http });
        expect(calls).toHaveLength(1);
        const after = await ScheduledMove.findById(move._id);
        expect(after.active).toBe(false);
        expect(String(after.lastOrder)).toBe(String(orderId));
    });

    test('a parking requested yesterday for today waits for the usual time', async () => {
        await insertMove({ kind: 'pick-up', createdAt: YESTERDAY, updatedAt: YESTERDAY });
        const { calls, http } = stubHttp(new mongoose.Types.ObjectId());
        await moves.tick({ now: NOW, http });
        expect(calls).toHaveLength(0);
        await moves.tick({ now: at('2026-11-14T19:10:00Z'), http }); // 2:10, 50 min before
        expect(calls).toHaveLength(1);
    });

    test('a retrieval for later today keeps its lead (it is dispatched when made)', async () => {
        await insertMove({ kind: 'drop-off' });
        const { calls, http } = stubHttp(new mongoose.Types.ObjectId());
        await moves.tick({ now: NOW, http });
        expect(calls).toHaveLength(0);
    });

    test('an early try that can’t book (car still out) is left for the usual time', async () => {
        const move = await insertMove({ kind: 'pick-up' });
        const calls = [];
        const http = { post: jest.fn(async (url) => {
            calls.push(url);
            const err = new Error('busy');
            err.response = { data: { existingOrderId: 'x', message: 'Car is out' } };
            throw err;
        }) };
        await moves.tick({ now: NOW, http });
        await moves.tick({ now: at('2026-11-14T15:01:00Z'), http });
        expect(calls).toHaveLength(1);
        const after = await ScheduledMove.findById(move._id);
        expect(after.active).toBe(true);
        expect(after.lastKey).toBeUndefined();
        await moves.tick({ now: at('2026-11-14T19:10:00Z'), http });
        expect(calls).toHaveLength(2);
    });
});

describe('the order list', () => {
    test('an alwaysNotify valet sees the rest of today; other valets keep the 45-minute window', async () => {
        const later = new Date(Math.min(Date.now() + 2 * 3600e3, opsAlert.endOfNyToday().getTime() - 60e3));
        const tomorrow = new Date(opsAlert.endOfNyToday().getTime() + 3600e3);
        await Order.collection.insertMany([
            { customer: user._id, orderType: 'parking', status: 'pending', paymentStatus: 'paid', pickUpTime: later, createdAt: new Date() },
            { customer: user._id, orderType: 'parking', status: 'pending', paymentStatus: 'paid', pickUpTime: tomorrow, createdAt: new Date() },
        ]);
        const mine = await request(app).get('/api/order/getPendingOrders').set('Authorization', 'Bearer uid:rishi');
        const theirs = await request(app).get('/api/order/getPendingOrders').set('Authorization', 'Bearer uid:jules');
        const laterIsOutsideWindow = later.getTime() - Date.now() > 45 * 60e3;
        expect(mine.body.orders).toHaveLength(1);
        expect(theirs.body.orders).toHaveLength(laterIsOutsideWindow ? 0 : 1);
    });
});

describe('the heads-up, three hours before', () => {
    test('a parking booked yesterday for 3 PM pushes once at noon, and its order at 2:10 adds nothing', async () => {
        const orderId = new mongoose.Types.ObjectId();
        await insertMove({ kind: 'pick-up', createdAt: YESTERDAY, updatedAt: YESTERDAY });
        // createOrder makes the paid pending order, as the real endpoint does.
        const http = { post: jest.fn(async () => {
            await Order.collection.insertOne({ _id: orderId, customer: user._id, orderType: 'parking', status: 'pending', paymentStatus: 'paid', pickUpTime: THREE_PM, customerLocation: HOME, createdAt: new Date() });
            return { data: { success: true, coveredBySubscription: true, order: { _id: orderId } } };
        }) };
        await moves.tick({ now: at('2026-11-14T16:59:00Z'), http }); // 11:59
        expect(pushes).toHaveLength(0);
        await moves.tick({ now: at('2026-11-14T17:01:00Z'), http }); // 12:01
        await moves.tick({ now: at('2026-11-14T17:02:00Z'), http });
        expect(pushes).toHaveLength(1);
        expect(pushes[0]).toMatchObject({ uid: 'rishi', title: 'Coming up today', body: 'Marcie B · parking at 3:00 PM · 134 Boerum Pl' });
        await moves.tick({ now: at('2026-11-14T19:10:00Z'), http }); // minted
        expect(http.post).toHaveBeenCalledTimes(1);
        await moves.tick({ now: at('2026-11-14T19:11:00Z'), http });
        expect(pushes).toHaveLength(1);
    });

    test('an advance order pushes three hours out, once; a job for now never does', async () => {
        await Order.collection.insertMany([
            { customer: user._id, orderType: 'parking', status: 'pending', paymentStatus: 'paid', pickUpTime: THREE_PM, customerLocation: HOME, createdAt: YESTERDAY },
            { customer: user._id, orderType: 'parking', status: 'pending', paymentStatus: 'paid', pickUpTime: at('2026-11-14T17:10:00Z'), customerLocation: HOME, createdAt: NOW },
        ]);
        expect(await opsAlert.headsUp(at('2026-11-14T17:01:00Z'))).toBe(1);
        expect(await opsAlert.headsUp(at('2026-11-14T17:05:00Z'))).toBe(0);
        expect(pushes.map((p) => p.body)).toEqual(['Marcie B · parking at 3:00 PM · 134 Boerum Pl']);
    });

    test('a retrieval booked yesterday for 9 AM pushes at 6 AM', async () => {
        await insertMove({ kind: 'drop-off', nextAt: at('2026-11-14T14:00:00Z'), createdAt: YESTERDAY, updatedAt: YESTERDAY });
        expect(await opsAlert.headsUp(at('2026-11-14T10:59:00Z'))).toBe(0);
        expect(await opsAlert.headsUp(at('2026-11-14T11:00:00Z'))).toBe(1);
        expect(pushes[0].body).toBe('Marcie B · retrieval at 9:00 AM · 134 Boerum Pl');
    });
});
