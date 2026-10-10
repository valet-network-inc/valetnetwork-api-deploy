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
    await mongoose.disconnect();
    await mongo.stop();
});
beforeEach(async () => {
    await mongoose.connection.db.dropDatabase();
    user = await User.create({ verified: true, phone: '+19175550134', firebaseUid: 'sam' });
});

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
    test('only on a plan that includes the move', async () => {
        const auth = { Authorization: 'Bearer uid:sam' };
        const body = { userId: String(user._id), kind: 'drop-off', repeat: 'once', at: new Date(Date.now() + 3 * 3600e3).toISOString(), address: HOME };
        const none = await request(app).post('/api/schedule').set(auth).send(body);
        expect(none.status).toBe(403);
        await givePlan();
        const soon = await request(app).post('/api/schedule').set(auth).send({ ...body, at: new Date(Date.now() + 10 * 60e3).toISOString() });
        expect(soon.status).toBe(400);
        const ok = await request(app).post('/api/schedule').set(auth).send(body);
        expect(ok.status).toBe(201);
        expect(ok.body.move.detail).toBe('Brought to 200 W 20th St · Included');
        const list = await request(app).get(`/api/schedule/mine/${user._id}`).set(auth);
        expect(list.body.moves).toHaveLength(1);
        const other = await User.create({ verified: true, phone: '+12125550100', firebaseUid: 'eve' });
        const peek = await request(app).delete(`/api/schedule/${ok.body.move._id}`).set('Authorization', 'Bearer uid:eve').send({ userId: String(other._id) });
        expect(peek.status).toBe(404);
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
        expect(calls[0].body).toMatchObject({ customer: String(user._id), orderType: 'parking', totalAmount: 0 });
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
