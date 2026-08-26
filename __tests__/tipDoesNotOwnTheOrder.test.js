/**
 * A tip is a second charge, not the order's payment.
 *
 * Run: npx jest tipDoesNotOwnTheOrder
 *
 * `payment_intent.succeeded` used to take any intent carrying `metadata.orderId`
 * and write it onto the order — `paymentIntentId`, the whole `paymentDetails`
 * block, and `checkout.paidAt`. Tips and paid extensions both carry that field,
 * so a $3 tip on a $15 park left the order pointing at the tip. The receipt
 * showed $3, the funnel's paid-at moved to the tip's timestamp, and a later
 * cancellation would have refunded against the tip's charge instead of the
 * parking charge. Four production orders were found in that state and repaired.
 *
 * Both already have their own recording path — tipController writes the Tip row
 * before the webhook lands, and an extension is applied by
 * POST /api/order/:orderId/extend/confirm — so the webhook must leave the order
 * alone.
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
const REAL_STRIPE_KEY = process.env.STRIPE_API_KEY;
process.env.STRIPE_API_KEY = 'sk_test_mocked';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';

const mockStripe = {
    webhooks: { constructEvent: jest.fn() },
    paymentIntents: { retrieve: jest.fn(), create: jest.fn(), cancel: jest.fn() },
    subscriptions: { retrieve: jest.fn(), list: jest.fn() },
    invoices: { list: jest.fn(), retrieve: jest.fn() },
    customers: { retrieve: jest.fn(), create: jest.fn() },
    paymentMethods: { list: jest.fn() },
    refunds: { create: jest.fn() },
    ephemeralKeys: { create: jest.fn() },
    prices: { list: jest.fn() },
    paymentLinks: { retrieve: jest.fn() },
};
jest.mock('stripe', () => jest.fn(() => mockStripe));

const Order = require('../models/Order');
const User = require('../models/User');
const paymentController = require('../controllers/paymentController');

let mongod;

const mockRes = () => {
    const res = {};
    res.statusCode = 200;
    res.body = null;
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
};

const ORDER_PI = 'pi_the_parking_charge';

const deliver = async (intent) => {
    mockStripe.webhooks.constructEvent.mockReturnValue({
        id: 'evt_test',
        type: 'payment_intent.succeeded',
        data: { object: intent },
    });
    const res = mockRes();
    await paymentController.handleStripeWebhook(
        {
            headers: { 'stripe-signature': 't=1,v1=whatever' },
            body: Buffer.from('{}'),
            io: { to: () => ({ emit: () => {} }), emit: () => {} },
        },
        res
    );
    return res;
};

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
    if (REAL_STRIPE_KEY === undefined) delete process.env.STRIPE_API_KEY;
    else process.env.STRIPE_API_KEY = REAL_STRIPE_KEY;
});

afterEach(async () => {
    await Promise.all([Order.deleteMany({}), User.deleteMany({})]);
    mockStripe.webhooks.constructEvent.mockReset();
    mockStripe.paymentIntents.retrieve.mockReset();
    mockStripe.invoices.list.mockReset();
});

const seedPaidOrder = async () => {
    const customer = await User.create({
        phone: '+15559990001', firebaseUid: 'fb_tip', verified: false, firstName: 'Sam',
    });
    const valet = await User.create({
        phone: '+15559990002', firebaseUid: 'fb_tipv', verified: false, isValet: true,
    });
    const order = await Order.create({
        customer: customer._id,
        valet: valet._id,
        customerLocation: { lat: 40.68, lng: -73.99, streetAddress: '84 2nd Pl' },
        paymentMethod: 'card',
        totalAmount: 1500,
        paymentStatus: 'paid',
        status: 'completed',
        duration: 90,
        pickUpTime: new Date('2026-08-19T10:00:00Z'),
        paymentIntentId: ORDER_PI,
        paymentDetails: { amount: 1500, currency: 'usd', paidAt: new Date('2026-08-19T10:12:56Z') },
        checkout: { paidAt: new Date('2026-08-19T10:12:56Z') },
    });
    return { order, customer, valet };
};

describe('a tip webhook leaves the order it names alone', () => {
    it('does not move paymentIntentId, paymentDetails or checkout.paidAt', async () => {
        const { order, customer, valet } = await seedPaidOrder();

        const res = await deliver({
            id: 'pi_the_tip',
            object: 'payment_intent',
            amount: 300,
            currency: 'usd',
            status: 'succeeded',
            metadata: {
                type: 'tip',
                orderId: order._id.toString(),
                valetId: valet._id.toString(),
                customerId: customer._id.toString(),
                percentagePreset: '25',
                context: 'post_completion',
            },
        });

        expect(res.statusCode).toBe(200);

        const after = await Order.findById(order._id).lean();
        expect(after.paymentIntentId).toBe(ORDER_PI);
        expect(after.paymentDetails.amount).toBe(1500);
        expect(after.checkout.paidAt.toISOString()).toBe('2026-08-19T10:12:56.000Z');
    });

    it('nor does a paid extension', async () => {
        const { order, customer } = await seedPaidOrder();

        const res = await deliver({
            id: 'pi_the_extension',
            object: 'payment_intent',
            amount: 1000,
            currency: 'usd',
            status: 'succeeded',
            metadata: {
                purpose: 'extension',
                orderId: order._id.toString(),
                customerId: customer._id.toString(),
                additionalHours: '2',
            },
        });

        expect(res.statusCode).toBe(200);

        const after = await Order.findById(order._id).lean();
        expect(after.paymentIntentId).toBe(ORDER_PI);
        expect(after.paymentDetails.amount).toBe(1500);
    });

    it('but the order’s own intent still marks it paid', async () => {
        const customer = await User.create({
            phone: '+15559990003', firebaseUid: 'fb_own', verified: false, firstName: 'Lee',
        });
        const order = await Order.create({
            customer: customer._id,
            customerLocation: { lat: 40.68, lng: -73.99, streetAddress: '84 2nd Pl' },
            paymentMethod: 'card',
            totalAmount: 1300,
            paymentStatus: 'pending',
            status: 'pending',
            duration: 180,
            pickUpTime: new Date(),
        });

        // No subscription invoice behind this intent.
        mockStripe.invoices.list.mockResolvedValue({ data: [] });

        const res = await deliver({
            id: 'pi_this_orders_own_charge',
            object: 'payment_intent',
            amount: 1300,
            currency: 'usd',
            status: 'succeeded',
            metadata: {
                orderId: order._id.toString(),
                customerId: customer._id.toString(),
                platform: 'react-native',
            },
        });

        expect(res.statusCode).toBe(200);

        const after = await Order.findById(order._id).lean();
        expect(after.paymentStatus).toBe('paid');
        expect(after.paymentIntentId).toBe('pi_this_orders_own_charge');
        expect(after.checkout.paidAt).toBeInstanceOf(Date);
    });
});
