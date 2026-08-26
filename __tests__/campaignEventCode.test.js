/**
 * Campaign event codes — scope, one-per-customer, and valet pay.
 *
 * Run: npx jest campaignEventCode
 *
 * Event codes were built for a venue handing one out at the door: a valid code
 * made the WHOLE order free, forever, for anyone holding it. The 2026-08-26 ASP
 * push put a code in front of every customer on the platform, where that shape
 * is not safe. These lock in the three things that had to become true, and the
 * one thing that had to stay true (an unscoped code still behaves as it always
 * did).
 *
 * Style matches subscriptionsV2.test.js: mongodb-memory-server, controllers
 * called directly with hand-rolled req/res/io doubles.
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
delete process.env.STRIPE_API_KEY;

const Order = require('../models/Order');
const Event = require('../models/Event');
const User = require('../models/User');
const PricingConfig = require('../models/PricingConfig');
const orderController = require('../controllers/orderController');

let mongod;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await Order.init();
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

afterEach(async () => {
    await Promise.all([
        Order.deleteMany({}),
        Event.deleteMany({}),
        User.deleteMany({}),
        PricingConfig.deleteMany({}),
    ]);
});

const mockRes = () => {
    const res = { statusCode: 0, body: null };
    res.status = (c) => ((res.statusCode = c), res);
    res.json = (b) => ((res.body = b), res);
    return res;
};

const mockIo = () => ({ emit: () => {}, to: () => ({ emit: () => {} }) });

let seq = 0;
const makeCustomer = () =>
    User.create({
        firstName: 'Test',
        lastName: `Customer${++seq}`,
        phone: `+1555000${String(1000 + seq)}`,
        email: `rig${seq}@example.com`,
        firebaseUid: `uid-${seq}`,
        verified: true,
    });

// The doc shape actually created in production on 2026-08-26.
const makeAspCode = (overrides = {}) =>
    Event.create({
        code: 'ASP',
        name: 'First street cleaning free',
        type: 'temporary',
        validFrom: new Date(Date.now() - 60000),
        validUntil: new Date(Date.now() + 30 * 864e5),
        maxUses: 250,
        isActive: true,
        serviceType: 'standard',
        scope: 'asp',
        oncePerCustomer: true,
        paysValet: true,
        ...overrides,
    });

const createOrder = async (user, body) => {
    const req = {
        body: { customer: user._id.toString(), ...body },
        io: mockIo(),
        subscription: null,
    };
    const res = mockRes();
    await orderController.createOrder(req, res);
    return res;
};

const aspBody = (overrides = {}) => ({
    customerLocation: { lat: 40.6809, lng: -73.9988, streetAddress: '100 Carroll St' },
    parkingType: 'street',
    duration: 90,
    pickUpTime: new Date(Date.now() + 36e5).toISOString(),
    paymentMethod: 'card',
    totalAmount: 1500,
    orderType: 'parking',
    aspMode: true,
    eventCode: 'ASP',
    ...overrides,
});

describe('an ASP-scoped campaign code', () => {
    it('makes a street-cleaning move free and marks it paid', async () => {
        const user = await makeCustomer();
        await makeAspCode();

        const res = await createOrder(user, aspBody());

        expect(res.statusCode).toBe(201);
        expect(res.body.order.totalAmount).toBe(0);
        expect(res.body.order.paymentStatus).toBe('paid');
        expect(res.body.order.isFreeService).toBe(true);
        // A $0 order must never carry a PaymentIntent — cancel paths refund
        // against it without checking it ever charged for this order.
        expect(res.body.order.paymentIntentId).toBeFalsy();
    });

    it('still pays the valet: the order records what the move was worth', async () => {
        const user = await makeCustomer();
        await makeAspCode();

        const res = await createOrder(user, aspBody());
        const order = await Order.findById(res.body.order._id);

        // $15 list, and valetPayBaseCents reads it even with no subscription
        // behind it — otherwise the campaign is funded by the valets.
        expect(order.listPriceCents).toBe(1500);
        expect(orderController.valetPayBaseCents(order)).toBe(1500);
        expect(order.coveredBySubscription).toBeFalsy();
    });

    it('refuses a plain park — the code covers a street-cleaning move', async () => {
        const user = await makeCustomer();
        await makeAspCode();

        const res = await createOrder(user, aspBody({ aspMode: false, duration: 60 }));

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/street-cleaning move/i);
        expect(await Order.countDocuments({})).toBe(0);
    });

    it('refuses a multi-day away-mode hold', async () => {
        const user = await makeCustomer();
        await makeAspCode();

        const res = await createOrder(
            user,
            aspBody({
                awayMode: true,
                awayService: 'hold',
                awayDays: [],
                awayEndTime: new Date(Date.now() + 10 * 864e5).toISOString(),
            })
        );

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/street-cleaning move/i);
    });

    it('refuses to let the Car Watch add-on ride free', async () => {
        const user = await makeCustomer();
        await makeAspCode();

        const res = await createOrder(user, aspBody({ carWatch: true }));

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/Car Watch/i);
    });
});

describe('oncePerCustomer', () => {
    it('refuses a second redemption by the same customer', async () => {
        const user = await makeCustomer();
        await makeAspCode();

        const first = await createOrder(user, aspBody());
        expect(first.statusCode).toBe(201);
        // Close the first out so the live-order lock is not what refuses us.
        await Order.updateOne({ _id: first.body.order._id }, { $set: { status: 'completed' } });

        const second = await createOrder(user, aspBody());
        expect(second.statusCode).toBe(400);
        expect(second.body.message).toMatch(/already used/i);
    });

    it('does not burn the offer on a booking the customer cancelled', async () => {
        const user = await makeCustomer();
        await makeAspCode();

        const first = await createOrder(user, aspBody());
        await Order.updateOne({ _id: first.body.order._id }, { $set: { status: 'cancelled' } });

        const again = await createOrder(user, aspBody());
        expect(again.statusCode).toBe(201);
        expect(again.body.order.totalAmount).toBe(0);
    });

    it('does not count the retrieval leg as the redemption', async () => {
        const user = await makeCustomer();
        await makeAspCode();

        // The auto-return leg carries the parent's code; it is the same move.
        await Order.create({
            customer: user._id,
            customerLocation: { lat: 40.68, lng: -73.99, streetAddress: '100 Carroll St' },
            parkingType: 'retrieval',
            orderType: 'retrieval',
            duration: 30,
            pickUpTime: new Date(),
            paymentMethod: 'card',
            totalAmount: 0,
            paymentStatus: 'paid',
            status: 'completed',
            eventCode: 'ASP',
            isFreeService: true,
        });

        const res = await createOrder(user, aspBody());
        expect(res.statusCode).toBe(201);
        expect(res.body.order.totalAmount).toBe(0);
    });

    it('leaves a different customer their own free move', async () => {
        const a = await makeCustomer();
        const b = await makeCustomer();
        await makeAspCode();

        const first = await createOrder(a, aspBody());
        await Order.updateOne({ _id: first.body.order._id }, { $set: { status: 'completed' } });

        const res = await createOrder(b, aspBody());
        expect(res.statusCode).toBe(201);
        expect(res.body.order.totalAmount).toBe(0);
    });
});

describe('codes that predate scoping keep working', () => {
    it('an unscoped venue code still makes any order free, repeatedly', async () => {
        const user = await makeCustomer();
        await Event.create({
            code: 'VENUE',
            name: 'A venue code',
            type: 'enterprise',
            validFrom: new Date(Date.now() - 60000),
            validUntil: new Date(Date.now() + 864e5),
            isActive: true,
            // no scope, no oncePerCustomer, no paysValet — the old defaults
        });

        // A plain park, which an ASP-scoped code would refuse.
        const first = await createOrder(
            user,
            aspBody({ eventCode: 'VENUE', aspMode: false, duration: 60 })
        );
        expect(first.statusCode).toBe(201);
        expect(first.body.order.totalAmount).toBe(0);
        await Order.updateOne({ _id: first.body.order._id }, { $set: { status: 'completed' } });

        const second = await createOrder(
            user,
            aspBody({ eventCode: 'VENUE', aspMode: false, duration: 60 })
        );
        expect(second.statusCode).toBe(201);
        expect(second.body.order.totalAmount).toBe(0);

        // And it still pays the valet nothing, exactly as before.
        const order = await Order.findById(second.body.order._id);
        expect(orderController.valetPayBaseCents(order)).toBe(0);
    });
});
