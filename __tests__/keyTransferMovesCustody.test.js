/**
 * A shift handover has to take the keys with it.
 * Run: npx jest keyTransferMovesCustody
 *
 * On the $250 and $300 plans WE hold the customer's keys, and two pushes are
 * aimed by name at whoever is holding them: the street-cleaning "move the car"
 * reminder (curbSweepDispatcher reads `custody.valet`) and the customer's
 * "give me my keys back" job (custodyController reads `custody.keyHolder`).
 * Both are snapshots taken at a park.
 *
 * `acceptTransfer` used to reassign `Order.valet` and stop there, so an end-of-
 * shift handover at 6pm left both snapshots pointing at the valet who had
 * handed the keys away. Next morning the block is swept, the push goes to a man
 * with no keys, the man with the keys is told nothing, and the car takes the
 * $65 ticket the plan exists to prevent.
 *
 * The end-to-end test is the one that matters — it asserts on who the
 * dispatcher actually pushes, not on a field name.
 */

jest.mock('firebase-admin', () => ({
    // keyTransferController requires firebase-admin at module load and the
    // notification path reaches for messaging(); a mock that answers neither
    // hangs this run instead of failing it.
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
            }),
            add: async () => {},
        }),
    }),
    apps: [{}],
    initializeApp: () => {},
    credential: { cert: () => ({}), applicationDefault: () => ({}) },
}));

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../models/Order');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const ParkingNote = require('../models/ParkingNote');
const CurbCustody = require('../models/CurbCustody');
const KeyTransfer = require('../models/KeyTransfer');
const OpsAlert = require('../models/OpsAlert');

const curbCustody = require('../services/curbCustody');
const dispatcher = require('../services/curbSweepDispatcher');
const sweepWindows = require('../services/sweepWindows');
const notificationController = require('../controllers/notificationController');
const keyTransferController = require('../controllers/keyTransferController');

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

let seq = 7731000000;
const makeUser = (isValet = false, firstName = 'Cust') =>
    User.create({
        firstName,
        lastName: 'Tester',
        email: `u${new mongoose.Types.ObjectId()}@example.com`,
        phone: String(++seq),
        firebaseUid: `uid_${seq}`,
        verified: true,
        isValet,
    });

const BLOCK_A = { lat: 40.68016, lng: -73.99266, streetAddress: '336 President St' };
// Monday 08:30-10:00, the shape production ParkingNotes actually carry.
const MON_830 = [{ day: 1, startTime: '08:30', endTime: '10:00' }];

const nextMonday830 = (from = new Date()) =>
    sweepWindows.nextSweep(sweepWindows.toSweepWindows(MON_830).windows, from).at;

/**
 * A managed car, parked and armed, with valet A holding the keys — the state
 * every one of these plans sits in overnight.
 */
const parkedManagedCar = async ({ keysWith = 'valet' } = {}) => {
    const customer = await makeUser();
    const valetA = await makeUser(true, 'Ada');
    const valetB = await makeUser(true, 'Bruno');

    const sub = await Subscription.create({
        user: customer._id,
        tier: 'home_garage',
        interval: 'month',
        status: 'active',
        amountCents: 25000,
        stripeSubscriptionId: `sub_kt_${++seq}`,
        currentPeriodStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        homeAddress: BLOCK_A,
    });

    const order = await Order.create({
        customer: customer._id,
        valet: valetA._id,
        customerLocation: BLOCK_A,
        parkingLocation: BLOCK_A,
        parkingType: 'street',
        orderType: 'parking',
        duration: 90,
        pickUpTime: new Date(),
        status: 'parked',
        totalAmount: 0,
        listPriceCents: 1500,
        paymentMethod: 'card',
        paymentStatus: 'paid',
        serviceType: 'park-and-hold',
        coveredBySubscription: sub._id,
        vehicle: { color: 'Black', model: 'Civic', licensePlate: 'ABC1234' },
    });

    await curbCustody.arm({ order });

    const note = await ParkingNote.create({
        order: order._id,
        valet: valetA._id,
        location: BLOCK_A,
        signPhotoBucket: 'test-bucket',
        signPhotoStoragePath: `parking-notes/${order._id}/x.jpg`,
        streetCleaning: MON_830,
        sweepDataStatus: 'captured',
    });
    await curbCustody.enrichFromNote({ order: await Order.findById(order._id), note });

    if (keysWith === 'customer') {
        const custody = await CurbCustody.findOne({ currentOrder: order._id });
        await curbCustody.giveKeysBack({ custody, order });
    }

    return { customer, valetA, valetB, sub, order };
};

/** Valet A hands the key for `order` to valet B, and B confirms the tag. */
const handOverKeys = async (order, valetA, valetB) => {
    const transfer = await KeyTransfer.create({
        senderValet: valetA._id,
        receiverValet: valetB._id,
        keys: [{
            keyTagNumberold: 1,
            orderId: order._id,
            vehicle: { model: 'Civic', color: 'Black', licensePlate: 'ABC1234' },
            parkingLocation: BLOCK_A.streetAddress,
        }],
        status: 'pending_acceptance',
    });

    const req = {
        user: { id: String(valetB._id) },
        body: { transferId: String(transfer._id), confirmedKeyTags: [1] },
        io: mockIo(),
        get: () => 'jest',
    };
    const res = mockRes();
    await keyTransferController.acceptTransfer(req, res);
    return res;
};

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    // The unique partial index on {currentOrder} is what stops one car opening
    // two custody rows, and indexes are not built automatically in these suites.
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
        KeyTransfer.deleteMany({}),
        OpsAlert.deleteMany({}),
    ]);
    jest.restoreAllMocks();
}, 30000);

describe('accepting a key transfer on a managed car', () => {
    test('the custody row follows the keys to the valet who now has them', async () => {
        const { valetA, valetB, order } = await parkedManagedCar();

        const before = await CurbCustody.findOne({ currentOrder: order._id });
        expect(String(before.valet)).toBe(String(valetA._id));
        expect(String(before.keyHolder)).toBe(String(valetA._id));

        const res = await handOverKeys(order, valetA, valetB);
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);

        const after = await CurbCustody.findOne({ currentOrder: order._id });
        expect(String(after.valet)).toBe(String(valetB._id));
        expect(String(after.keyHolder)).toBe(String(valetB._id));

        // The append-only key ledger has to be able to answer "where were these
        // keys on Tuesday", so the swap is written down, not just applied.
        const swap = after.keyHandoffs.filter((h) => h.direction === 'valet_swap');
        expect(swap).toHaveLength(1);
        expect(String(swap[0].fromValet)).toBe(String(valetA._id));
        expect(String(swap[0].toValet)).toBe(String(valetB._id));
    }, 30000);

    test('the next morning the sweep reminder reaches the valet holding the keys', async () => {
        const { valetA, valetB, order } = await parkedManagedCar();
        await handOverKeys(order, valetA, valetB);

        const sweep = nextMonday830();
        const now = new Date(sweep.getTime() - 30 * 60 * 1000);
        const pushed = jest
            .spyOn(notificationController, 'sendPushNotification')
            .mockResolvedValue({ success: true });
        const io = mockIo();

        const results = await dispatcher.tick({ now, io, notify: jest.fn() });

        expect(results.filter((r) => r.outcome === 'reminded')).toHaveLength(1);

        // The push and the socket both go to Bruno, who has the keys in his
        // pocket. Ada handed them over last night and can do nothing with this.
        const uids = pushed.mock.calls.map((c) => c[0]);
        expect(uids).toContain(valetB.firebaseUid);
        expect(uids).not.toContain(valetA.firebaseUid);

        const rooms = io.emits
            .filter((e) => e.event === 'aspNotification')
            .map((e) => String(e.room));
        expect(rooms).toContain(String(valetB._id));
        expect(rooms).not.toContain(String(valetA._id));
    }, 30000);

    test('a customer who took her keys back is not given a new holder she never met', async () => {
        const { valetA, valetB, order } = await parkedManagedCar({ keysWith: 'customer' });

        await handOverKeys(order, valetA, valetB);

        const after = await CurbCustody.findOne({ currentOrder: order._id });
        // The job on the car moved to Bruno, but nobody is holding keys that are
        // sitting in the customer's kitchen — claiming otherwise would send the
        // key-delivery job to a valet with nothing to hand over.
        expect(String(after.valet)).toBe(String(valetB._id));
        expect(after.keysWith).toBe('customer');
        expect(after.keyHolder).toBeFalsy();
        expect(after.keyHandoffs.filter((h) => h.direction === 'valet_swap')).toHaveLength(0);
    }, 30000);
});
