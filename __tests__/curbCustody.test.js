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
    // The unique partial index on {currentOrder} is the guarantee that one car
    // cannot open two custody rows, and indexes are not built automatically in
    // these suites.
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
    // The suspension cache lives at module scope for five minutes, so a row
    // seeded in the next test would otherwise read as absent.
    aspSuspensions.invalidate();
    jest.restoreAllMocks();
});

describe('opening custody', () => {
    test('a flat-plan park opens custody at the block the valet chose', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub);

        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });

        const custody = await CurbCustody.findOne({ customer: customer._id });
        expect(custody).toBeTruthy();
        expect(custody.tier).toBe('home_garage');
        expect(custody.spot.streetAddress).toBe(BLOCK_A.streetAddress);
        expect(custody.spot.tileKey).toBe(sweepWindows.tileKeyOf(BLOCK_A));
        expect(custody.state).toBe('resolving');
        // The safe side. We do not have the keys unless somebody recorded that
        // we do, and assuming otherwise sends a valet to a locked car.
        expect(custody.keysWith).toBe('customer');
        expect(custody.spots).toHaveLength(1);
    });

    test('street_cleaning is never managed — that plan runs on days the customer typed', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer, 'street_cleaning');
        const order = await makePark(customer, valet, sub);

        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });

        expect(await CurbCustody.countDocuments({})).toBe(0);
    });

    test('an enterprise park is the front desk’s custody, not ours', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub, {
            endCustomerName: 'Room 402',
        });

        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });

        expect(await CurbCustody.countDocuments({})).toBe(0);
    });

    test('an uncovered park opens nothing', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub, {
            coveredBySubscription: undefined,
        });

        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });

        expect(await CurbCustody.countDocuments({})).toBe(0);
    });
});

describe('reading the block', () => {
    test('the window comes off the valet’s own note at this spot', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub);
        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });

        const note = await makeNote(order, valet, BLOCK_A, MON_830, {
            sweepDataStatus: 'captured',
        });
        const fresh = await Order.findById(order._id);
        await curbCustody.enrichFromNote({ order: fresh, note });

        const custody = await CurbCustody.findOne({ customer: customer._id });
        expect(custody.state).toBe('armed');
        expect(custody.rules.source).toBe('note');
        expect(custody.rules.windows).toHaveLength(1);
        expect(custody.rules.windows[0]).toMatchObject({ weekday: 1, hour: 8, minute: 30 });
        expect(custody.spots[0].windows).toHaveLength(1);
    });

    test('a note taken at a different block is ignored, because it describes somewhere else', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub);
        await park(order._id, { status: 'parked', parkingLocation: BLOCK_B });

        // ParkingNote is upserted one row per ORDER, so after a move the note
        // still exists and still says block A. Nothing but the distance check
        // can tell that it is now wrong.
        const note = await makeNote(order, valet, BLOCK_A, MON_830);
        const fresh = await Order.findById(order._id);
        await curbCustody.enrichFromNote({ order: fresh, note });

        const custody = await CurbCustody.findOne({ customer: customer._id });
        expect(custody.rules.source).toBe('unknown');
        expect(custody.state).toBe('blind');
    });

    test('falls back to another valet’s note on the same block', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const other = await makeUser(true);
        const sub = await makeSub(customer);

        // Somebody else's note, on the same block face, a few metres away.
        const otherOrder = await makePark(customer, other, sub);
        await makeNote(otherOrder, other, { ...BLOCK_A, lat: BLOCK_A.lat + 0.0002 }, THU_1130);

        const order = await makePark(customer, valet, sub);
        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });
        const fresh = await Order.findById(order._id);
        await curbCustody.enrichFromNote({ order: fresh, note: null });

        const custody = await CurbCustody.findOne({ currentOrder: order._id });
        expect(custody.rules.source).toBe('block');
        expect(custody.rules.windows[0]).toMatchObject({ weekday: 4, hour: 11, minute: 30 });
    });

    test('a valet saying there is no sweep here silences it; a legacy empty array does not', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);

        const said = await makePark(customer, valet, sub);
        await park(said._id, { status: 'parked', parkingLocation: BLOCK_A });
        const saidNote = await makeNote(said, valet, BLOCK_A, [], {
            sweepDataStatus: 'none_on_sign',
        });
        await curbCustody.enrichFromNote({
            order: await Order.findById(said._id),
            note: saidNote,
        });
        const armed = await CurbCustody.findOne({ currentOrder: said._id });
        expect(armed.rules.source).toBe('none_on_sign');
        expect(armed.state).toBe('armed');

        // The same empty array WITHOUT the valet having said so is ambiguous —
        // it means both "no cleaning here" and "I skipped it" — and must stay
        // unknown forever rather than being read as a green light.
        const legacy = await makePark(customer, valet, sub);
        await park(legacy._id, { status: 'parked', parkingLocation: BLOCK_B });
        const legacyNote = await makeNote(legacy, valet, BLOCK_B, []);
        await curbCustody.enrichFromNote({
            order: await Order.findById(legacy._id),
            note: legacyNote,
        });
        const blind = await CurbCustody.findOne({ currentOrder: legacy._id });
        expect(blind.rules.source).toBe('unknown');
        expect(blind.state).toBe('blind');
    });
});

describe('the re-park loop', () => {
    test('a move re-arms on the new block and keeps the old one in the history', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub);

        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });
        const note = await makeNote(order, valet, BLOCK_A, MON_830, {
            sweepDataStatus: 'captured',
        });
        await curbCustody.enrichFromNote({ order: await Order.findById(order._id), note });

        let custody = await CurbCustody.findOne({ currentOrder: order._id });
        expect(custody.state).toBe('armed');

        // The move. The valet app sends parkingLocation alone, with no status.
        await park(order._id, { parkingLocation: BLOCK_B });

        custody = await CurbCustody.findOne({ currentOrder: order._id });
        expect(custody.spot.streetAddress).toBe(BLOCK_B.streetAddress);
        expect(custody.spots).toHaveLength(2);
        expect(custody.spots[0].departedAt).toBeTruthy();
        // The old block's rules must NOT survive the move. Dispatching against
        // the block the car has left is the precise failure this prevents.
        expect(custody.rules.source).toBe('unknown');
        // 'resolving' rather than 'blind': we have not FAILED to read the new
        // block, we have not tried yet. The valet is still walking to the sign.
        // The dispatcher retries a resolving row every tick and only then does
        // it become blind, which is what the alarm fires on.
        expect(custody.state).toBe('resolving');

        // And the new block's sign re-arms it. This is the recursion.
        await ParkingNote.updateOne(
            { order: order._id },
            { $set: { location: BLOCK_B, streetCleaning: THU_1130, sweepDataStatus: 'captured' } }
        );
        const moved = await ParkingNote.findOne({ order: order._id });
        await curbCustody.enrichFromNote({ order: await Order.findById(order._id), note: moved });

        custody = await CurbCustody.findOne({ currentOrder: order._id });
        expect(custody.state).toBe('armed');
        expect(custody.rules.windows[0]).toMatchObject({ weekday: 4, hour: 11, minute: 30 });
        expect(custody.spots).toHaveLength(2);
    });

    test('a move of only a few metres is the same spot, not a new one', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub);

        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });
        await park(order._id, {
            parkingLocation: { ...BLOCK_A, lat: BLOCK_A.lat + 0.00002 },
        });

        const custody = await CurbCustody.findOne({ currentOrder: order._id });
        expect(custody.spots).toHaveLength(1);
    });
});

describe('ending custody', () => {
    test('a real retrieval ends it', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub);
        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });

        const retrieval = await Order.create({
            customer: customer._id,
            valet: valet._id,
            customerLocation: BLOCK_A,
            parkingLocation: BLOCK_A,
            parkingType: 'retrieval',
            orderType: 'retrieval',
            duration: 30,
            pickUpTime: new Date(),
            status: 'in_progress',
            totalAmount: 500,
            paymentMethod: 'card',
            paymentStatus: 'paid',
            linkedOrderId: order._id,
            vehicle: { color: 'Black', model: 'Civic', licensePlate: 'ABC1234' },
        });

        await park(retrieval._id, { status: 'completed' });

        const custody = await CurbCustody.findOne({ customer: customer._id });
        expect(custody.closedAt).toBeTruthy();
        expect(custody.closeReason).toBe('retrieved');
        expect(custody.state).toBe('closed');
    });

    test('a sweep’s return leg does NOT end it — the car is still on the street', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub);
        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });

        // Identical shape to a customer retrieval at the call site. The only
        // difference is that the customer is not taking the car anywhere.
        const leg = await Order.create({
            customer: customer._id,
            valet: valet._id,
            customerLocation: BLOCK_A,
            parkingLocation: BLOCK_B,
            parkingType: 'retrieval',
            orderType: 'retrieval',
            duration: 30,
            pickUpTime: new Date(),
            status: 'in_progress',
            totalAmount: 0,
            paymentMethod: 'card',
            paymentStatus: 'paid',
            aspMode: true,
            autoBookKey: `aspreturn:${order._id}`,
            linkedOrderId: order._id,
            coveredBySubscription: sub._id,
            vehicle: { color: 'Black', model: 'Civic', licensePlate: 'ABC1234' },
        });

        await park(leg._id, { status: 'completed' });

        const custody = await CurbCustody.findOne({ customer: customer._id });
        expect(custody.closedAt).toBeFalsy();
        // And it followed the car onto the block the return leg left it on.
        expect(custody.spot.streetAddress).toBe(BLOCK_B.streetAddress);
    });

    test('parkClosedAt is not an ending — the keys go back every park', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub, {
            'otpVerifiedTimes.returnKey': new Date(),
        });
        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });
        await park(order._id, { status: 'parked', parkClosed: true });

        const custody = await CurbCustody.findOne({ customer: customer._id });
        expect(custody.closedAt).toBeFalsy();
    });
});

describe('dispatching the move', () => {
    const armCar = async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub);
        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });
        const note = await makeNote(order, valet, BLOCK_A, MON_830, {
            sweepDataStatus: 'captured',
        });
        await curbCustody.enrichFromNote({ order: await Order.findById(order._id), note });
        return { customer, valet, sub, order };
    };

    test('books a $0 move from where the car is, 45 minutes before the sweep', async () => {
        const { customer, sub } = await armCar();
        const sweep = nextMonday830();
        const now = new Date(sweep.getTime() - 30 * 60 * 1000);

        const notify = jest.fn().mockResolvedValue();
        const results = await dispatcher.tick({ now, io: mockIo(), notify });

        expect(results.filter((r) => r.outcome === 'booked')).toHaveLength(1);
        const move = await Order.findOne({ aspMode: true, status: 'pending' });
        expect(move).toBeTruthy();
        expect(move.totalAmount).toBe(0);
        expect(move.paymentStatus).toBe('paid');
        // From the block the car is actually on, never from an address the
        // customer typed — on these plans they typed none.
        expect(move.customerLocation.streetAddress).toBe(BLOCK_A.streetAddress);
        expect(move.autoBookKey).toContain(`asp:${sub._id}:`);
        expect(notify).toHaveBeenCalledTimes(1);

        const custody = await CurbCustody.findOne({ customer: customer._id });
        expect(custody.movesThisPeriod).toBe(1);
        // Custody hopped onto the move rather than closing with the old order.
        expect(String(custody.currentOrder)).toBe(String(move._id));
    });

    test('a second tick books nothing — the database refuses the duplicate', async () => {
        await armCar();
        const sweep = nextMonday830();
        const now = new Date(sweep.getTime() - 30 * 60 * 1000);
        const notify = jest.fn().mockResolvedValue();

        await dispatcher.tick({ now, io: mockIo(), notify });
        const second = await dispatcher.tick({ now, io: mockIo(), notify });

        expect(second.filter((r) => r.outcome === 'booked')).toHaveLength(0);
        expect(await Order.countDocuments({ aspMode: true, status: 'pending' })).toBe(1);
    });

    test('does nothing outside the firing window', async () => {
        await armCar();
        const sweep = nextMonday830();
        const results = await dispatcher.tick({
            now: new Date(sweep.getTime() - 5 * 60 * 60 * 1000),
            io: mockIo(),
            notify: jest.fn(),
        });
        expect(results).toHaveLength(0);
        expect(await Order.countDocuments({ aspMode: true })).toBe(0);
    });

    test('never moves a car on a day the city suspended cleaning', async () => {
        await armCar();
        const sweep = nextMonday830();
        const now = new Date(sweep.getTime() - 30 * 60 * 1000);

        const { nyDateKey } = require('../services/nyTime');
        await AspSuspension.create({
            date: nyDateKey(sweep),
            reason: 'Snow emergency',
            source: 'manual',
            year: sweep.getUTCFullYear(),
        });
        aspSuspensions.invalidate();

        const results = await dispatcher.tick({ now, io: mockIo(), notify: jest.fn() });
        expect(results.filter((r) => r.outcome === 'suspended')).toHaveLength(1);
        expect(await Order.countDocuments({ aspMode: true })).toBe(0);
    });

    test('a database blip on the suspension calendar books the move rather than skipping it', async () => {
        await armCar();
        const sweep = nextMonday830();
        const now = new Date(sweep.getTime() - 30 * 60 * 1000);

        // The fail direction is a product decision: booking needlessly costs one
        // valet fee, skipping wrongly costs a $65 ticket we have said we eat.
        jest.spyOn(AspSuspension, 'find').mockImplementation(() => {
            throw new Error('mongo is down');
        });
        aspSuspensions.invalidate();

        const results = await dispatcher.tick({ now, io: mockIo(), notify: jest.fn() });
        expect(results.filter((r) => r.outcome === 'booked')).toHaveLength(1);
    });

    test('a blind car is never dispatched on', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub);
        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });

        const results = await dispatcher.tick({
            now: new Date(nextMonday830().getTime() - 30 * 60 * 1000),
            io: mockIo(),
            notify: jest.fn(),
        });
        expect(results.filter((r) => r.outcome === 'booked')).toHaveLength(0);
    });
});

describe('the alarm', () => {
    test('a block we cannot read raises an alert instead of continuing quietly', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub);
        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });

        await dispatcher.watch({ now: new Date() });

        const alert = await OpsAlert.findOne({ kind: 'no_rules_for_block' });
        expect(alert).toBeTruthy();
        expect(alert.customer.toString()).toBe(customer._id.toString());
        expect(alert.detail).toContain(BLOCK_A.streetAddress);
    });

    test('the same blind car does not alarm twice in one day', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub);
        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });

        await dispatcher.watch({ now: new Date() });
        await dispatcher.watch({ now: new Date() });

        expect(await OpsAlert.countDocuments({ kind: 'no_rules_for_block' })).toBe(1);
    });

    test('an armed car does not alarm at all', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub);
        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });
        const note = await makeNote(order, valet, BLOCK_A, MON_830, {
            sweepDataStatus: 'captured',
        });
        await curbCustody.enrichFromNote({ order: await Order.findById(order._id), note });

        await dispatcher.watch({ now: new Date() });

        expect(await OpsAlert.countDocuments({ kind: 'no_rules_for_block' })).toBe(0);
    });

    test('a car we are holding with no record at all gets one, and says so', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        // Parked before this feature shipped: the row was never opened.
        const order = await makePark(customer, valet, sub, {
            status: 'parked',
            parkingLocation: BLOCK_A,
            parkedAt: new Date(),
        });
        expect(await CurbCustody.countDocuments({})).toBe(0);

        await curbCustody.reconcile({ now: new Date() });

        const custody = await CurbCustody.findOne({ currentOrder: order._id });
        expect(custody).toBeTruthy();
        expect(await OpsAlert.countDocuments({ kind: 'custody_backfilled' })).toBe(1);
    });

    test('a record pointing at the wrong block is corrected and paged', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub);
        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });

        // The car moved without the hook firing — a swallowed throw, or a deploy
        // gap. Left alone, the next sweep sends a valet to an empty space.
        await Order.updateOne({ _id: order._id }, { $set: { parkingLocation: BLOCK_B } });

        await curbCustody.reconcile({ now: new Date() });

        const custody = await CurbCustody.findOne({ currentOrder: order._id });
        expect(custody.spot.streetAddress).toBe(BLOCK_B.streetAddress);
        const alert = await OpsAlert.findOne({ kind: 'custody_spot_drifted' });
        expect(alert).toBeTruthy();
        expect(alert.severity).toBe('page');
    });
});
