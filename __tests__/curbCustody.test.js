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
        // The park is what puts the keys in our hands, and on these plans they
        // stay there. Handing them back after every park was too much friction
        // and, worse, meant the car could not be moved before its sweep without
        // the customer standing at the curb twice per cleaning.
        expect(custody.keysWith).toBe('valet');
        expect(String(custody.keyHolder)).toBe(String(valet._id));
        expect(custody.keyHandoffs).toHaveLength(1);
        expect(custody.keyHandoffs[0].direction).toBe('to_valet');
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

    // The second park of a day. The plan pays for one, so this one is CHARGED
    // — but on a flat tier it still has no end time, and the customer is told
    // so in the server's own words. Keying custody on coverage left exactly
    // this car with no row: nobody read its block, nothing moved it before the
    // sweep, and the watchdog had no row to alarm on.
    test('a charged park that still has no end time is ours to hold', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub, {
            coveredBySubscription: undefined,
            indefinite: true,
            totalAmount: 1000,
        });

        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });

        const custody = await CurbCustody.findOne({ customer: customer._id });
        expect(custody).toBeTruthy();
        expect(custody.tier).toBe('home_garage');
        // And the keys stay with us, exactly as on a covered park — otherwise
        // the valet's push says "keep the keys" while their app asks them to
        // hand them back.
        expect(custody.keysWith).toBe('valet');
        const saved = await Order.findById(order._id).lean();
        expect(saved.keysStayWithValet).toBe(true);
    });

    test('no end time on a per-use customer opens nothing — there is no plan behind it', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer, 'street_cleaning');
        const order = await makePark(customer, valet, sub, {
            coveredBySubscription: undefined,
            indefinite: true,
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
    /**
     * @param keysWith 'valet' is the steady state on these plans and takes the
     *   PUSH path — no order, just the valet who already has the keys. Passing
     *   'customer' exercises the booked two-beat move, which is what a sweep
     *   costs once somebody has asked for their keys back.
     */
    const armCar = async (keysWith = 'valet') => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub);
        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });
        const note = await makeNote(order, valet, BLOCK_A, MON_830, {
            sweepDataStatus: 'captured',
        });
        await curbCustody.enrichFromNote({ order: await Order.findById(order._id), note });
        if (keysWith === 'customer') {
            const custody = await CurbCustody.findOne({ currentOrder: order._id });
            await curbCustody.giveKeysBack({ custody, order });
        }
        return { customer, valet, sub, order };
    };

    test('books a $0 move from where the car is, 45 minutes before the sweep', async () => {
        const { customer, sub } = await armCar('customer');
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
        await armCar('customer');
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
        await armCar('customer');
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
        await armCar('customer');
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

/**
 * Who holds the keys, and what that costs in handoffs.
 *
 * On the $250/$300 plans the valet keeps the keys after every park. That is the
 * only arrangement under which a car can be moved before its block is swept
 * without the customer being present for it — which is the whole product. The
 * price of keeping somebody's keys is that they can have them back in one tap,
 * and every one of those handoffs has to verify in the right direction:
 *
 *   valet RECEIVING keys/car  ->  the VALET says the code, the customer types it
 *   valet HANDING keys/car    ->  the CUSTOMER says it, the valet verifies
 */
describe('key custody', () => {
    const parkedManagedCar = async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub);
        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });
        return { customer, valet, sub, order };
    };

    test('a park hands us the keys and records who has them', async () => {
        const { customer, valet } = await parkedManagedCar();
        const custody = await CurbCustody.findOne({ customer: customer._id });
        expect(custody.keysWith).toBe('valet');
        expect(String(custody.keyHolder)).toBe(String(valet._id));
    });

    test('the park itself carries the key decision, so the phone need not ask', async () => {
        // The valet app decides whether to offer a return-key handoff the moment
        // it opens the job. It cannot run a custody lookup to find out, and a
        // job that waits for a handoff nobody will walk never leaves the screen.
        const { order, customer } = await parkedManagedCar();
        let parked = await Order.findById(order._id).lean();
        expect(parked.keysStayWithValet).toBe(true);

        const custody = await CurbCustody.findOne({ customer: customer._id });
        await curbCustody.giveKeysBack({ custody, order });
        parked = await Order.findById(order._id).lean();
        expect(parked.keysStayWithValet).toBe(false);
    });

    test('a key delivery is custody from birth, so the customer READS the code', async () => {
        // The shared handoffWindow — the app copy and the doorman page's twin —
        // reads a retrieval as beat 1 until custody is true. A key delivery has
        // no pickup stamp, because nothing was ever collected, so without this
        // it would hand the customer a keypad for a code they should read aloud.
        const { customer } = await parkedManagedCar();
        await custodyController.requestKeys(
            { body: { userId: String(customer._id) }, io: mockIo() },
            mockRes()
        );
        const delivery = await Order.findOne({ keyDeliveryOnly: true }).lean();
        expect(await orderController.retrievalHasCustody(delivery)).toBe(true);
    });

    test('no key-return code is shown while the keys are staying with us', async () => {
        // updateCarLocation mints a return-key code at EVERY park. Between the
        // valet saving the spot and swiping the job closed, handoffWindow would
        // otherwise print that number and tell the customer to read it out for
        // a handoff nobody is walking to. Both copies — this one and the app's
        // — carry the same guard.
        const share = require('../controllers/shareController');
        const { order } = await parkedManagedCar();
        const parked = await Order.findById(order._id);
        parked.otp = {
            code: '123456',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 3600e3),
            verified: false,
            type: 'return_key',
        };
        parked.parkClosedAt = undefined;
        await parked.save();

        const w = await share.handoffWindow(await Order.findById(order._id).lean());
        expect(w.beat).toBeNull();
        expect(w.code).toBeNull();
        expect(w.reason).toBe('valet_keeps_the_keys');
    });

    test('the valet closes out without ever handing the keys back', async () => {
        // The shape-match close-out requires `otpVerifiedTimes.returnKey`, which
        // on these plans never happens — nobody walks the keys back. Without a
        // separate path the job would sit on the valet's screen forever.
        const { order } = await parkedManagedCar();
        await park(order._id, { status: 'parked' });
        const closed = await Order.findById(order._id).lean();
        expect(closed.parkClosedAt).toBeTruthy();
        expect(closed.otpVerifiedTimes && closed.otpVerifiedTimes.returnKey).toBeFalsy();
    });

    test('a "Just park" on a managed plan still closes out — keys are the test, not serviceType', async () => {
        // Custody arms on ANY covered park; `classify` never looks at serviceType.
        // So this customer's keys are taken exactly as they would be on a Park &
        // Retrieve. Requiring park-and-hold at close-out left the order stuck at
        // `parked` forever: never off the valet's screen, and on the customer's
        // side a ticket whose only action was a handoff nobody was walking to.
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer);
        const order = await makePark(customer, valet, sub, { serviceType: 'standard' });
        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });
        expect(await curbCustody.weHoldTheKeys(customer._id)).toBe(true);

        await park(order._id, { status: 'parked' });
        const closed = await Order.findById(order._id).lean();
        expect(closed.parkClosedAt).toBeTruthy();
    });

    test('street_cleaning keeps its key return — we never hold those', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const sub = await makeSub(customer, 'street_cleaning');
        const order = await makePark(customer, valet, sub);
        await park(order._id, { status: 'parked', parkingLocation: BLOCK_A });
        await park(order._id, { status: 'parked' });
        const closed = await Order.findById(order._id).lean();
        // No custody, so no keys-stay close-out: this park still waits for the
        // key handoff exactly as it always did.
        expect(await CurbCustody.countDocuments({})).toBe(0);
        expect(closed.parkClosedAt).toBeFalsy();
    });

    test('a retrieval while we hold the keys is ONE handoff, not two', async () => {
        const { customer } = await parkedManagedCar();
        expect(await curbCustody.weHoldTheKeys(customer._id)).toBe(true);

        const retrieval = await Order.create({
            customer: customer._id,
            customerLocation: BLOCK_A,
            parkingLocation: BLOCK_A,
            parkingType: 'retrieval',
            orderType: 'retrieval',
            duration: 30,
            pickUpTime: new Date(),
            status: 'accepted',
            totalAmount: 0,
            paymentMethod: 'card',
            paymentStatus: 'paid',
            bornInCustody: await curbCustody.weHoldTheKeys(customer._id),
            vehicle: { color: 'Black', model: 'Civic', licensePlate: 'ABC1234' },
        });
        // Born in custody means there is no beat 1 to be between — the valet
        // walks to the car, not to the customer. So the single code must not be
        // re-minted into a second one halfway through.
        expect(orderController.retrievalBornInCustody(retrieval)).toBe(true);
    });

    test('a retrieval once the customer has their keys back is TWO handoffs', async () => {
        const { customer, order } = await parkedManagedCar();
        const custody = await CurbCustody.findOne({ customer: customer._id });
        await curbCustody.giveKeysBack({ custody, order });
        expect(await curbCustody.weHoldTheKeys(customer._id)).toBe(false);

        const retrieval = await Order.create({
            customer: customer._id,
            customerLocation: BLOCK_A,
            parkingType: 'retrieval',
            orderType: 'retrieval',
            duration: 30,
            pickUpTime: new Date(),
            status: 'accepted',
            totalAmount: 500,
            paymentMethod: 'card',
            paymentStatus: 'paid',
            bornInCustody: await curbCustody.weHoldTheKeys(customer._id),
            vehicle: { color: 'Black', model: 'Civic', licensePlate: 'ABC1234' },
        });
        expect(orderController.retrievalBornInCustody(retrieval)).toBe(false);
    });

    test('asking for the keys back mints a keys-only job the car never moves for', async () => {
        const { customer, valet } = await parkedManagedCar();
        const req = { body: { userId: String(customer._id) }, io: mockIo() };
        const res = mockRes();
        await custodyController.requestKeys(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        const delivery = await Order.findOne({ keyDeliveryOnly: true });
        expect(delivery).toBeTruthy();
        expect(delivery.orderType).toBe('retrieval');
        expect(delivery.totalAmount).toBe(0); // handing back keys we chose to keep is not billable
        // The CUSTOMER reads this one out — the valet is handing something over.
        expect(delivery.otp.type).toBe('return_key');
        // One handoff, so no second code is ever minted.
        expect(orderController.retrievalBornInCustody(delivery)).toBe(true);

        const custody = await CurbCustody.findOne({ customer: customer._id });
        expect(custody.keyRequest.requestedAt).toBeTruthy();
        expect(custody.keysWith).toBe('valet'); // still ours until it is actually handed over
        expect(String(custody.keyHolder)).toBe(String(valet._id));
    });

    test('a second key request is refused rather than dispatching two valets', async () => {
        const { customer } = await parkedManagedCar();
        await custodyController.requestKeys(
            { body: { userId: String(customer._id) }, io: mockIo() },
            mockRes()
        );
        const res2 = mockRes();
        await custodyController.requestKeys(
            { body: { userId: String(customer._id) }, io: mockIo() },
            res2
        );
        expect(res2.statusCode).toBe(409);
        expect(await Order.countDocuments({ keyDeliveryOnly: true })).toBe(1);
    });

    test('the delivery completing hands the keys over and LEAVES the car managed', async () => {
        const { customer } = await parkedManagedCar();
        await custodyController.requestKeys(
            { body: { userId: String(customer._id) }, io: mockIo() },
            mockRes()
        );
        const delivery = await Order.findOne({ keyDeliveryOnly: true });
        await park(delivery._id, { status: 'completed' });

        const custody = await CurbCustody.findOne({ customer: customer._id });
        expect(custody.keysWith).toBe('customer');
        expect(custody.keyHolder).toBeFalsy();
        // The car never moved. Closing custody here would abandon a car we are
        // still being paid to move before every sweep.
        expect(custody.closedAt).toBeFalsy();
        expect(custody.keyHandoffs.map((h) => h.direction)).toEqual(['to_valet', 'to_customer']);

        // And the park it was linked to must NOT have been completed with it.
        const parkOrder = await Order.findById(custody.currentOrder).lean();
        expect(parkOrder.status).not.toBe('completed');
    });

    test('a sweep move BORROWS the keys and gives them straight back', async () => {
        const { customer, order } = await parkedManagedCar();
        const custody = await CurbCustody.findOne({ customer: customer._id });
        await curbCustody.giveKeysBack({ custody, order });

        // The move the dispatcher books for a customer-held car.
        const move = await Order.create({
            customer: customer._id,
            customerLocation: BLOCK_A,
            parkingType: 'street',
            orderType: 'parking',
            duration: 90,
            pickUpTime: new Date(),
            status: 'accepted',
            totalAmount: 0,
            paymentMethod: 'card',
            paymentStatus: 'paid',
            serviceType: 'park-and-hold',
            aspMode: true,
            keysBorrowed: true,
            coveredBySubscription: custody.subscription,
            vehicle: { color: 'Black', model: 'Civic', licensePlate: 'ABC1234' },
        });
        await park(move._id, { status: 'parked', parkingLocation: BLOCK_B });

        // Borrowing must not silently take them back. A street cleaning
        // happening on our schedule is not consent to keep somebody's keys.
        const after = await CurbCustody.findOne({ customer: customer._id });
        expect(after.keysWith).toBe('customer');
    });

    test('parking again after taking the keys back hands them over once more', async () => {
        const { customer, valet, sub, order } = await parkedManagedCar();
        const custody = await CurbCustody.findOne({ customer: customer._id });
        await curbCustody.giveKeysBack({ custody, order });
        expect(await curbCustody.weHoldTheKeys(customer._id)).toBe(false);

        const second = await makePark(customer, valet, sub);
        await park(second._id, { status: 'parked', parkingLocation: BLOCK_B });

        expect(await curbCustody.weHoldTheKeys(customer._id)).toBe(true);
    });

    test('we never claim keys for a customer we are not holding a car for', async () => {
        const stranger = await makeUser();
        expect(await curbCustody.weHoldTheKeys(stranger._id)).toBe(false);
        const res = mockRes();
        await custodyController.requestKeys(
            { body: { userId: String(stranger._id) }, io: mockIo() },
            res
        );
        expect(res.statusCode).toBe(409);
    });
});
