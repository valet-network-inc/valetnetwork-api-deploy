/**
 * The 30-minute stale sweep has to give back BOTH away charges.
 *
 * Run: npx jest staleAwayRefundBothCharges
 *
 * An away order can hold two charges — the $1 deposit taken at booking and
 * the balance charged when the valet reads the sign and saves the sweep days
 * — and `order.paymentIntentId` keeps pointing at the deposit. cancelOrder
 * has always walked the ledger for that reason. autoCancelStaleOrders did
 * not: it fired one bare refund at `paymentIntentId`, so a stale away order
 * handed the customer their dollar back and kept the balance on a cancelled
 * order, with nothing to catch it but a customer noticing the charge.
 *
 * How an order with a balance charge gets back into the stale sweep's
 * `pending` net: a valet accepts the away job, sets the schedule (balance
 * charged), then releases it with valetCancelOrder — which resets the order
 * to `pending` and clears the valet on purpose, and does not refund. If no
 * other valet takes it within 30 minutes of the pickup time, this job cancels
 * it. That reset is reproduced here with a direct write so the test stays
 * about the refund and not about the accept/release handshake.
 *
 * Stripe is mocked so the refunds themselves are asserted: which
 * PaymentIntent, and for how much.
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
// Process-wide, so it must be put back: jest reuses a worker across suites
// and a stray key would hand the NEXT suite a live Stripe client built on a
// fake secret.
const PREV_STRIPE_KEY = process.env.STRIPE_API_KEY;
process.env.STRIPE_API_KEY = 'sk_test_fake_for_jest';

const mockStripeCalls = { paymentIntents: [], refunds: [] };
let mockNextPiId = 1;
jest.mock('stripe', () => {
    const client = {
        paymentMethods: {
            list: jest.fn(async () => ({ data: [{ id: 'pm_saved_card' }] })),
        },
        paymentIntents: {
            create: jest.fn(async (params) => {
                mockStripeCalls.paymentIntents.push(params);
                return { id: `pi_balance_${mockNextPiId++}`, status: 'succeeded' };
            }),
            retrieve: jest.fn(async (id) => ({ id, status: 'succeeded' })),
        },
        refunds: {
            create: jest.fn(async (params) => {
                mockStripeCalls.refunds.push(params);
                return {
                    id: `re_${mockStripeCalls.refunds.length}`,
                    amount: params.amount,
                    status: 'succeeded',
                };
            }),
        },
        customers: {
            retrieve: jest.fn(async (id) => ({ id })),
            create: jest.fn(async () => ({ id: 'cus_x' })),
        },
        ephemeralKeys: { create: jest.fn(async () => ({ secret: 'ek_x' })) },
    };
    return jest.fn(() => client);
});

const Order = require('../models/Order');
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
    if (PREV_STRIPE_KEY === undefined) delete process.env.STRIPE_API_KEY;
    else process.env.STRIPE_API_KEY = PREV_STRIPE_KEY;
});

afterEach(async () => {
    mockStripeCalls.paymentIntents.length = 0;
    mockStripeCalls.refunds.length = 0;
    mockNextPiId = 1;
    await Promise.all([
        Order.deleteMany({}),
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
const mockIo = () => ({ emit() {}, to: () => ({ emit() {} }) });

let phoneSeq = 7781000;
const makeCustomer = () =>
    User.create({
        phone: `+1917${phoneSeq++}`,
        verified: true,
        firstName: 'Stale',
        stripeCustomerId: 'cus_test_stale',
    });

const HOME = { lat: 40.679, lng: -73.995, streetAddress: '123 Court St, Brooklyn' };
const MIN_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Books the away order the way the app does, then walks it through the
// deposit payment the way the PaymentSheet + updatePaymentStatus do.
const bookAndPayDeposit = async (user) => {
    const req = {
        body: {
            customer: user._id.toString(),
            customerLocation: HOME,
            duration: 7 * 24 * 60,
            pickUpTime: new Date(Date.now() + DAY_MS).toISOString(),
            awayMode: true,
            awayService: 'moves',
            // Exactly seven days, so each weekday falls inside the trip once
            // whatever day the suite runs on.
            awayEndTime: new Date(Date.now() + 8 * DAY_MS).toISOString(),
            awayDays: [],
            totalAmount: 4500, // client guess — server must ignore it
            orderType: 'parking',
            serviceType: 'park-and-hold',
            paymentMethod: 'card',
        },
        io: mockIo(),
        user,
        subscription: null,
    };
    const res = mockRes();
    await orderController.createOrder(req, res);
    const order = res.body.order;
    await Order.findByIdAndUpdate(order._id, {
        paymentStatus: 'paid',
        paymentIntentId: 'pi_deposit',
    });
    return order._id;
};

// Push the order far enough into the past that the stale sweep's
// `createdAt` and `pickUpTime` arms both match, and put it back in the
// pending pool the way a valet release does.
const goStale = (id) =>
    Order.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(String(id)) },
        {
            $set: {
                status: 'pending',
                createdAt: new Date(Date.now() - 45 * MIN_MS),
                pickUpTime: new Date(Date.now() - 45 * MIN_MS),
            },
            $unset: { valet: '', acceptedAt: '' },
        }
    );

describe('the stale sweep on an away order the valet already billed', () => {
    it('refunds the balance AND the deposit, not just the $1 intent', async () => {
        const user = await makeCustomer();
        const id = await bookAndPayDeposit(user);

        // Valet reads the sign and saves one sweep day: $15 total, $1 already
        // taken, so a $14 balance lands on a second PaymentIntent.
        await orderController.setAwaySchedule(
            {
                body: {
                    orderId: id.toString(),
                    awayDays: [{ weekday: 2, hour: 9, minute: 0 }],
                },
                io: mockIo(),
            },
            mockRes()
        );
        const billed = await Order.findById(id);
        expect(billed.awayPaidCents).toBe(1500);
        expect(billed.paymentIntentId).toBe('pi_deposit'); // still the deposit
        mockStripeCalls.refunds.length = 0;

        await goStale(id);
        const result = await orderController.autoCancelStaleOrders(mockIo());
        expect(result.cancelled).toBe(1);

        const refundedCents = mockStripeCalls.refunds.reduce(
            (sum, r) => sum + (r.amount || 0),
            0
        );
        expect(refundedCents).toBe(1500);
        // Newest charge first, then the deposit — same order cancelOrder uses.
        expect(
            mockStripeCalls.refunds.map((r) => [r.payment_intent, r.amount])
        ).toEqual([
            ['pi_balance_1', 1400],
            ['pi_deposit', 100],
        ]);

        const fresh = await Order.findById(id);
        expect(fresh.status).toBe('cancelled');
        // The ledger records what went back, so a later refund can't double-pay.
        expect(
            fresh.awayCharges.map((c) => [c.paymentIntentId, c.refundedCents])
        ).toEqual([
            ['pi_deposit', 100],
            ['pi_balance_1', 1400],
        ]);
    });

    it('still refunds an old away order that predates the charge ledger', async () => {
        const user = await makeCustomer();
        const id = await bookAndPayDeposit(user);
        // Away orders booked before awayPaidCents/awayCharges existed have
        // nothing for the ledger walk to find. They must not silently get
        // nothing back.
        await Order.collection.updateOne(
            { _id: new mongoose.Types.ObjectId(String(id)) },
            { $unset: { awayPaidCents: '', awayCharges: '' } }
        );

        await goStale(id);
        await orderController.autoCancelStaleOrders(mockIo());

        expect(mockStripeCalls.refunds).toEqual([
            { payment_intent: 'pi_deposit', reason: 'requested_by_customer' },
        ]);
        expect((await Order.findById(id)).status).toBe('cancelled');
    });

    it('still refunds the deposit when the valet never set a schedule', async () => {
        const user = await makeCustomer();
        const id = await bookAndPayDeposit(user);

        await goStale(id);
        await orderController.autoCancelStaleOrders(mockIo());

        expect(mockStripeCalls.refunds).toHaveLength(1);
        expect(mockStripeCalls.refunds[0].payment_intent).toBe('pi_deposit');
        expect(mockStripeCalls.refunds[0].amount).toBe(100);
        expect((await Order.findById(id)).status).toBe('cancelled');
    });
});

describe('an ordinary (non-away) stale order is untouched by the change', () => {
    it('gets the same single full refund on its own PaymentIntent', async () => {
        const user = await makeCustomer();
        const res = mockRes();
        await orderController.createOrder(
            {
                body: {
                    customer: user._id.toString(),
                    customerLocation: HOME,
                    duration: 120,
                    pickUpTime: new Date(Date.now() + 30 * MIN_MS).toISOString(),
                    totalAmount: 2500,
                    orderType: 'parking',
                    serviceType: 'park-and-hold',
                    paymentMethod: 'card',
                },
                io: mockIo(),
                user,
                subscription: null,
            },
            res
        );
        const id = res.body.order._id;
        await Order.findByIdAndUpdate(id, {
            paymentStatus: 'paid',
            paymentIntentId: 'pi_plain',
        });
        await goStale(id);

        await orderController.autoCancelStaleOrders(mockIo());

        expect(mockStripeCalls.refunds).toHaveLength(1);
        expect(mockStripeCalls.refunds[0]).toEqual({
            payment_intent: 'pi_plain',
            reason: 'requested_by_customer',
        });
        expect((await Order.findById(id)).status).toBe('cancelled');
    });
});
