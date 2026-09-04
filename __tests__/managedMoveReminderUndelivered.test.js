/**
 * The sweep reminder on a car we hold the keys to has to actually arrive.
 * Run: npx jest managedMoveReminderUndelivered
 *
 * On the $250 and $300 plans the valet keeps the keys, so a street-cleaning
 * move is a PUSH AND NOTHING ELSE. No order is minted, so the job appears on
 * nobody's board, the unclaimed watchdog has no row to find, and no second valet
 * can pick it up. The push is the entire dispatch.
 *
 * That made two silences expensive:
 *
 *  1. sendPushNotification RETURNS {success:false} when a valet has no live FCM
 *     token — a reinstall, a logout, or a token the sender itself retired after
 *     an earlier failure. The dispatcher threw that value away, stamped the
 *     occurrence as reminded, and never tried again. Nobody was told to move the
 *     car and nobody knew nobody had been told.
 *  2. Between the reminder at T-45 and the sweeper arriving at T-0, nothing in
 *     the system asked whether the car had moved. The first alarm was
 *     sweep_in_progress, raised while the ticket was being written.
 *
 * Both end the same way: a $65 Brooklyn ticket the company eats, on the plan
 * bought to prevent exactly that.
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../models/Order');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const ParkingNote = require('../models/ParkingNote');
const CurbCustody = require('../models/CurbCustody');
const OpsAlert = require('../models/OpsAlert');

const curbCustody = require('../services/curbCustody');
const dispatcher = require('../services/curbSweepDispatcher');
const sweepWindows = require('../services/sweepWindows');
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

const mockIo = () => {
    const emits = [];
    return {
        emits,
        emit: (event, payload) => emits.push({ room: null, event, payload }),
        to: (room) => ({ emit: (event, payload) => emits.push({ room, event, payload }) }),
    };
};

let phoneSeq = 5594000000;
const makeUser = (isValet = false) =>
    User.create({
        firstName: isValet ? 'Val' : 'Cust',
        lastName: 'Tester',
        email: `u${new mongoose.Types.ObjectId()}@example.com`,
        phone: String(++phoneSeq),
        verified: true,
        isValet,
        // The push is aimed by firebaseUid, so a valet without one is a valet
        // this dispatcher cannot reach at all.
        firebaseUid: `fb_${new mongoose.Types.ObjectId()}`,
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
        stripeSubscriptionId: `sub_undeliv_${++phoneSeq}`,
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

const nextMonday830 = (from = new Date()) =>
    sweepWindows.nextSweep(sweepWindows.toSweepWindows(MON_830).windows, from).at;

/** A managed car, parked, sign read, keys in the valet's pocket. */
const armCar = async () => {
    const customer = await makeUser();
    const valet = await makeUser(true);
    const sub = await makeSub(customer);
    const order = await makePark(customer, valet, sub);

    const req = {
        body: {
            orderId: String(order._id),
            updates: { status: 'parked', parkingLocation: BLOCK_A },
        },
        io: mockIo(),
    };
    await orderController.updateOrder(req, mockRes());

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

    const custody = await CurbCustody.findOne({ currentOrder: order._id });
    expect(custody.keysWith).toBe('valet');
    return { customer, valet, sub, order, custody };
};

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    // The dedupe on both of these is a unique index, not application logic, and
    // indexes are not built automatically in these suites.
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
        CurbCustody.deleteMany({}),
        OpsAlert.deleteMany({}),
    ]);
    jest.restoreAllMocks();
}, 30000);

describe('a reminder that never reached the valet', () => {
    test('is not recorded as sent, pages a human, and is tried again', async () => {
        const { order } = await armCar();
        const sweep = nextMonday830();
        const now = new Date(sweep.getTime() - 30 * 60 * 1000);

        // Exactly what a valet with no live token gets back today: a resolved
        // promise saying nothing was delivered. It does not throw.
        const push = jest
            .spyOn(notificationController, 'sendPushNotification')
            .mockResolvedValue({ success: false, message: 'No valid FCM tokens found' });

        const results = await dispatcher.tick({ now, io: mockIo(), notify: jest.fn() });

        expect(push).toHaveBeenCalledTimes(1);
        expect(results.filter((r) => r.outcome === 'reminded')).toHaveLength(0);
        expect(results.filter((r) => r.outcome === 'reminder_undelivered')).toHaveLength(1);

        // A human is paged while there is still time to phone the valet.
        const alert = await OpsAlert.findOne({ kind: 'move_reminder_undelivered' });
        expect(alert).toBeTruthy();
        expect(alert.severity).toBe('page');
        expect(alert.detail).toContain(BLOCK_A.streetAddress);

        const after = await CurbCustody.findOne({ currentOrder: order._id });
        // The occurrence key is the "do not say it twice" gate. Stamping it on a
        // failure retires the one attempt this car ever gets.
        expect(after.lastMoveReminderKey).toBeFalsy();
        // The spot snapshot IS stamped, so the in-progress alarm still fires if
        // this car ends up sitting through the sweep.
        expect(after.reminderSpotKey).toBe(sweepWindows.tileKeyOf(BLOCK_A));

        // The valet reopens the app; the very next tick reaches him.
        push.mockResolvedValue({ success: true, successCount: 1 });
        const second = await dispatcher.tick({
            now: new Date(now.getTime() + 60 * 1000),
            io: mockIo(),
            notify: jest.fn(),
        });
        expect(second.filter((r) => r.outcome === 'reminded')).toHaveLength(1);

        const finally_ = await CurbCustody.findOne({ currentOrder: order._id });
        expect(finally_.lastMoveReminderKey).toBeTruthy();
    }, 30000);

    test('one page per car per day, however many times the tick retries', async () => {
        await armCar();
        const sweep = nextMonday830();
        const now = new Date(sweep.getTime() - 30 * 60 * 1000);

        jest.spyOn(notificationController, 'sendPushNotification')
            .mockResolvedValue({ success: false, message: 'No valid FCM tokens found' });

        await dispatcher.tick({ now, io: mockIo(), notify: jest.fn() });
        await dispatcher.tick({
            now: new Date(now.getTime() + 60 * 1000),
            io: mockIo(),
            notify: jest.fn(),
        });
        await dispatcher.tick({
            now: new Date(now.getTime() + 120 * 1000),
            io: mockIo(),
            notify: jest.fn(),
        });

        expect(await OpsAlert.countDocuments({ kind: 'move_reminder_undelivered' })).toBe(1);
    }, 30000);
});

describe('the reminder that does arrive', () => {
    test('carries a destination the shipped valet app can open', async () => {
        await armCar();
        const sweep = nextMonday830();
        const push = jest
            .spyOn(notificationController, 'sendPushNotification')
            .mockResolvedValue({ success: true, successCount: 1 });

        await dispatcher.tick({
            now: new Date(sweep.getTime() - 30 * 60 * 1000),
            io: mockIo(),
            notify: jest.fn(),
        });

        const data = push.mock.calls[0][3];
        // Without a screen_name the app's notification handler returns
        // immediately: tapping the banner opens the app and goes nowhere, and a
        // valet who swipes it away has no in-app record of which car to move.
        // The park is stamped parkClosedAt the moment he keeps the keys, so it
        // is off the valet job board — My Keys is the screen that still lists it.
        expect(data.screen_name).toBe('KeyTransferScreen');
        expect(data.type).toBe('MANAGED_MOVE_REMINDER');
    }, 30000);
});

describe('the gap between the reminder and the sweeper', () => {
    test('a car still on the block just before the sweep pages before the ticket, not after', async () => {
        await armCar();
        const sweep = nextMonday830();

        jest.spyOn(notificationController, 'sendPushNotification')
            .mockResolvedValue({ success: true, successCount: 1 });
        await dispatcher.tick({
            now: new Date(sweep.getTime() - 30 * 60 * 1000),
            io: mockIo(),
            notify: jest.fn(),
        });

        // T-8. The valet was told 22 minutes ago, the car has not left the tile,
        // and there is no order for the unclaimed watchdog to find because this
        // path never books one.
        await dispatcher.watch({ now: new Date(sweep.getTime() - 8 * 60 * 1000) });

        const alert = await OpsAlert.findOne({ kind: 'move_not_made' });
        expect(alert).toBeTruthy();
        expect(alert.severity).toBe('page');
        // Raised BEFORE the sweep, so this is not the in-progress alarm wearing
        // a different name.
        expect(await OpsAlert.countDocuments({ kind: 'sweep_in_progress' })).toBe(0);
    }, 30000);

    test('a valet still walking half an hour out is not paged about', async () => {
        await armCar();
        const sweep = nextMonday830();

        jest.spyOn(notificationController, 'sendPushNotification')
            .mockResolvedValue({ success: true, successCount: 1 });
        await dispatcher.tick({
            now: new Date(sweep.getTime() - 30 * 60 * 1000),
            io: mockIo(),
            notify: jest.fn(),
        });

        // T-25. A run is several cars spaced minutes apart; paging here would
        // page on an ordinary Monday until nobody read these any more.
        await dispatcher.watch({ now: new Date(sweep.getTime() - 25 * 60 * 1000) });

        expect(await OpsAlert.countDocuments({ kind: 'move_not_made' })).toBe(0);
    }, 30000);
});
