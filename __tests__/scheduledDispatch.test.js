/**
 * Advance bookings: a job booked for later has to reach a valet on the day,
 * and must be invisible until then.
 * Run: npx jest scheduledDispatch
 *
 * Before this existed, dispatch was 100% client-triggered — both apps POST
 * notify-closest-valets the moment the card clears. A booking made on Saturday
 * for Thursday therefore had two failure modes and no good one: dispatch now
 * and five valets are pinged five days early (then the job sits in every
 * valet's feed all week, acceptable to grab and then forget), or don't and
 * nobody is ever told, until autoCancelStaleOrders cancels and refunds it
 * thirty minutes after the slot — silently, while the car takes a ticket.
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.STRIPE_API_KEY = 'sk_test_mocked';

const Order = require('../models/Order');
const User = require('../models/User');
const scheduledDispatch = require('../services/scheduledDispatch');
const orderController = require('../controllers/orderController');

let mongo;

const mockRes = () => {
    const res = {};
    res.statusCode = 200;
    res.body = null;
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
};

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const HOME = { lat: 40.6669714, lng: -73.9874191, streetAddress: '296 12th St, Brooklyn, NY 11215, USA' };

let customerSeq = 0;
const makeCustomer = () =>
    User.create({ phone: `+1718915${String(2000 + customerSeq++).padStart(4, "0")}`, isValet: false, verified: true });

/** A booking exactly as the web/app writes one, with the pickup we ask for. */
const booking = async (pickUpTime, overrides = {}) => {
    const customer = await makeCustomer();
    return Order.create({
        customer: customer._id,
        customerLocation: HOME,
        parkingType: 'street',
        orderType: 'parking',
        duration: 90,
        pickUpTime,
        paymentMethod: 'card',
        totalAmount: 1500,
        paymentStatus: 'paid',
        status: 'pending',
        serviceType: 'park-and-hold',
        aspMode: true,
        asp_time: new Date(new Date(pickUpTime).getTime() + 1.5 * HOUR),
        ...overrides,
    });
};

/** Collects the orders a tick would fan out, instead of hitting the network. */
const spyNotify = () => {
    const seen = [];
    const fn = async (orderId) => { seen.push(String(orderId)); };
    fn.seen = seen;
    return fn;
};

const spyAlert = () => {
    const seen = [];
    const fn = async (order) => { seen.push(String(order._id)); };
    fn.seen = seen;
    return fn;
};

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
});

afterEach(async () => {
    await Order.deleteMany({});
    await User.deleteMany({});
});

/* -------------------------------------------------------------------------- */

describe('a booking made for later is dispatched on the day, not at checkout', () => {
    it('leaves a booking five days out completely alone', async () => {
        const order = await booking(new Date(Date.now() + 5 * DAY));
        const notify = spyNotify();

        const res = await scheduledDispatch.tick({ notify, alert: spyAlert() });

        expect(notify.seen).toEqual([]);
        expect(res.dispatched).toBe(0);
        expect((await Order.findById(order._id)).dispatchedAt).toBeUndefined();
    });

    it('dispatches it once its pickup is inside the 45-minute lead', async () => {
        const order = await booking(new Date(Date.now() + 40 * MIN));
        const notify = spyNotify();

        const res = await scheduledDispatch.tick({ notify, alert: spyAlert() });

        expect(notify.seen).toEqual([String(order._id)]);
        expect(res.dispatched).toBe(1);
        expect((await Order.findById(order._id)).dispatchedAt).toBeInstanceOf(Date);
    });

    it('does not dispatch twice on the very next tick', async () => {
        await booking(new Date(Date.now() + 40 * MIN));
        const notify = spyNotify();

        await scheduledDispatch.tick({ notify, alert: spyAlert() });
        await scheduledDispatch.tick({ notify, alert: spyAlert() });

        expect(notify.seen).toHaveLength(1);
    });

    it('ignores an ordinary book-it-now order the client already dispatched', async () => {
        // notifiedValets is what notifyClosestValets writes, and it is the
        // marker that says "a client has already handled this one".
        const valet = await User.create({ phone: '+19796616772', isValet: true, verified: true });
        await booking(new Date(), {
            notifiedValets: [{ valet: valet._id, notifiedAt: new Date(), accepted: false }],
        });
        const notify = spyNotify();

        await scheduledDispatch.tick({ notify, alert: spyAlert() });

        expect(notify.seen).toEqual([]);
    });

    it('never touches an unpaid booking — that is an abandoned checkout', async () => {
        await booking(new Date(Date.now() + 40 * MIN), { paymentStatus: 'pending' });
        const notify = spyNotify();
        await scheduledDispatch.tick({ notify, alert: spyAlert() });
        expect(notify.seen).toEqual([]);
    });

    it('never touches one a valet has already taken', async () => {
        const valet = await User.create({ phone: '+19796616773', isValet: true, verified: true });
        await booking(new Date(Date.now() + 40 * MIN), { status: 'accepted', valet: valet._id });
        const notify = spyNotify();
        await scheduledDispatch.tick({ notify, alert: spyAlert() });
        expect(notify.seen).toEqual([]);
    });

    it('gives up on a slot already missed by half an hour', async () => {
        await booking(new Date(Date.now() - 30 * MIN));
        const notify = spyNotify();
        await scheduledDispatch.tick({ notify, alert: spyAlert() });
        expect(notify.seen).toEqual([]);
    });

    it('retries on the next tick when the fan-out throws', async () => {
        const order = await booking(new Date(Date.now() + 40 * MIN));
        const boom = async () => { throw new Error('maps down'); };

        await scheduledDispatch.tick({ notify: boom, alert: spyAlert() });
        const afterFailure = await Order.findById(order._id);
        expect(afterFailure.dispatchedAt).toBeUndefined();
        expect(afterFailure.dispatchAttempts).toBe(1);

        const notify = spyNotify();
        await scheduledDispatch.tick({ notify, alert: spyAlert() });
        expect(notify.seen).toEqual([String(order._id)]);
    });
});

describe('an unclaimed booking is pushed again, then escalated', () => {
    it('re-broadcasts one that has sat unclaimed for ten minutes', async () => {
        const order = await booking(new Date(Date.now() + 40 * MIN));
        const notify = spyNotify();
        await scheduledDispatch.tick({ notify, alert: spyAlert() });
        expect(notify.seen).toHaveLength(1);

        // Backdate the stamp rather than the clock — same thing, one field.
        await Order.updateOne(
            { _id: order._id },
            { $set: { dispatchedAt: new Date(Date.now() - 11 * MIN) } }
        );

        await scheduledDispatch.tick({ notify, alert: spyAlert() });
        expect(notify.seen).toEqual([String(order._id), String(order._id)]);
    });

    it('tells a human once, and only once, when the slot is fifteen minutes away', async () => {
        const order = await booking(new Date(Date.now() + 10 * MIN), {
            dispatchedAt: new Date(Date.now() - 30 * MIN),
        });
        const alert = spyAlert();

        await scheduledDispatch.tick({ notify: spyNotify(), alert });
        expect(alert.seen).toEqual([String(order._id)]);
        expect((await Order.findById(order._id)).dispatchEscalatedAt).toBeInstanceOf(Date);

        await scheduledDispatch.tick({ notify: spyNotify(), alert });
        expect(alert.seen).toHaveLength(1);
    });

    it('does not escalate one a valet has taken', async () => {
        const valet = await User.create({ phone: '+19796616774', isValet: true, verified: true });
        await booking(new Date(Date.now() + 10 * MIN), {
            dispatchedAt: new Date(Date.now() - 30 * MIN),
            status: 'accepted',
            valet: valet._id,
        });
        const alert = spyAlert();
        await scheduledDispatch.tick({ notify: spyNotify(), alert });
        expect(alert.seen).toEqual([]);
    });
});

describe('the valet feed stops at the dispatch horizon', () => {
    const feed = async () => {
        const res = mockRes();
        await orderController.getPendingOrders({ query: {} }, res);
        return res.body.orders.map((o) => String(o._id));
    };

    it('hides a booking that is days away', async () => {
        const later = await booking(new Date(Date.now() + 5 * DAY));
        expect(await feed()).not.toContain(String(later._id));
    });

    it('shows it once it is inside the lead window', async () => {
        const soon = await booking(new Date(Date.now() + 30 * MIN));
        expect(await feed()).toContain(String(soon._id));
    });

    it('still shows an ordinary job for right now', async () => {
        const now = await booking(new Date());
        expect(await feed()).toContain(String(now._id));
    });
});

describe('auto-cancel and advance bookings coexist', () => {
    const mockIo = () => ({ emit: () => {}, to: () => ({ emit: () => {} }) });

    it('a paid booking days out survives the stale sweep', async () => {
        const order = await booking(new Date(Date.now() + 5 * DAY));
        await Order.collection.updateOne(
            { _id: order._id },
            { $set: { createdAt: new Date(Date.now() - 45 * MIN) } }
        );
        await orderController.autoCancelStaleOrders(mockIo());
        expect((await Order.findById(order._id)).status).toBe('pending');
    });

    it('an unpaid one does not — that is an abandoned checkout', async () => {
        const order = await booking(new Date(Date.now() + 5 * DAY), { paymentStatus: 'pending' });
        await Order.collection.updateOne(
            { _id: order._id },
            { $set: { createdAt: new Date(Date.now() - 45 * MIN) } }
        );
        await orderController.autoCancelStaleOrders(mockIo());
        expect((await Order.findById(order._id)).status).toBe('cancelled');
    });
});
