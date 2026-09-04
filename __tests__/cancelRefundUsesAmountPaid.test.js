/**
 * Cancelling a plan must refund what the customer actually PAID for the
 * period, not the plan's sticker price.
 *
 * Run: npx jest cancelRefundUsesAmountPaid
 *
 * The two figures come apart constantly in production:
 *
 *   - a city-suspended street-cleaning day posts a Stripe balance credit, so
 *     the next invoice settles under list ($50 plan, $37.50 collected);
 *   - changePlan bills with proration_behavior 'always_invoice', so the
 *     period's money ends up split across the renewal invoice and a small
 *     proration invoice.
 *
 * cancelSubscription used to compute the refund off `sub.amountCents` and
 * then refuse to pay unless the newest paid invoice covered that whole
 * figure. Both cases above fell through to `refund.status = 'failed'` inside
 * an HTTP 200 whose message read like a clean cancel — the customer was
 * simply never given their money back, and the iOS app (which shows only
 * `message`) never said a word. The same sticker-price math also over-paid:
 * $37.50 collected, $15 of service used, $35 refunded.
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

const mockStripeCalls = { refunds: [], cancels: [] };
let mockInvoices = [];
jest.mock('stripe', () => {
    const client = {
        invoices: {
            // Stripe hands these back newest first.
            list: jest.fn(async () => ({ data: mockInvoices })),
        },
        refunds: {
            create: jest.fn(async (params) => {
                mockStripeCalls.refunds.push(params);
                return { id: `re_${mockStripeCalls.refunds.length}`, status: 'succeeded' };
            }),
        },
        subscriptions: {
            cancel: jest.fn(async (id) => {
                mockStripeCalls.cancels.push(id);
                return { id, status: 'canceled' };
            }),
        },
    };
    return jest.fn(() => client);
});

// The subscription controller pulls the whole service graph in; a mock that
// only answers auth() hangs the run instead of failing it.
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
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const subscriptionController = require('../controllers/subscriptionController');

let mongod;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await Order.init();
    await Subscription.init();
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
    if (PREV_STRIPE_KEY === undefined) delete process.env.STRIPE_API_KEY;
    else process.env.STRIPE_API_KEY = PREV_STRIPE_KEY;
    // Tearing the in-memory mongo down can outrun the 5s default on a loaded
    // machine, which fails the suite for no reason at all.
}, 30000);

afterEach(async () => {
    mockStripeCalls.refunds.length = 0;
    mockStripeCalls.cancels.length = 0;
    mockInvoices = [];
    await Promise.all([Order.deleteMany({}), Subscription.deleteMany({}), User.deleteMany({})]);
});

const mockRes = () => {
    const res = { statusCode: 0, body: null };
    res.status = (c) => ((res.statusCode = c), res);
    res.json = (b) => ((res.body = b), res);
    return res;
};

const HOME = { lat: 40.679, lng: -73.995, streetAddress: '123 Court St, Brooklyn' };
const PERIOD_START = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

let seq = 6120000;
const makeCustomer = () =>
    User.create({
        phone: `+1917${seq++}`,
        verified: true,
        firstName: 'Cancel',
        lastName: 'Tester',
    });

const makeSub = async (user, overrides = {}) => {
    const sub = await Subscription.create({
        user: user._id,
        tier: 'street_cleaning',
        interval: 'month',
        status: 'active',
        amountCents: 5000,
        movesPerWeek: 2,
        stripeCustomerId: 'cus_test',
        stripeSubscriptionId: `sub_test_${seq++}`,
        currentPeriodStart: PERIOD_START,
        currentPeriodEnd: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000),
        ...overrides,
    });
    await User.findByIdAndUpdate(user._id, { activeSubscription: sub._id });
    return sub;
};

// A settled invoice as Stripe returns it from invoices.list.
const paidInvoice = (id, piId, amountCents, createdAt) => ({
    id,
    payment_intent: piId,
    amount_paid: amountCents,
    created: Math.floor(createdAt.getTime() / 1000),
});

// A covered move the customer actually consumed this period.
const useCoveredMove = (user, sub, listPriceCents) =>
    Order.create({
        customer: user._id,
        customerLocation: HOME,
        paymentMethod: 'card',
        duration: 120,
        pickUpTime: new Date(),
        totalAmount: 0,
        status: 'completed',
        paymentStatus: 'paid',
        orderType: 'parking',
        serviceType: 'park-and-hold',
        coveredBySubscription: sub._id,
        listPriceCents,
    });

const cancel = async (user) => {
    const res = mockRes();
    await subscriptionController.cancelSubscription({ body: { userId: user._id.toString() } }, res);
    return res;
};

describe('cancel refund is computed off the money actually collected', () => {
    it('a suspension-credited period refunds the credited amount, not $0', async () => {
        const user = await makeCustomer();
        await makeSub(user);
        // City suspended one sweep day → $12.50 balance credit → the $50/mo
        // period settled at $37.50.
        mockInvoices = [paidInvoice('in_period', 'pi_period', 3750, PERIOD_START)];

        const res = await cancel(user);

        expect(res.statusCode).toBe(200);
        expect(res.body.refund.status).toBe('refunded');
        expect(res.body.refund.requestedCents).toBe(3750);
        expect(mockStripeCalls.refunds).toEqual([
            { payment_intent: 'pi_period', amount: 3750 },
        ]);
        expect(res.body.message).toContain('$37.50');
    });

    it('usage comes off the credited amount, so we never refund more than we took', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        mockInvoices = [paidInvoice('in_period', 'pi_period', 3750, PERIOD_START)];
        await useCoveredMove(user, sub, 1500); // one $15 covered move used

        const res = await cancel(user);

        // $37.50 collected − $15 used = $22.50. Off the $50 sticker it was $35,
        // i.e. nearly the whole payment handed back for a period we served.
        expect(res.body.usedCents).toBe(1500);
        expect(res.body.refund.requestedCents).toBe(2250);
        expect(mockStripeCalls.refunds).toEqual([
            { payment_intent: 'pi_period', amount: 2250 },
        ]);
    });

    it('after a mid-period plan change the refund spans both of the period invoices', async () => {
        const user = await makeCustomer();
        // Upgraded mid-period: amountCents is now the new plan's list price and
        // the newest paid invoice is the small proration one.
        await makeSub(user, { amountCents: 10000 });
        mockInvoices = [
            paidInvoice('in_proration', 'pi_proration', 1000, new Date(Date.now() - 86400000)),
            paidInvoice('in_period', 'pi_period', 5000, PERIOD_START),
        ];

        const res = await cancel(user);

        expect(res.body.refund.status).toBe('refunded');
        expect(res.body.refund.requestedCents).toBe(6000); // everything collected
        expect(mockStripeCalls.refunds).toEqual([
            { payment_intent: 'pi_proration', amount: 1000 },
            { payment_intent: 'pi_period', amount: 5000 },
        ]);
    });

    it('a refund we could not put through says so instead of reading as a clean cancel', async () => {
        const user = await makeCustomer();
        await makeSub(user);
        // Settled, but with nothing refundable attached to it.
        mockInvoices = [
            { id: 'in_period', payment_intent: null, amount_paid: 3750, created: Math.floor(PERIOD_START.getTime() / 1000) },
        ];

        const res = await cancel(user);

        expect(res.body.refund.status).toBe('failed');
        expect(res.body.message).toMatch(/did not go through/);
        expect(res.body.message).toContain('$37.50');
        // The cancel itself still has to land — the customer asked for it.
        expect(mockStripeCalls.cancels).toHaveLength(1);
        expect((await Subscription.findOne({ user: user._id })).status).toBe('cancelled');
    });

    it('a $0 promo period still cancels clean with nothing to refund', async () => {
        const user = await makeCustomer();
        await makeSub(user);
        mockInvoices = [paidInvoice('in_free', null, 0, PERIOD_START)];

        const res = await cancel(user);

        expect(res.body.refund.status).toBe('none');
        expect(res.body.refund.requestedCents).toBe(0);
        expect(mockStripeCalls.refunds).toHaveLength(0);
        expect(res.body.message).toMatch(/regular rates/);
    });
});
