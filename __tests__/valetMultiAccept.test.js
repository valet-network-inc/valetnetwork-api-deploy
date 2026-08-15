/**
 * A valet holding more than one job at a time.
 * Run: npx jest valetMultiAccept
 *
 * What's pinned down here:
 *
 *  1. Accepting a second order while the first is still live works, and both
 *     stay assigned to that valet. This is the whole feature.
 *
 *  2. `hasActiveOrder` answers with the full set, and `activeOrder` still
 *     carries the oldest one — builds already on phones read that single field
 *     and would otherwise see the job swap out from under them.
 *
 *  3. The cap is a real stop, not decoration, and is env-tunable.
 *
 *  4. A job the valet has closed out (`parkClosedAt`) doesn't count against
 *     them, and neither does an Enterprise park — the front desk has the keys.
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../models/Order');
const User = require('../models/User');
const orderController = require('../controllers/orderController');

let mongo;

const mockRes = () => {
    const res = {};
    res.statusCode = 200;
    res.body = null;
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (payload) => {
        res.body = payload;
        return res;
    };
    return res;
};

const mockIo = () => ({
    emit: () => {},
    to: () => ({ emit: () => {} }),
});

let phoneSeq = 5560000000;
const makeUser = (extra = {}) => User.create({
    firstName: 'Test',
    lastName: 'User',
    email: `u${new mongoose.Types.ObjectId()}@example.com`,
    phone: String(++phoneSeq),
    verified: true,
    ...extra,
});

const LOC = { lat: 40.68, lng: -73.99, streetAddress: '1 Court St' };

const makePendingOrder = (customerId, extra = {}) => Order.create({
    customer: customerId,
    customerLocation: LOC,
    parkingType: 'street',
    orderType: 'parking',
    duration: 120,
    pickUpTime: new Date(),
    status: 'pending',
    totalAmount: 1300,
    paymentMethod: 'card',
    paymentStatus: 'paid',
    ...extra,
});

const accept = async (orderId, valetId) => {
    const req = {
        body: {
            orderId: String(orderId),
            valetId: String(valetId),
            valetLocation: LOC,
            conversationId: `conv-${orderId}`,
        },
        io: mockIo(),
    };
    const res = mockRes();
    await orderController.acceptOrder(req, res);
    return res;
};

const activeFor = async (valetId) => {
    const req = { query: { userId: String(valetId), isValet: 'true' } };
    const res = mockRes();
    await orderController.hasActiveOrder(req, res);
    return res;
};

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
});

afterEach(async () => {
    await Order.deleteMany({});
    await User.deleteMany({});
    delete process.env.VALET_MAX_ACTIVE_ORDERS;
});

describe('accepting more than one job', () => {
    test('a valet mid-job can take a second order', async () => {
        const customer = await makeUser();
        const valet = await makeUser({ isValet: true, valetOnboardingStatus: 'active' });

        const first = await makePendingOrder(customer._id);
        const second = await makePendingOrder(customer._id);

        const firstRes = await accept(first._id, valet._id);
        expect(firstRes.statusCode).toBe(200);

        const secondRes = await accept(second._id, valet._id);
        expect(secondRes.statusCode).toBe(200);
        expect(secondRes.body.success).toBe(true);

        const held = await Order.find({ valet: valet._id }).sort({ createdAt: 1 });
        expect(held).toHaveLength(2);
        expect(held.every((o) => o.status === 'accepted')).toBe(true);
    });

    test('hasActiveOrder returns the whole set, oldest first', async () => {
        const customer = await makeUser();
        const valet = await makeUser({ isValet: true, valetOnboardingStatus: 'active' });

        const first = await makePendingOrder(customer._id);
        const second = await makePendingOrder(customer._id);

        await accept(first._id, valet._id);
        // acceptedAt has millisecond resolution; make the ordering unambiguous.
        await new Promise((r) => setTimeout(r, 10));
        await accept(second._id, valet._id);

        const res = await activeFor(valet._id);
        expect(res.body.hasActiveOrder).toBe(true);
        expect(res.body.activeOrders).toHaveLength(2);
        expect(String(res.body.activeOrders[0]._id)).toBe(String(first._id));
        // Old builds read this field and only ever expected one order.
        expect(String(res.body.activeOrder._id)).toBe(String(first._id));
    });

    test('a second valet still cannot steal an order that is already taken', async () => {
        const customer = await makeUser();
        const valetA = await makeUser({ isValet: true, valetOnboardingStatus: 'active' });
        const valetB = await makeUser({ isValet: true, valetOnboardingStatus: 'active' });

        const order = await makePendingOrder(customer._id);

        expect((await accept(order._id, valetA._id)).statusCode).toBe(200);

        const stolen = await accept(order._id, valetB._id);
        expect(stolen.statusCode).toBe(409);

        const fresh = await Order.findById(order._id);
        expect(String(fresh.valet)).toBe(String(valetA._id));
    });
});

describe('the concurrency cap', () => {
    test('stops the valet once they are at capacity', async () => {
        process.env.VALET_MAX_ACTIVE_ORDERS = '2';

        const customer = await makeUser();
        const valet = await makeUser({ isValet: true, valetOnboardingStatus: 'active' });

        const orders = await Promise.all([
            makePendingOrder(customer._id),
            makePendingOrder(customer._id),
            makePendingOrder(customer._id),
        ]);

        expect((await accept(orders[0]._id, valet._id)).statusCode).toBe(200);
        expect((await accept(orders[1]._id, valet._id)).statusCode).toBe(200);

        const blocked = await accept(orders[2]._id, valet._id);
        expect(blocked.statusCode).toBe(409);
        expect(blocked.body.code).toBe('VALET_AT_CAPACITY');
        expect(blocked.body.maxActiveOrders).toBe(2);

        const third = await Order.findById(orders[2]._id);
        expect(third.status).toBe('pending');
        expect(third.valet).toBeFalsy();
    });

    test('0 means no cap', async () => {
        process.env.VALET_MAX_ACTIVE_ORDERS = '0';

        const customer = await makeUser();
        const valet = await makeUser({ isValet: true, valetOnboardingStatus: 'active' });

        for (let i = 0; i < 8; i += 1) {
            const order = await makePendingOrder(customer._id);
            expect((await accept(order._id, valet._id)).statusCode).toBe(200);
        }

        expect(await Order.countDocuments({ valet: valet._id })).toBe(8);
    });

    test('closed-out parks and Enterprise parks do not count against the cap', async () => {
        process.env.VALET_MAX_ACTIVE_ORDERS = '1';

        const customer = await makeUser();
        const valet = await makeUser({ isValet: true, valetOnboardingStatus: 'active' });

        // Park the valet already swiped to end.
        await makePendingOrder(customer._id, {
            status: 'parked',
            valet: valet._id,
            parkClosedAt: new Date(),
        });
        // Enterprise dispatch — front desk holds the keys, valet is free.
        await makePendingOrder(customer._id, {
            status: 'parked',
            valet: valet._id,
            endCustomerName: 'Room 402',
        });

        const fresh = await makePendingOrder(customer._id);
        const res = await accept(fresh._id, valet._id);
        expect(res.statusCode).toBe(200);

        const active = await activeFor(valet._id);
        expect(active.body.activeOrders).toHaveLength(1);
        expect(String(active.body.activeOrders[0]._id)).toBe(String(fresh._id));
    });
});
