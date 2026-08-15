/**
 * Away-mode deposit billing, end to end against a fake Stripe.
 *
 * Run: npx jest awayBilling
 *
 * The money story this locks down (the Citibike shape): $1 at booking, the
 * balance when the valet reads the sign and sets the schedule, and — if the
 * order is later cancelled — every cent back across BOTH charges. The
 * charges land on two different PaymentIntents, which is exactly what a
 * single-PaymentIntent refund would have stranded.
 *
 * Stripe is mocked (not skipped) so the charge and refund calls themselves
 * are asserted: amounts, which PaymentIntent, and in what order.
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
// Set process-wide, so it must be put back: jest reuses a worker process
// across suites, and a stray key would give the NEXT suite a live Stripe
// client built on a fake secret.
const PREV_STRIPE_KEY = process.env.STRIPE_API_KEY;
process.env.STRIPE_API_KEY = 'sk_test_fake_for_jest';

// --- fake Stripe -----------------------------------------------------------
const mockStripeCalls = { paymentIntents: [], refunds: [] };
let mockNextPiId = 1;
jest.mock('stripe', () => {
    // ONE client for the whole suite: the controller and the test must hold
    // the same object for per-test overrides (a decline) to take effect.
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
                return { id: `re_${mockStripeCalls.refunds.length}`, amount: params.amount, status: 'succeeded' };
            }),
        },
        customers: { retrieve: jest.fn(async (id) => ({ id })), create: jest.fn(async () => ({ id: 'cus_x' })) },
        ephemeralKeys: { create: jest.fn(async () => ({ secret: 'ek_x' })) },
    };
    return jest.fn(() => client);
});

const Order = require('../models/Order');
const User = require('../models/User');
const PricingConfig = require('../models/PricingConfig');
const orderController = require('../controllers/orderController');
const { nyWallTimeToInstant } = require('../services/nyTime');

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
    await Promise.all([Order.deleteMany({}), User.deleteMany({}), PricingConfig.deleteMany({})]);
});

const mockRes = () => {
    const res = { statusCode: 0, body: null };
    res.status = (c) => ((res.statusCode = c), res);
    res.json = (b) => ((res.body = b), res);
    return res;
};
const mockIo = () => ({ emit() {}, to: () => ({ emit() {} }) });

let phoneSeq = 7770000;
const makeCustomer = () =>
    User.create({
        phone: `+1917${phoneSeq++}`,
        verified: true,
        firstName: 'Away',
        stripeCustomerId: 'cus_test_away',
    });

const HOME = { lat: 40.679, lng: -73.995, streetAddress: '123 Court St, Brooklyn' };
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
            awayEndTime: new Date(Date.now() + 9 * DAY_MS).toISOString(),
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

    // The deposit is charged through the normal PaymentIntent flow; that
    // charge is what saves the card for the later off-session balance.
    await Order.findByIdAndUpdate(order._id, {
        paymentStatus: 'paid',
        paymentIntentId: 'pi_deposit',
    });
    return { created: order, id: order._id };
};

describe('away deposit → balance → refund', () => {
    it('charges $1 at booking, ignoring whatever the client asked for', async () => {
        const user = await makeCustomer();
        const { created } = await bookAndPayDeposit(user);
        expect(created.totalAmount).toBe(100);
        expect(created.awayPaidCents).toBe(100);
        expect(created.paymentStatus).toBe('pending');
        expect(created.awayBilling.status).toBe('pending_schedule');
    });

    it('bills only the BALANCE when the valet sets the schedule, and shows the true total', async () => {
        const user = await makeCustomer();
        const { id } = await bookAndPayDeposit(user);

        const res = mockRes();
        await orderController.setAwaySchedule(
            { body: { orderId: id.toString(), awayDays: [{ weekday: 2, hour: 9, minute: 0 }] }, io: mockIo() },
            res
        );
        expect(res.statusCode).toBe(200);

        // One Tuesday in the window at the $15 ASP rate, $1 already taken.
        expect(mockStripeCalls.paymentIntents).toHaveLength(1);
        expect(mockStripeCalls.paymentIntents[0].amount).toBe(1400);
        expect(mockStripeCalls.paymentIntents[0].off_session).toBe(true);
        expect(mockStripeCalls.paymentIntents[0].payment_method).toBe('pm_saved_card');

        const fresh = await Order.findById(id);
        expect(fresh.totalAmount).toBe(1500); // what Activity shows
        expect(fresh.awayPaidCents).toBe(1500);
        expect(fresh.awayBilling.status).toBe('settled');
        expect(fresh.awayBilling.lastDeltaCents).toBe(1400);
        // Both charges are on the ledger: the deposit and the balance.
        expect(fresh.awayCharges.map((c) => [c.paymentIntentId, c.amountCents])).toEqual([
            ['pi_deposit', 100],
            ['pi_balance_1', 1400],
        ]);
    });

    it('cancelling after the balance charge refunds ALL $15, across both charges', async () => {
        const user = await makeCustomer();
        const { id } = await bookAndPayDeposit(user);
        await orderController.setAwaySchedule(
            { body: { orderId: id.toString(), awayDays: [{ weekday: 2, hour: 9, minute: 0 }] }, io: mockIo() },
            mockRes()
        );
        mockStripeCalls.refunds.length = 0;

        const res = mockRes();
        await orderController.cancelOrder(
            { body: { orderId: id.toString(), userId: user._id.toString() }, io: mockIo() },
            res
        );
        expect(res.statusCode).toBe(200);

        // Newest charge first, then the deposit — $15.00 in total.
        expect(mockStripeCalls.refunds).toEqual([
            { payment_intent: 'pi_balance_1', amount: 1400 },
            { payment_intent: 'pi_deposit', amount: 100 },
        ]);
        const total = mockStripeCalls.refunds.reduce((s, r) => s + r.amount, 0);
        expect(total).toBe(1500);
        expect((await Order.findById(id)).status).toBe('cancelled');
    });

    it('a valet correction downward refunds the difference off the balance charge', async () => {
        const user = await makeCustomer();
        const { id } = await bookAndPayDeposit(user);
        // Valet first sets two days ($30 → $29 balance charged)...
        await orderController.setAwaySchedule(
            {
                body: {
                    orderId: id.toString(),
                    awayDays: [
                        { weekday: 2, hour: 9, minute: 0 },
                        { weekday: 5, hour: 9, minute: 0 },
                    ],
                },
                io: mockIo(),
            },
            mockRes()
        );
        expect(mockStripeCalls.paymentIntents[0].amount).toBe(2900);
        mockStripeCalls.refunds.length = 0;

        // ...then corrects to one day: $15 owed, $30 taken → $15 back.
        const res = mockRes();
        await orderController.setAwaySchedule(
            { body: { orderId: id.toString(), awayDays: [{ weekday: 2, hour: 9, minute: 0 }] }, io: mockIo() },
            res
        );
        expect(res.body.billing.status).toBe('settled');
        expect(mockStripeCalls.refunds).toEqual([{ payment_intent: 'pi_balance_1', amount: 1500 }]);

        const fresh = await Order.findById(id);
        expect(fresh.totalAmount).toBe(1500);
        // Ledger records the partial refund, so a later cancel only gives
        // back what is still held ($29 − $15 refunded, plus the $1 deposit).
        const held = fresh.awayCharges.reduce(
            (s, c) => s + (c.amountCents - (c.refundedCents || 0)),
            0
        );
        expect(held).toBe(1500);
    });

    it('cancelling after a correction refunds exactly what is still held', async () => {
        const user = await makeCustomer();
        const { id } = await bookAndPayDeposit(user);
        await orderController.setAwaySchedule(
            {
                body: {
                    orderId: id.toString(),
                    awayDays: [
                        { weekday: 2, hour: 9, minute: 0 },
                        { weekday: 5, hour: 9, minute: 0 },
                    ],
                },
                io: mockIo(),
            },
            mockRes()
        );
        await orderController.setAwaySchedule(
            { body: { orderId: id.toString(), awayDays: [{ weekday: 2, hour: 9, minute: 0 }] }, io: mockIo() },
            mockRes()
        );
        mockStripeCalls.refunds.length = 0;

        await orderController.cancelOrder(
            { body: { orderId: id.toString(), userId: user._id.toString() }, io: mockIo() },
            mockRes()
        );
        const total = mockStripeCalls.refunds.reduce((s, r) => s + r.amount, 0);
        expect(total).toBe(1500); // never more than the customer actually paid
        expect(mockStripeCalls.refunds).toEqual([
            { payment_intent: 'pi_balance_1', amount: 1400 },
            { payment_intent: 'pi_deposit', amount: 100 },
        ]);
    });

    it('a declined balance charge leaves the schedule set and the deposit untouched', async () => {
        const user = await makeCustomer();
        const { id } = await bookAndPayDeposit(user);
        const stripeModule = require('stripe');
        const client = stripeModule();
        client.paymentIntents.create.mockImplementationOnce(async () => {
            const e = new Error('Your card was declined.');
            e.code = 'card_declined';
            throw e;
        });

        const res = mockRes();
        await orderController.setAwaySchedule(
            { body: { orderId: id.toString(), awayDays: [{ weekday: 2, hour: 9, minute: 0 }] }, io: mockIo() },
            res
        );
        expect(res.statusCode).toBe(200);
        const fresh = await Order.findById(id);
        expect(fresh.awayDays).toHaveLength(1); // the service still happens
        expect(fresh.awayBilling.status).toBe('charge_failed');
        expect(fresh.totalAmount).toBe(100); // only the deposit was ever taken
        expect(mockStripeCalls.refunds).toHaveLength(0);
    });
});
