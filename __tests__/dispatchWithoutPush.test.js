/**
 * A paid order still reaches a valet when nothing can be pushed.
 * Run: npx jest dispatchWithoutPush
 *
 * `notifyClosestValets` sent the FCM multicast before it recorded
 * `notifiedValets` and before it emitted NEW_ORDER_AVAILABLE over the socket —
 * and `sendEachForMulticast` throws outright on an empty token array. So five
 * nearby valets with no live token between them (a reinstall, a token rotation,
 * a fresh device) produced a 500, an order with an empty notifiedValets, and no
 * socket event at all. Both clients swallow a failure on this call by contract,
 * so the customer saw a normal booking and the job simply sat there.
 *
 * Lives in its own file because firebase-admin and axios have to be mocked
 * before the controller is first required.
 */

jest.mock('firebase-admin', () => ({
    apps: [{}],
    initializeApp: jest.fn(),
    credential: { cert: jest.fn() },
    messaging: () => ({
        sendEachForMulticast: jest.fn(async (m) => {
            // Exactly what the real SDK does.
            if (!m.tokens || m.tokens.length === 0) {
                throw new Error('tokens must be a non-empty array');
            }
            return { successCount: m.tokens.length, failureCount: 0, responses: [] };
        }),
    }),
    firestore: () => ({
        collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }),
    }),
}));

jest.mock('axios', () => ({
    // Distance Matrix unavailable, so the haversine fallback ranks the valets.
    get: jest.fn(async () => ({ data: { status: 'ZERO_RESULTS' } })),
    post: jest.fn(async () => ({ data: {} })),
}));

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.STRIPE_API_KEY = 'sk_test_mocked';

const Order = require('../models/Order');
const User = require('../models/User');
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

const seed = async () => {
    const customer = await User.create({
        phone: '+15550200001', firebaseUid: 'fbc9', verified: false,
        firstName: 'Pat', lastName: 'Quinn',
    });
    // Active valet with no FCMToken row anywhere — the production shape right
    // after a reinstall.
    const valet = await User.create({
        phone: '+15550200002', firebaseUid: 'fbv9', verified: false,
        isValet: true, isActive: true,
        currentLocation: { lat: 40.681, lng: -73.998 },
    });
    const order = await Order.create({
        customer: customer._id,
        customerLocation: { lat: 40.68, lng: -73.99, streetAddress: '84 2nd Pl' },
        paymentMethod: 'card',
        totalAmount: 1300,
        paymentStatus: 'paid',
        status: 'pending',
        orderType: 'parking',
        duration: 180,
        pickUpTime: new Date(),
    });
    return { customer, valet, order };
};

describe('dispatch survives a valet with no push token', () => {
    it('records notifiedValets and emits to the valet anyway', async () => {
        const { valet, order } = await seed();

        const io = mockIo();
        const res = mockRes();
        await notificationController.notifyClosestValets(
            { body: { orderId: order._id.toString() }, io },
            res
        );

        expect(res.statusCode).toBe(200);

        const after = await Order.findById(order._id).lean();
        expect(after.notifiedValets).toHaveLength(1);
        expect(String(after.notifiedValets[0].valet)).toBe(valet._id.toString());

        const offer = io.emits.find((e) => e.payload?.type === 'NEW_ORDER_AVAILABLE');
        expect(offer).toBeDefined();
        expect(offer.room).toBe(valet._id.toString());
    });

    it('emits to the customer\'s own room, not a serialised document', async () => {
        const { customer, order } = await seed();

        const io = mockIo();
        const res = mockRes();
        await notificationController.notifyClosestValets(
            { body: { orderId: order._id.toString() }, io },
            res
        );

        const toCustomer = io.emits.find((e) => e.payload?.type === 'NEW_ORDER');
        expect(toCustomer).toBeDefined();
        expect(toCustomer.room).toBe(customer._id.toString());
    });
});
