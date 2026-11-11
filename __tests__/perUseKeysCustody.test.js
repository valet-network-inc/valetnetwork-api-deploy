/**
 * Managing a car we hold on the street.
 * Run: npx jest curbCustody
 *
 * The $250 and $300 plans stopped asking customers when their street is cleaned
 * (commit db519f1). This is the half that replaces the question: we read the
 * sign where the valet parked the car and move it before that block's sweep,
 * again and again, until the customer takes the car back.
 *
 * What these tests pin, in the order the failures would hurt:
 *
 *  1. The window comes off the valet's own ParkingNote, and off another valet's
 *     note on the same block when this order has none.
 *  2. THE LOOP RE-ARMS. A move re-reads the new block. Getting this wrong means
 *     a car is managed exactly once and then abandoned wherever the first sweep
 *     left it — which is the whole failure this feature exists to prevent.
 *  3. Custody ends when the customer actually takes the car, and NOT when a
 *     sweep's return leg completes, which looks identical at the call site.
 *  4. A suspended day is never dispatched on.
 *  5. A block we cannot read ALARMS. It never silently continues, which is
 *     exactly what the shipped code does today.
 *  6. street_cleaning is untouched.
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../models/Order');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const ParkingNote = require('../models/ParkingNote');
const StreetParkingMark = require('../models/StreetParkingMark');
const AspSuspension = require('../models/AspSuspension');
const CurbCustody = require('../models/CurbCustody');
const OpsAlert = require('../models/OpsAlert');

const curbCustody = require('../services/curbCustody');
const dispatcher = require('../services/curbSweepDispatcher');
const sweepWindows = require('../services/sweepWindows');
const aspSuspensions = require('../services/aspSuspensions');
const orderController = require('../controllers/orderController');
const custodyController = require('../controllers/custodyController');

let mongo;

const mockRes = () => {
    const res = {};
    res.statusCode = 200;
    res.body = null;
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
};

const mockIo = () => {
    const emits = [];
    return {
        emits,
        emit: (event, payload) => emits.push({ room: null, event, payload }),
        to: (room) => ({ emit: (event, payload) => emits.push({ room, event, payload }) }),
    };
};

let phoneSeq = 5591000000;
const makeUser = (isValet = false) =>
    User.create({
        firstName: isValet ? 'Val' : 'Cust',
        lastName: 'Tester',
        email: `u${new mongoose.Types.ObjectId()}@example.com`,
        phone: String(++phoneSeq),
        verified: true,
        isValet,
    });

// Two real Carroll Gardens blocks, far enough apart to be different tiles.
const BLOCK_A = { lat: 40.68016, lng: -73.99266, streetAddress: '336 President St' };
const BLOCK_B = { lat: 40.68282, lng: -73.99293, streetAddress: '366 Degraw St' };

// Monday 08:30-10:00, the shape production ParkingNotes actually carry.
const MON_830 = [{ day: 1, startTime: '08:30', endTime: '10:00' }];
const THU_1130 = [{ day: 4, startTime: '11:30', endTime: '13:00' }];

const makeSub = (user, tier = 'home_garage') =>
    Subscription.create({
        user: user._id,
        tier,
        interval: 'month',
        status: 'active',
        amountCents: tier === 'home_garage' ? 25000 : 30000,
        stripeSubscriptionId: `sub_curb_${++phoneSeq}`,
        currentPeriodStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        ...(tier === 'home_garage' ? { homeAddress: BLOCK_A } : {}),
    });

const makePark = (customer, valet, sub, overrides = {}) =>
    Order.create({
        customer: customer._id,
        valet: valet._id,
        customerLocation: BLOCK_A,
        parkingType: 'street',
        orderType: 'parking',
        duration: 90,
        pickUpTime: new Date(),
        status: 'accepted',
        totalAmount: 0,
        listPriceCents: 1500,
        paymentMethod: 'card',
        paymentStatus: 'paid',
        serviceType: 'park-and-hold',
        coveredBySubscription: sub._id,
        vehicle: { color: 'Black', model: 'Civic', licensePlate: 'ABC1234' },
        ...overrides,
    });

const makeNote = (order, valet, where, streetCleaning, extra = {}) =>
    ParkingNote.create({
        order: order._id,
        valet: valet._id,
        location: where,
        signPhotoBucket: 'test-bucket',
        signPhotoStoragePath: `parking-notes/${order._id}/x.jpg`,
        streetCleaning,
        ...extra,
    });

const park = async (orderId, updates, io) => {
    const req = { body: { orderId: String(orderId), updates }, io: io || mockIo() };
    const res = mockRes();
    await orderController.updateOrder(req, res);
    return res;
};

/** The next real Monday 08:30 New York, as a UTC instant. */
const nextMonday830 = (from = new Date()) =>
    sweepWindows.nextSweep(sweepWindows.toSweepWindows(MON_830).windows, from).at;


beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await CurbCustody.init();
    await OpsAlert.init();
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
});

afterEach(async () => {
    await Promise.all([
        Order.deleteMany({}),
        User.deleteMany({}),
        Subscription.deleteMany({}),
        ParkingNote.deleteMany({}),
        StreetParkingMark.deleteMany({}),
        AspSuspension.deleteMany({}),
        CurbCustody.deleteMany({}),
        OpsAlert.deleteMany({}),
    ]);
    aspSuspensions.invalidate();
    jest.restoreAllMocks();
});

/**
 * "Who should keep the keys?" on a per-use park (Nov 11 2026, Rishi's rule):
 * the valet keeps them for the parking time. A sweep inside that time we move;
 * when it ends the keys go back (or the car does, if they asked for it), so a
 * sweep after it is not ours.
 */
const perUsePark = (customer, valet, { hours = 3, pickUpTime = new Date(), keysChoice = 'valet' } = {}) =>
    Order.create({
        customer: customer._id,
        valet: valet._id,
        customerLocation: BLOCK_A,
        parkingType: 'street',
        orderType: 'parking',
        duration: hours * 60,
        pickUpTime,
        status: 'accepted',
        totalAmount: 1300,
        paymentMethod: 'card',
        paymentStatus: 'paid',
        serviceType: 'park-and-hold',
        vehicle: { color: 'Blue', model: 'Outback', licensePlate: 'KDT4417' },
        ...(keysChoice ? { keysChoice } : {}),
    });

const armPerUse = async (opts) => {
    const customer = await makeUser();
    const valet = await makeUser(true);
    const order = await perUsePark(customer, valet, opts);
    await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });
    const note = await makeNote(order, valet, BLOCK_A, MON_830, { sweepDataStatus: 'captured' });
    await curbCustody.enrichFromNote({ order: await Order.findById(order._id), note });
    return { customer, valet, order };
};

describe('per-use parks where the valet keeps the keys', () => {
    test('parking it opens a per_use custody, keys with the valet, held until the time is up', async () => {
        const pickUpTime = new Date();
        const { customer, valet, order } = await armPerUse({ hours: 3, pickUpTime });
        const custody = await CurbCustody.findOne({ customer: customer._id });
        expect(custody).toBeTruthy();
        expect(custody.tier).toBe('per_use');
        expect(custody.subscription).toBeFalsy();
        expect(custody.keysWith).toBe('valet');
        expect(String(custody.keyHolder)).toBe(String(valet._id));
        expect(custody.holdUntil.getTime()).toBe(pickUpTime.getTime() + 3 * 60 * 60 * 1000);
        const fresh = await Order.findById(order._id);
        expect(fresh.keysStayWithValet).toBe(true);
    });

    test('a per-use park without the choice opens nothing (the keys come back as today)', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await perUsePark(customer, valet, { keysChoice: null });
        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });
        expect(await CurbCustody.countDocuments({})).toBe(0);
    });

    test("the valet's swipe closes the job out: no key return to walk", async () => {
        const { order } = await armPerUse({ hours: 3 });
        await park(order._id, { status: 'parked' });
        const fresh = await Order.findById(order._id);
        expect(fresh.parkClosedAt).toBeTruthy();
    });

    test('a sweep inside the parking time: the valet holding the keys is told to move it (no order, no charge)', async () => {
        const sweep = nextMonday830();
        // Parked the evening before, for long enough to cover the sweep.
        const pickUpTime = new Date(sweep.getTime() - 10 * 60 * 60 * 1000);
        await armPerUse({ hours: 12, pickUpTime });
        const now = new Date(sweep.getTime() - 30 * 60 * 1000);
        const results = await dispatcher.tick({ now, io: mockIo(), notify: jest.fn() });
        const mine = results.filter((r) => ['reminded', 'reminder_undelivered', 'no_key_holder'].includes(r.outcome));
        expect(mine).toHaveLength(1);
        expect(await Order.countDocuments({ aspMode: true })).toBe(0);
    });

    test('a sweep after the parking time is not ours: the keys will have gone back', async () => {
        const sweep = nextMonday830();
        const pickUpTime = new Date(sweep.getTime() - 10 * 60 * 60 * 1000);
        await armPerUse({ hours: 3, pickUpTime });
        const now = new Date(sweep.getTime() - 30 * 60 * 1000);
        const results = await dispatcher.tick({ now, io: mockIo(), notify: jest.fn() });
        expect(results.filter((r) => r.outcome === 'after_hold')).toHaveLength(1);
        expect(results.filter((r) => r.outcome === 'reminded')).toHaveLength(0);
    });

    test('time up: the keys go back on their own, and the custody closes when they are handed over', async () => {
        const pickUpTime = new Date(Date.now() - 4 * 60 * 60 * 1000);
        const { customer, order } = await armPerUse({ hours: 3, pickUpTime });
        const out = await dispatcher.releaseExpired({ now: new Date(), io: mockIo() });
        expect(out.filter((r) => r.outcome === 'keys_returning')).toHaveLength(1);
        const delivery = await Order.findOne({ keyDeliveryOnly: true });
        expect(delivery).toBeTruthy();
        expect(String(delivery.linkedOrderId)).toBe(String(order._id));
        // A second pass doesn't send a second valet.
        const again = await dispatcher.releaseExpired({ now: new Date(), io: mockIo() });
        expect(again.filter((r) => r.outcome === 'already_returning')).toHaveLength(1);
        // The valet hands them over.
        await park(delivery._id, { status: 'completed' });
        const custody = await CurbCustody.findOne({ customer: customer._id });
        expect(custody.closedAt).toBeTruthy();
        expect(custody.closeReason).toBe('keys_returned');
        expect(custody.keysWith).toBe('customer');
    });

    test('time up with a retrieval already bringing the car: no key run (it takes them with the car)', async () => {
        const pickUpTime = new Date(Date.now() - 4 * 60 * 60 * 1000);
        const { customer, valet, order } = await armPerUse({ hours: 3, pickUpTime });
        const ret = await Order.create({
            customer: customer._id,
            valet: valet._id,
            customerLocation: BLOCK_A,
            orderType: 'retrieval',
            parkingType: 'retrieval',
            duration: 30,
            pickUpTime: new Date(),
            status: 'accepted',
            totalAmount: 0,
            paymentMethod: 'card',
            paymentStatus: 'paid',
            linkedOrderId: order._id,
        });
        await Order.updateOne({ _id: order._id }, { $set: { linkedOrderId: ret._id } });
        const out = await dispatcher.releaseExpired({ now: new Date(), io: mockIo() });
        expect(out.filter((r) => r.outcome === 'retrieval_running')).toHaveLength(1);
        expect(await Order.countDocuments({ keyDeliveryOnly: true })).toBe(0);
    });

    test('time added after the park: the keys stay until the new end', async () => {
        const pickUpTime = new Date(Date.now() - 4 * 60 * 60 * 1000);
        const { customer, order } = await armPerUse({ hours: 3, pickUpTime });
        // Add time: two more hours on the park (extensionController bumps duration).
        await Order.updateOne({ _id: order._id }, { $inc: { duration: 120 } });
        const out = await dispatcher.releaseExpired({ now: new Date(), io: mockIo() });
        expect(out.filter((r) => r.outcome === 'time_added')).toHaveLength(1);
        expect(await Order.countDocuments({ keyDeliveryOnly: true })).toBe(0);
        const custody = await CurbCustody.findOne({ customer: customer._id });
        expect(custody.holdUntil.getTime()).toBe(pickUpTime.getTime() + 5 * 60 * 60 * 1000);
    });

    test('a sweep inside the added time is ours to move', async () => {
        const sweep = nextMonday830();
        const pickUpTime = new Date(sweep.getTime() - 10 * 60 * 60 * 1000);
        const { order } = await armPerUse({ hours: 3, pickUpTime });
        await Order.updateOne({ _id: order._id }, { $inc: { duration: 9 * 60 } });
        const now = new Date(sweep.getTime() - 30 * 60 * 1000);
        const results = await dispatcher.tick({ now, io: mockIo(), notify: jest.fn() });
        expect(results.filter((r) => r.outcome === 'after_hold')).toHaveLength(0);
        expect(results.filter((r) => ['reminded', 'reminder_undelivered', 'no_key_holder'].includes(r.outcome))).toHaveLength(1);
    });
});
