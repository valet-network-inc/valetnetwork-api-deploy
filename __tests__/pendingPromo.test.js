/**
 * A promo code hung on the account, so a campaign push does not depend on the
 * customer finding the "Have a code?" field.
 *
 * Run: npx jest pendingPromo
 *
 * The rules being pinned down here are the ones that decide whether a blast
 * is safe to send: an account code applies itself when the app sends none, it
 * NEVER blocks a purchase when it does not fit, a code the customer typed
 * still wins and still errors, and activation takes the code back off so it
 * cannot silently discount their next plan.
 *
 * Mocked Stripe, subscriptionTrialWebhook.test.js pattern.
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
const REAL_STRIPE_KEY = process.env.STRIPE_API_KEY;
process.env.STRIPE_API_KEY = 'sk_test_mocked';
delete process.env.SUB_PROMO_CODES;

const mockStripe = {
    customers: { create: jest.fn(), retrieve: jest.fn() },
    paymentMethods: { list: jest.fn() },
    prices: { list: jest.fn() },
    subscriptions: { create: jest.fn(), cancel: jest.fn(), update: jest.fn(), retrieve: jest.fn() },
    paymentIntents: { create: jest.fn() },
    ephemeralKeys: { create: jest.fn() },
};
jest.mock('stripe', () => jest.fn(() => mockStripe));

const Subscription = require('../models/Subscription');
const User = require('../models/User');
const subscriptionController = require('../controllers/subscriptionController');
const adminPromo = require('../controllers/adminPromoController');

let mongod;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await Subscription.init();
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
    if (REAL_STRIPE_KEY === undefined) delete process.env.STRIPE_API_KEY;
    else process.env.STRIPE_API_KEY = REAL_STRIPE_KEY;
});

afterEach(async () => {
    await Promise.all([Subscription.deleteMany({}), User.deleteMany({})]);
});

let seq = 5700000;

const makeUser = (overrides = {}) =>
    User.create({
        phone: `+1917${seq++}`,
        verified: true,
        firstName: 'Pending',
        lastName: 'Tester',
        ...overrides,
    });

const mockRes = () => {
    const res = { statusCode: 200, body: null };
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

const STREET = { lat: 40.679, lng: -73.995, streetAddress: '123 Court St, Brooklyn' };

const createBody = (user, overrides = {}) => ({
    userId: user._id.toString(),
    tier: 'street_cleaning',
    interval: 'month',
    movesPerWeek: 1,
    aspSchedule: { address: STREET, days: [{ weekday: 2, hour: 9, minute: 0 }] },
    ...overrides,
});

// No saved card by default — that is the live-build path, where the card is
// verified with the refunded dollar.
const armStripe = ({ savedCard = null, trial = true } = {}) => {
    Object.values(mockStripe).forEach((group) =>
        Object.values(group).forEach((fn) => fn.mockReset())
    );
    mockStripe.customers.create.mockResolvedValue({ id: 'cus_pending' });
    mockStripe.customers.retrieve.mockResolvedValue({
        id: 'cus_pending',
        invoice_settings: { default_payment_method: savedCard },
    });
    mockStripe.paymentMethods.list.mockResolvedValue({ data: savedCard ? [{ id: savedCard }] : [] });
    mockStripe.prices.list.mockResolvedValue({ data: [{ id: 'price_sc_month', active: true }] });
    mockStripe.subscriptions.create.mockImplementation(async (args) => ({
        id: `sub_${seq++}`,
        status: args.trial_period_days ? 'trialing' : 'incomplete',
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        ...(args.trial_period_days
            ? { trial_end: Math.floor(Date.now() / 1000) + args.trial_period_days * 86400 }
            : {}),
        latest_invoice: args.trial_period_days
            ? { id: 'in_trial', payment_intent: null }
            : { id: 'in_first', payment_intent: { id: 'pi_first', client_secret: 'pi_first_secret' } },
        pending_setup_intent: null,
    }));
    mockStripe.paymentIntents.create.mockResolvedValue({
        id: 'pi_card_check',
        client_secret: 'pi_card_check_secret',
    });
    mockStripe.ephemeralKeys.create.mockResolvedValue({ secret: 'ek_secret' });
};

// The arguments Stripe was actually asked to create the subscription with.
const subArgs = () => mockStripe.subscriptions.create.mock.calls[0][0];

describe('a code hung on the account', () => {
    it('applies itself when the app sends no code', async () => {
        armStripe();
        const user = await makeUser({ pendingPromoCode: 'HANDSFREE', pendingPromoSetAt: new Date() });
        const res = mockRes();

        await subscriptionController.createSubscription({ body: createBody(user) }, res);

        expect(res.statusCode).toBe(201);
        expect(res.body.mode).toBe('card_check');
        expect(res.body.trial.code).toBe('HANDSFREE');
        expect(subArgs().trial_period_days).toBe(30);

        const sub = await Subscription.findOne({ user: user._id });
        expect(sub.promoCode).toBe('HANDSFREE');
    });

    it('is stored uppercase, so a lowercase write still matches', async () => {
        armStripe();
        const user = await makeUser({ pendingPromoCode: 'handsfree' });
        expect((await User.findById(user._id)).pendingPromoCode).toBe('HANDSFREE');

        const res = mockRes();
        await subscriptionController.createSubscription({ body: createBody(user) }, res);
        expect(res.body.trial.code).toBe('HANDSFREE');
    });

    it('lets the purchase through at full price when it does not fit the plan', async () => {
        armStripe();
        // HANDSFREE covers one move a week. This customer picked two.
        const user = await makeUser({ pendingPromoCode: 'HANDSFREE' });
        const res = mockRes();

        await subscriptionController.createSubscription(
            { body: createBody(user, { movesPerWeek: 2 }) },
            res
        );

        expect(res.statusCode).toBe(201);
        expect(subArgs().trial_period_days).toBeUndefined();
        expect(res.body.clientSecret).toBe('pi_first_secret');
        const sub = await Subscription.findOne({ user: user._id });
        expect(sub.promoCode).toBeUndefined();
    });

    it('lets the purchase through when the customer is past their free month', async () => {
        armStripe();
        const user = await makeUser({ pendingPromoCode: 'HANDSFREE' });
        await Subscription.create({
            user: user._id,
            tier: 'street_cleaning',
            interval: 'month',
            status: 'cancelled',
            amountCents: 5000,
            movesPerWeek: 1,
            activatedAt: new Date('2026-06-01'),
            stripeSubscriptionId: `sub_old_${seq++}`,
            aspSchedule: { address: STREET, days: [{ weekday: 2, hour: 9, minute: 0 }], source: 'onboarding' },
        });
        const res = mockRes();

        await subscriptionController.createSubscription({ body: createBody(user) }, res);

        expect(res.statusCode).toBe(201);
        expect(subArgs().trial_period_days).toBeUndefined();
    });

    it('does nothing when the code on the account is not a real code', async () => {
        armStripe();
        const user = await makeUser({ pendingPromoCode: 'NOSUCHCODE' });
        const res = mockRes();

        await subscriptionController.createSubscription({ body: createBody(user) }, res);

        expect(res.statusCode).toBe(201);
        expect(subArgs().trial_period_days).toBeUndefined();
    });
});

describe('a code the customer typed', () => {
    it('still wins over the one on the account', async () => {
        armStripe();
        const user = await makeUser({ pendingPromoCode: 'HANDSFREE' });
        const res = mockRes();

        await subscriptionController.createSubscription(
            { body: createBody(user, { promoCode: 'NOPE' }) },
            res
        );

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/not valid/i);
        expect(mockStripe.subscriptions.create).not.toHaveBeenCalled();
    });

    it('still gets the plan-mismatch sentence rather than a silent full-price charge', async () => {
        armStripe();
        const user = await makeUser({ pendingPromoCode: 'HANDSFREE' });
        const res = mockRes();

        await subscriptionController.createSubscription(
            { body: createBody(user, { promoCode: 'HANDSFREE', movesPerWeek: 2 }) },
            res
        );

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/\$50 a month/);
        expect(res.body.applyTo).toEqual({ tier: 'street_cleaning', interval: 'month', movesPerWeek: 1 });
    });
});

describe('once the plan starts', () => {
    it('a saved card gets no shortcut — the dollar check still runs', async () => {
        armStripe({ savedCard: 'pm_saved' });
        const user = await makeUser({ pendingPromoCode: 'HANDSFREE' });
        const res = mockRes();

        await subscriptionController.createSubscription({ body: createBody(user) }, res);

        expect(res.statusCode).toBe(201);
        expect(res.body.mode).toBe('card_check');
        expect(res.body.amountCents).toBeGreaterThan(0);
        // Still incomplete: nothing starts until the dollar clears.
        const sub = await Subscription.findOne({ user: user._id });
        expect(sub.status).toBe('incomplete');
    });

    it('the code comes back off the account', async () => {
        armStripe();
        const user = await makeUser({ pendingPromoCode: 'HANDSFREE' });
        const res = mockRes();
        await subscriptionController.createSubscription({ body: createBody(user) }, res);
        const sub = await Subscription.findOne({ user: user._id });

        // The dollar clears and the webhook mirror reports the trial live.
        mockStripe.subscriptions.retrieve.mockResolvedValue({
            id: sub.stripeSubscriptionId,
            status: 'trialing',
            default_payment_method: 'pm_from_check',
            current_period_start: Math.floor(Date.now() / 1000),
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        });
        await subscriptionController.applySubscriptionUpdated({ id: sub.stripeSubscriptionId });

        const after = await User.findById(user._id);
        expect(after.pendingPromoCode).toBeUndefined();
        expect(after.pendingPromoSetAt).toBeUndefined();
    });
});

describe('the admin endpoint that hangs codes on accounts', () => {
    it('sets the code on the listed accounts and nobody else', async () => {
        const a = await makeUser();
        const b = await makeUser();
        const untouched = await makeUser();
        const res = mockRes();

        await adminPromo.setPendingPromo(
            { body: { userIds: [a._id.toString(), b._id.toString()], code: 'handsfree' } },
            res
        );

        expect(res.body.success).toBe(true);
        expect(res.body.code).toBe('HANDSFREE');
        expect(res.body.modified).toBe(2);
        expect((await User.findById(a._id)).pendingPromoCode).toBe('HANDSFREE');
        expect((await User.findById(a._id)).pendingPromoSetAt).toBeInstanceOf(Date);
        expect((await User.findById(untouched._id)).pendingPromoCode).toBeUndefined();
    });

    it('refuses a code that does not exist, so a typo cannot sit on 72 accounts', async () => {
        const a = await makeUser();
        const res = mockRes();

        await adminPromo.setPendingPromo({ body: { userIds: [a._id.toString()], code: 'HANDFREE' } }, res);

        expect(res.statusCode).toBe(400);
        expect((await User.findById(a._id)).pendingPromoCode).toBeUndefined();
    });

    it('refuses an empty audience', async () => {
        const res = mockRes();
        await adminPromo.setPendingPromo({ body: { userIds: [], code: 'HANDSFREE' } }, res);
        expect(res.statusCode).toBe(400);
    });

    it('takes the code back off', async () => {
        const a = await makeUser({ pendingPromoCode: 'HANDSFREE', pendingPromoSetAt: new Date() });
        const res = mockRes();

        await adminPromo.setPendingPromo({ body: { userIds: [a._id.toString()], code: null } }, res);

        expect(res.body.cleared).toBe(true);
        expect((await User.findById(a._id)).pendingPromoCode).toBeUndefined();
    });

    it('lists who is carrying one', async () => {
        await makeUser({ pendingPromoCode: 'HANDSFREE' });
        await makeUser({ pendingPromoCode: 'HANDSFREE' });
        await makeUser();
        const res = mockRes();

        await adminPromo.listPendingPromo({}, res);

        expect(res.body.count).toBe(2);
        expect(res.body.byCode).toEqual({ HANDSFREE: 2 });
    });
});

describe('a plan that went live through the webhook mirror', () => {
    it('counts as started, so its code cannot be redeemed again after a cancel', async () => {
        armStripe();
        const user = await makeUser();
        const sub = await Subscription.create({
            user: user._id,
            tier: 'street_cleaning',
            interval: 'month',
            status: 'incomplete',
            amountCents: 5000,
            movesPerWeek: 1,
            promoCode: 'HANDSFREE',
            stripeSubscriptionId: `sub_wh_${seq++}`,
            aspSchedule: {
                address: STREET,
                days: [{ weekday: 2, hour: 9, minute: 0 }],
                source: 'onboarding',
            },
        });
        // Stripe reports the trial live with a card behind it.
        mockStripe.subscriptions.retrieve.mockResolvedValue({
            id: sub.stripeSubscriptionId,
            status: 'trialing',
            default_payment_method: 'pm_saved',
            current_period_start: Math.floor(Date.now() / 1000),
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        });
        await subscriptionController.applySubscriptionUpdated({ id: sub.stripeSubscriptionId });

        const after = await Subscription.findById(sub._id);
        expect(after.status).toBe('active');
        expect(after.activatedAt).toBeInstanceOf(Date);

        // The customer cancels mid-trial and comes back for another free month.
        after.status = 'cancelled';
        after.cancelledAt = new Date();
        await after.save();
        const promos = require('../services/subscriptionPromos');
        const blocked = await promos.promoRedemptionBlock(promos.findPromo('HANDSFREE'), user._id);
        expect(blocked).toMatch(/already used/i);
    });
});
