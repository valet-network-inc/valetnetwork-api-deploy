/**
 * Crossing to the other side of the street must re-read THAT side's sign.
 * Run: npx jest sweepMoveKeepsOldCurbSchedule
 *
 * The $250 and $300 plans sell one promise: we work out your cleaning day and
 * move the car for it, forever, without asking you anything. An alternate-side
 * move is BY DEFINITION a hop from one curb of a street to the other — ten to
 * twenty metres. Block identity is a rounded lat/lng tile about 110m x 85m, so
 * that hop lands in the SAME tile almost every time, and arm() used to read
 * "same tile" as "same spot": it moved the pin and kept the old curb's windows,
 * kept `state`, and never dropped back to 'resolving'. Nothing else re-reads a
 * row that is neither resolving nor unknown, so from the first successful sweep
 * move onward the car was scheduled against the curb it had LEFT. It was never
 * moved for the curb it was on, and the in-progress watchdog was measured
 * against the same wrong windows, so it stayed quiet too. The customer's first
 * sign that anything was wrong was a $65 Brooklyn ticket the company eats.
 *
 * Two things have to hold for the loop to actually re-arm, and this pins both:
 *   1. the move is recorded as a NEW spot even though the tile did not change;
 *   2. the pre-move ParkingNote — still only ~18m away, so still "within
 *      tolerance" on distance alone — is not allowed to re-supply the old
 *      curb's windows for it.
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// The reminder push and the order controller both reach into firebase-admin on
// this path; a mock that only answers auth() hangs the run rather than failing.
jest.mock('firebase-admin', () => ({
    auth: () => ({ verifyIdToken: async () => ({ uid: 'test' }) }),
    messaging: () => ({
        send: async () => 'mock',
        sendEachForMulticast: async () => ({ responses: [], successCount: 0, failureCount: 0 }),
    }),
    firestore: () => ({
        collection: () => ({
            doc: () => ({
                get: async () => ({ exists: false, data: () => null }),
                set: async () => {},
                update: async () => {},
                collection: () => ({ add: async () => {}, get: async () => ({ docs: [] }) }),
            }),
            add: async () => {},
            where: () => ({ get: async () => ({ docs: [], empty: true }) }),
        }),
    }),
    apps: [{}],
    initializeApp: () => {},
    credential: { cert: () => ({}), applicationDefault: () => ({}) },
    storage: () => ({ bucket: () => ({ file: () => ({}) }) }),
}));

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
const notificationController = require('../controllers/notificationController');

let mongo;

const mockRes = () => {
    const res = {};
    res.statusCode = 200;
    res.body = null;
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
};

const mockIo = () => ({
    emit: () => {},
    to: () => ({ emit: () => {} }),
});

let phoneSeq = 5594000000;
const makeUser = (isValet = false) =>
    User.create({
        firstName: isValet ? 'Val' : 'Cust',
        lastName: 'Tester',
        email: `u${new mongoose.Types.ObjectId()}@example.com`,
        phone: String(++phoneSeq),
        verified: true,
        isValet,
        // remindKeyHolder only stamps lastMoveReminderKey on a DELIVERED push,
        // and a valet with no uid can never take one.
        firebaseUid: `uid_${phoneSeq}`,
    });

// One real Carroll Gardens block, both curbs of it. NORTH is swept Mondays,
// SOUTH Thursdays — the ordinary NYC arrangement, and the entire reason the
// move exists.
const NORTH = { lat: 40.68016, lng: -73.99266, streetAddress: '336 President St' };
const SOUTH = { lat: 40.68032, lng: -73.99266, streetAddress: '337 President St' };

const MON_830 = [{ day: 1, startTime: '08:30', endTime: '10:00' }];
const THU_1130 = [{ day: 4, startTime: '11:30', endTime: '13:00' }];

const makeSub = (user) =>
    Subscription.create({
        user: user._id,
        tier: 'home_garage',
        interval: 'month',
        status: 'active',
        amountCents: 25000,
        stripeSubscriptionId: `sub_curb_${++phoneSeq}`,
        currentPeriodStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        homeAddress: NORTH,
    });

const makePark = (customer, valet, sub) =>
    Order.create({
        customer: customer._id,
        valet: valet._id,
        customerLocation: NORTH,
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
    });

const makeNote = (order, valet, where, streetCleaning) =>
    ParkingNote.findOneAndUpdate(
        { order: order._id },
        {
            order: order._id,
            valet: valet._id,
            location: where,
            signPhotoBucket: 'test-bucket',
            signPhotoStoragePath: `parking-notes/${order._id}/x.jpg`,
            streetCleaning,
            sweepDataStatus: 'captured',
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

const park = async (orderId, updates) => {
    const req = { body: { orderId: String(orderId), updates }, io: mockIo() };
    await orderController.updateOrder(req, mockRes());
};

const nextMonday830 = () =>
    sweepWindows.nextSweep(sweepWindows.toSweepWindows(MON_830).windows, new Date()).at;

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await CurbCustody.init();
    await OpsAlert.init();
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
}, 60000);

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
}, 60000);

describe('a sweep move across the street', () => {
    test('the two curbs of one street are the same tile — which is what made this silent', () => {
        expect(sweepWindows.tileKeyOf(SOUTH)).toBe(sweepWindows.tileKeyOf(NORTH));
        const away = sweepWindows.haversineMeters(NORTH, SOUTH);
        // Far enough to be a real move, near enough that the pre-move note is
        // still inside NOTE_SPOT_TOLERANCE_M. Both halves of the trap.
        expect(away).toBeGreaterThan(10);
        expect(away).toBeLessThan(curbCustody.NOTE_SPOT_TOLERANCE_M);
    });

    test('drops the curb it left and re-reads the curb it is now on', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub);

        // Monday morning's curb, read off the sign by the valet who parked it.
        await park(order._id, { status: 'parked', parkingLocation: NORTH });
        const note = await makeNote(order, valet, NORTH, MON_830);
        await curbCustody.enrichFromNote({ order: await Order.findById(order._id), note });

        let custody = await CurbCustody.findOne({ currentOrder: order._id });
        expect(custody.state).toBe('armed');
        expect(custody.rules.windows[0]).toMatchObject({ weekday: 1, hour: 8, minute: 30 });

        // 7:45 Monday: we hold the keys, so the mover is a push, not an order.
        const now = new Date(nextMonday830().getTime() - 45 * 60 * 1000 + 60 * 1000);
        jest.spyOn(notificationController, 'sendPushNotification')
            .mockResolvedValue({ success: true });
        const results = await dispatcher.tick({ now, io: mockIo(), notify: jest.fn() });
        expect(results.some((r) => r.outcome === 'reminded')).toBe(true);

        custody = await CurbCustody.findOne({ currentOrder: order._id });
        expect(custody.lastMoveReminderKey).toBeTruthy();

        // The valet walks it across and records the new spot. Same tile.
        await park(order._id, { parkingLocation: SOUTH });

        custody = await CurbCustody.findOne({ currentOrder: order._id });
        expect(custody.spots).toHaveLength(2);
        expect(custody.spot.streetAddress).toBe(SOUTH.streetAddress);
        // Monday belongs to the curb the car has left. Carrying it forward is
        // the bug: the car would be moved every Monday for a sweep that is not
        // there and left standing every Thursday for the one that is.
        expect(custody.rules.windows).toHaveLength(0);
        expect(custody.state).toBe('resolving');

        // The dispatcher's own retry must not quietly resurrect Monday from the
        // note the valet took on the north side — it is only ~18m away, well
        // inside the distance tolerance, and it is the wrong curb.
        await dispatcher.tick({ now, io: mockIo(), notify: jest.fn() });
        custody = await CurbCustody.findOne({ currentOrder: order._id });
        expect(custody.rules.windows).toHaveLength(0);
        expect(custody.rules.source).toBe('unknown');
        // 'blind' is the loud state: the watchdog pages no_rules_for_block and
        // an operator can type the sign in. Loud beats a confident wrong day.
        expect(custody.state).toBe('blind');

        // And the south side's own sign re-arms it. This is the recursion.
        const southNote = await makeNote(order, valet, SOUTH, THU_1130);
        await curbCustody.enrichFromNote({
            order: await Order.findById(order._id),
            note: southNote,
        });

        custody = await CurbCustody.findOne({ currentOrder: order._id });
        expect(custody.state).toBe('armed');
        expect(custody.rules.windows[0]).toMatchObject({ weekday: 4, hour: 11, minute: 30 });
    }, 60000);

    test('with no move outstanding a re-pin on the same block is still just a re-pin', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub);

        await park(order._id, { status: 'parked', parkingLocation: NORTH });
        const note = await makeNote(order, valet, NORTH, MON_830);
        await curbCustody.enrichFromNote({ order: await Order.findById(order._id), note });

        // Nobody has been asked to move anything, so a valet nudging the pin
        // down the block has not changed the sign and must not blank a good
        // reading — that would page an operator for every corrected pin.
        await park(order._id, { parkingLocation: SOUTH });

        const custody = await CurbCustody.findOne({ currentOrder: order._id });
        expect(custody.spots).toHaveLength(1);
        expect(custody.state).toBe('armed');
        expect(custody.rules.windows[0]).toMatchObject({ weekday: 1, hour: 8, minute: 30 });
    }, 60000);
});
