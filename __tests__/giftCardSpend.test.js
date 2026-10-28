/**
 * Gift card money pays for one-off moves, not just plan bills.
 *
 * The money sits as a credit on the customer's Stripe balance. A move it
 * covers is paid from it at booking with no card payment; a move it only
 * partly covers charges the card the rest; a cancel gives it back, once.
 * Customers who never redeemed a gift card are not looked up at all.
 *
 * Run: npx jest giftCardSpend
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const PREV_STRIPE_KEY = process.env.STRIPE_API_KEY;
process.env.STRIPE_API_KEY = 'sk_test_fake_for_jest';

const mockStripe = { balances: {}, keys: {}, retrieves: [], refunds: [], intents: [] };

jest.mock('stripe', () => {
    const client = {
        customers: {
            retrieve: jest.fn(async (id) => {
                mockStripe.retrieves.push(id);
                return { id, balance: mockStripe.balances[id] || 0 };
            }),
            create: jest.fn(async () => ({ id: 'cus_new' })),
            createBalanceTransaction: jest.fn(async (id, params, opts) => {
                const key = opts && opts.idempotencyKey;
                if (key && mockStripe.keys[key]) return mockStripe.keys[key];
                mockStripe.balances[id] = (mockStripe.balances[id] || 0) + params.amount;
                const txn = { id: `cbtxn_${Object.keys(mockStripe.keys).length}`, amount: params.amount, ending_balance: mockStripe.balances[id] };
                if (key) mockStripe.keys[key] = txn;
                return txn;
            }),
        },
        refunds: {
            create: jest.fn(async (params) => {
                mockStripe.refunds.push(params);
                return { id: `re_${mockStripe.refunds.length}`, amount: params.amount || 0, status: 'succeeded' };
            }),
        },
        paymentIntents: {
            create: jest.fn(async (params) => {
                mockStripe.intents.push(params);
                return { id: `pi_${mockStripe.intents.length}`, client_secret: 'secret', amount: params.amount };
            }),
        },
        ephemeralKeys: { create: jest.fn(async () => ({ secret: 'ek' })) },
    };
    return jest.fn(() => client);
});

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
            }),
        }),
    }),
}));

const Order = require('../models/Order');
const User = require('../models/User');
const GiftCard = require('../models/GiftCard');
const Payment = require('../models/Payment');
const orderController = require('../controllers/orderController');
const paymentController = require('../controllers/paymentController');

let mongod;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await Order.init();
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
    if (PREV_STRIPE_KEY === undefined) delete process.env.STRIPE_API_KEY;
    else process.env.STRIPE_API_KEY = PREV_STRIPE_KEY;
});

afterEach(async () => {
    await Promise.all([Order.deleteMany({}), User.deleteMany({}), GiftCard.deleteMany({}), Payment.deleteMany({})]);
    mockStripe.balances = {};
    mockStripe.keys = {};
    mockStripe.retrieves.length = 0;
    mockStripe.refunds.length = 0;
    mockStripe.intents.length = 0;
});

const mockRes = () => {
    const res = { statusCode: 0, body: null };
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

const mockIo = () => ({ emit: () => {}, to: () => ({ emit: () => {} }) });

let phoneSeq = 7000000;
// A customer whose Stripe balance holds `giftCents` of redeemed gift card money.
const makeCustomer = async ({ giftCents = 0, redeemed = true } = {}) => {
    const user = await User.create({
        phone: `+1917${phoneSeq++}`,
        verified: true,
        firstName: 'Gift',
        lastName: 'Tester',
        stripeCustomerId: `cus_${phoneSeq}`,
    });
    mockStripe.balances[user.stripeCustomerId] = -giftCents;
    if (redeemed) {
        await GiftCard.create({
            code: `T${phoneSeq}`,
            amountCents: giftCents || 100,
            redeemedBy: user._id,
            redeemedAt: new Date(),
            stripeBalanceTransactionId: 'cbtxn_redeem',
        });
    }
    return user;
};

const book = async (user, overrides = {}) => {
    const res = mockRes();
    await orderController.createOrder(
        {
            body: {
                customer: user._id.toString(),
                customerLocation: { lat: 40.679, lng: -73.995, streetAddress: '123 Court St, Brooklyn' },
                duration: 120,
                pickUpTime: new Date().toISOString(),
                orderType: 'parking',
                serviceType: 'standard',
                ...overrides,
            },
            io: mockIo(),
            subscription: null,
            user,
        },
        res
    );
    return res;
};

const balance = (user) => mockStripe.balances[user.stripeCustomerId];

describe('gift card money pays for one-off moves', () => {
    it('a move the balance covers is paid from it at booking, with no card payment', async () => {
        const user = await makeCustomer({ giftCents: 10000 });
        const res = await book(user);
        expect(res.statusCode).toBe(200);
        expect(res.body.order.totalAmount).toBe(1000);
        expect(res.body.order.paymentStatus).toBe('paid');
        expect(res.body.order.giftPaidCents).toBe(1000);
        expect(res.body.order.paymentIntentId).toBeUndefined();
        expect(balance(user)).toBe(-9000);
        expect(mockStripe.intents).toHaveLength(0);
    });

    it('a customer who never redeemed a gift card is not looked up, and pays by card', async () => {
        const user = await makeCustomer({ giftCents: 5000, redeemed: false });
        const res = await book(user);
        expect(res.body.order.paymentStatus).toBe('pending');
        expect(res.body.order.giftPaidCents).toBeUndefined();
        expect(mockStripe.retrieves).toHaveLength(0);
        expect(balance(user)).toBe(-5000);
    });

    it('a move the balance only partly covers charges the card the rest, and only once', async () => {
        const user = await makeCustomer({ giftCents: 600 });
        const booked = await book(user);
        expect(booked.body.order.paymentStatus).toBe('pending');
        const orderId = String(booked.body.order._id);

        const first = mockRes();
        await paymentController.createPaymentIntent({ body: { orderId } }, first);
        expect(first.statusCode).toBe(200);
        expect(mockStripe.intents[0].amount).toBe(400);
        expect(balance(user)).toBe(0);

        const again = mockRes();
        await paymentController.createPaymentIntent({ body: { orderId } }, again);
        expect(mockStripe.intents[1].amount).toBe(400);
        expect(balance(user)).toBe(0);
        expect((await Order.findById(orderId)).giftPaidCents).toBe(600);
    });

    it('the card always pays at least Stripe’s 50 cents', async () => {
        const user = await makeCustomer({ giftCents: 990 });
        const booked = await book(user);
        const res = mockRes();
        await paymentController.createPaymentIntent({ body: { orderId: String(booked.body.order._id) } }, res);
        expect(mockStripe.intents[0].amount).toBe(50);
        expect(balance(user)).toBe(-40);
    });

    it('cancelling a gift-paid move gives the money back, once', async () => {
        const user = await makeCustomer({ giftCents: 10000 });
        const booked = await book(user);
        const orderId = String(booked.body.order._id);

        const res = mockRes();
        await orderController.cancelOrder({ body: { orderId, userId: String(user._id) }, io: mockIo() }, res);
        expect(res.statusCode).toBe(200);
        expect(balance(user)).toBe(-10000);
        expect(mockStripe.refunds).toHaveLength(0);

        const giftBalance = require('../services/giftBalance');
        expect(await giftBalance.giveBack(await Order.findById(orderId), undefined, 'cancel')).toBe(0);
        expect(balance(user)).toBe(-10000);
        expect((await Order.findById(orderId)).giftReturnedCents).toBe(1000);
    });

    it('cancelling the return trip of a gift-paid park & retrieve puts that part back on the balance', async () => {
        const user = await makeCustomer({ giftCents: 10000 });
        const booked = await book(user, { serviceType: 'park-and-hold' });
        const orderId = String(booked.body.order._id);
        expect(booked.body.order.giftPaidCents).toBe(1300);
        await Order.updateOne({ _id: orderId }, { $set: { status: 'parked', parkClosedAt: new Date() } });

        const res = mockRes();
        await orderController.cancelRetrievalLeg(
            { params: { orderId }, body: { userId: String(user._id) }, io: mockIo() },
            res
        );
        expect(res.statusCode).toBe(200);
        expect(mockStripe.refunds).toHaveLength(0);
        expect(balance(user)).toBe(-10000 + 1300 - 300);
    });
});

const orderDoc = (user, fields) =>
    Order.create({
        customer: user._id,
        customerLocation: { lat: 40.679, lng: -73.995, streetAddress: '123 Court St, Brooklyn' },
        pickUpTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
        duration: 120,
        paymentMethod: 'card',
        status: 'pending',
        orderType: 'parking',
        serviceType: 'standard',
        ...fields,
    });

describe('every other charge spends gift money first', () => {
    it('a scheduled pick-up the balance covers is booked with no card on file', async () => {
        const user = await makeCustomer({ giftCents: 10000 });
        const order = await orderDoc(user, { totalAmount: 1500, paymentStatus: 'pending' });
        const scheduledMoves = require('../services/scheduledMoves');
        const r = await scheduledMoves.payForOrder({ _id: new mongoose.Types.ObjectId(), user: user._id }, order);
        expect(r).toMatchObject({ outcome: 'booked', chargedCents: 0, giftCents: 1500 });
        expect((await Order.findById(order._id)).paymentStatus).toBe('paid');
        expect(balance(user)).toBe(-8500);
        expect(mockStripe.intents).toHaveLength(0);
    });

    it('an extension the balance covers is added with nothing to pay', async () => {
        const user = await makeCustomer({ giftCents: 10000 });
        const booked = await book(user);
        const orderId = String(booked.body.order._id);
        await Order.updateOne({ _id: orderId }, { $set: { status: 'parked' } });
        const extensionController = require('../controllers/extensionController');
        const res = mockRes();
        await extensionController.createExtensionIntent({ params: { orderId }, body: { additionalHours: 2 } }, res);
        expect(res.body).toMatchObject({ success: true, covered: true, applied: true, amountCents: 0, giftCents: 600 });
        expect((await Order.findById(orderId)).duration).toBe(240);
        expect(balance(user)).toBe(-10000 + 1000 + 600);
        expect(mockStripe.intents).toHaveLength(0);
    });

    it('cancelling a gift-paid away booking gives all of it back', async () => {
        const user = await makeCustomer({ giftCents: 10000 });
        const order = await orderDoc(user, {
            totalAmount: 4000,
            paymentStatus: 'paid',
            awayMode: true,
            awayService: 'hold',
            awayPaidCents: 4000,
            giftSpends: [{ tag: 'order', cents: 4000, at: new Date() }],
            giftPaidCents: 4000,
            giftCustomerId: user.stripeCustomerId,
        });
        mockStripe.balances[user.stripeCustomerId] = -6000;
        const res = mockRes();
        await orderController.cancelOrder({ body: { orderId: String(order._id), userId: String(user._id) }, io: mockIo() }, res);
        expect(res.statusCode).toBe(200);
        expect(mockStripe.refunds).toHaveLength(0);
        expect(balance(user)).toBe(-10000);
        expect((await Order.findById(order._id)).giftReturnedCents).toBe(4000);
    });
});
