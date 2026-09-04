/**
 * The "a sweep is running and the car has not moved" page.
 * Run: npx jest sweepInProgressPageNeverFired
 *
 * services/curbSweepDispatcher.js registers watch() OUTSIDE CURB_SWEEP_ENABLED
 * on purpose, and says why at the top of the file: turning the mover off to
 * investigate something is a decision, turning the alarm off with it is how a
 * car takes a ticket nobody hears about.
 *
 * The alarm did not keep that promise. Both of its in-progress branches read
 * `reminderSpotKey` / `reminderSentAt`, and the only writers of those two fields
 * are remindKeyHolder and bookMove — both inside tick(), both behind the flag.
 * So for the one car the page exists for (the mover was off, or came back
 * `no_key_holder` because the order's valet had been blanked, or threw, or the
 * sign photo landed after the dispatch window closed) both fields were undefined
 * and nothing was ever raised: `spot.tileKey === undefined` is false, and
 * `reminderSentAt` is falsy. The car sat on a block being swept, in silence.
 *
 * What these pin:
 *   1. The page fires on the physical fact — the car was on the block before the
 *      sweeper arrived — with no reminder anywhere in the row.
 *   2. It stays quiet for a valet who legally parked BEHIND the sweeper inside
 *      the window, which is a move done right and must not page every time.
 *   3. The old reason still pages: a reminder went out for this spot and the car
 *      is still on it.
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
    });

const BLOCK_A = { lat: 40.68016, lng: -73.99266, streetAddress: '336 President St' };
const MON_830 = [{ day: 1, startTime: '08:30', endTime: '10:00' }];

const makeSub = (user) =>
    Subscription.create({
        user: user._id,
        tier: 'home_garage',
        interval: 'month',
        status: 'active',
        amountCents: 25000,
        stripeSubscriptionId: `sub_swp_${++phoneSeq}`,
        currentPeriodStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        homeAddress: BLOCK_A,
    });

const makePark = (customer, valet, sub) =>
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
    });

const park = async (orderId, updates) => {
    const req = { body: { orderId: String(orderId), updates }, io: mockIo() };
    await orderController.updateOrder(req, mockRes());
};

/** A managed car, parked on BLOCK_A, with Monday 08:30-10:00 known and armed. */
const armedCarOnBlockA = async () => {
    const customer = await makeUser();
    const valet = await makeUser(true);
    const sub = await makeSub(customer);
    const order = await makePark(customer, valet, sub);
    await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });
    const note = await ParkingNote.create({
        order: order._id,
        valet: valet._id,
        location: BLOCK_A,
        signPhotoBucket: 'test-bucket',
        signPhotoStoragePath: `parking-notes/${order._id}/x.jpg`,
        streetCleaning: MON_830,
        sweepDataStatus: 'captured',
    });
    await curbCustody.enrichFromNote({ order: await Order.findById(order._id), note });
    return { customer, valet, order };
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
}, 30000);

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

describe('a sweep in progress under a car nobody moved', () => {
    test('pages even though no reminder was ever sent', async () => {
        const { customer } = await armedCarOnBlockA();

        const custodyBefore = await CurbCustody.findOne({ customer: customer._id });
        // The state the mover would have written. Nothing wrote it: this is a
        // car whose dispatch never happened.
        expect(custodyBefore.reminderSpotKey).toBeUndefined();
        expect(custodyBefore.reminderSentAt).toBeUndefined();

        // Fifteen minutes into the Monday sweep, with the car sitting where the
        // valet left it days earlier.
        const now = new Date(nextMonday830().getTime() + 15 * 60 * 1000);

        await dispatcher.watch({ now });

        const alert = await OpsAlert.findOne({ kind: 'sweep_in_progress' });
        expect(alert).toBeTruthy();
        expect(alert.severity).toBe('page');
        expect(alert.customer.toString()).toBe(customer._id.toString());
        expect(alert.detail).toContain(BLOCK_A.streetAddress);
        // Ops should be told which of the two it is, because the next action
        // differs: chase the valet, or find out why nothing dispatched.
        expect(alert.detail).toMatch(/Nobody was ever asked/i);
    });

    test('stays quiet for a valet who parked behind the sweeper inside the window', async () => {
        const { customer } = await armedCarOnBlockA();

        const at = nextMonday830();
        const now = new Date(at.getTime() + 45 * 60 * 1000);

        // The move happened: the car arrived on this spot after the sweeper had
        // already passed. Paging here would page on every correct move.
        const custody = await CurbCustody.findOne({ customer: customer._id });
        custody.spotSince = new Date(at.getTime() + 20 * 60 * 1000);
        await custody.save();

        await dispatcher.watch({ now });

        expect(await OpsAlert.countDocuments({ kind: 'sweep_in_progress' })).toBe(0);
        expect(await OpsAlert.countDocuments({ kind: 'car_did_not_move' })).toBe(0);
    });

    test('still pages when the reminder went out for this spot and the car never left', async () => {
        const { customer } = await armedCarOnBlockA();

        const at = nextMonday830();
        const now = new Date(at.getTime() + 15 * 60 * 1000);

        const custody = await CurbCustody.findOne({ customer: customer._id });
        custody.reminderSpotKey = custody.spot.tileKey;
        custody.reminderSentAt = new Date(at.getTime() - 45 * 60 * 1000);
        await custody.save();

        await dispatcher.watch({ now });

        const alert = await OpsAlert.findOne({ kind: 'sweep_in_progress' });
        expect(alert).toBeTruthy();
        expect(alert.detail).toMatch(/We asked for a move/i);
    });
});
