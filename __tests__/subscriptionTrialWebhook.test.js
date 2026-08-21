/**
 * A free month must not start before a card is behind it.
 *
 * Run: npx jest subscriptionTrialWebhook
 *
 * Stripe opens a trial with a $0 invoice that it marks paid immediately, and
 * it reports the subscription as `trialing` right away. Both of those arrive
 * as webhooks, and either one taken at face value would hand a month of valet
 * service to someone who closed the payment sheet without entering a card —
 * and left nothing to charge for month two. These tests drive the appliers
 * against a mocked Stripe (the awayBilling.test.js pattern: mock-prefixed
 * factory vars, STRIPE_API_KEY restored afterwards).
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
const REAL_STRIPE_KEY = process.env.STRIPE_API_KEY;
process.env.STRIPE_API_KEY = 'sk_test_mocked';

const mockStripe = {
    subscriptions: { retrieve: jest.fn(), update: jest.fn(), cancel: jest.fn() },
    paymentIntents: { retrieve: jest.fn(), create: jest.fn() },
    customers: { retrieve: jest.fn() },
    paymentMethods: { list: jest.fn() },
    refunds: { create: jest.fn() },
    invoices: { list: jest.fn() },
    ephemeralKeys: { create: jest.fn() },
    prices: { list: jest.fn() },
};
jest.mock('stripe', () => jest.fn(() => mockStripe));

const Subscription = require('../models/Subscription');
const User = require('../models/User');
const subscriptionController = require('../controllers/subscriptionController');

let mongod;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await Subscription.init();
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
    // The next suite in this worker would otherwise build a live client on a
    // fake key.
    if (REAL_STRIPE_KEY === undefined) delete process.env.STRIPE_API_KEY;
    else process.env.STRIPE_API_KEY = REAL_STRIPE_KEY;
});

afterEach(async () => {
    await Promise.all([Subscription.deleteMany({}), User.deleteMany({})]);
    Object.values(mockStripe).forEach((group) =>
        Object.values(group).forEach((fn) => fn.mockReset())
    );
});

let seq = 5600000;
const makeUser = () =>
    User.create({ phone: `+1917${seq++}`, verified: true, firstName: 'Trial', lastName: 'Tester' });

const makeIncompleteTrial = async (user, overrides = {}) =>
    Subscription.create({
        user: user._id,
        tier: 'street_cleaning',
        interval: 'month',
        status: 'incomplete',
        amountCents: 5000,
        movesPerWeek: 1,
        promoCode: 'HANDSFREE',
        stripeCustomerId: 'cus_trial',
        stripeSubscriptionId: `sub_trial_${seq++}`,
        trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        aspSchedule: {
            address: { streetAddress: '123 Court St', lat: 40.679, lng: -73.995 },
            days: [{ weekday: 2, hour: 9, minute: 0 }],
        },
        ...overrides,
    });

const trialingOnStripe = (sub, extra = {}) => ({
    id: sub.stripeSubscriptionId,
    status: 'trialing',
    customer: 'cus_trial',
    default_payment_method: null,
    pending_setup_intent: { id: 'seti_1', status: 'requires_payment_method', payment_method: null },
    trial_end: Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000),
    current_period_end: Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000),
    ...extra,
});

const zeroInvoice = (sub) => ({
    id: 'in_trial_zero',
    amount_paid: 0,
    total: 0,
    subscription: sub.stripeSubscriptionId,
});

const noCardsOnFile = () => {
    mockStripe.customers.retrieve.mockResolvedValue({ id: 'cus_trial', invoice_settings: {} });
    mockStripe.paymentMethods.list.mockResolvedValue({ data: [] });
};

describe('the $0 invoice that opens a free month', () => {
    it('does not start the plan while no card is behind it', async () => {
        const user = await makeUser();
        const sub = await makeIncompleteTrial(user);
        mockStripe.subscriptions.retrieve.mockResolvedValue(trialingOnStripe(sub));
        noCardsOnFile();

        const out = await subscriptionController.applyInvoicePaid(zeroInvoice(sub));

        expect(out.ignored).toBe('trial_awaiting_card');
        const after = await Subscription.findById(sub._id);
        expect(after.status).toBe('incomplete');
        expect(after.activatedAt).toBeUndefined();
        const owner = await User.findById(user._id);
        expect(owner.activeSubscription).toBeUndefined();
    });

    it('starts the plan when the card is already on the subscription', async () => {
        const user = await makeUser();
        const sub = await makeIncompleteTrial(user);
        mockStripe.subscriptions.retrieve.mockResolvedValue(
            trialingOnStripe(sub, { default_payment_method: 'pm_card_on_file' })
        );

        const out = await subscriptionController.applyInvoicePaid(zeroInvoice(sub));

        expect(out.handled).toBe(true);
        expect(out.ignored).toBeUndefined();
        const after = await Subscription.findById(sub._id);
        expect(after.status).toBe('active');
        expect(after.activatedAt).toBeTruthy();
    });
});

describe('Stripe calling the subscription trialing', () => {
    it('leaves it incomplete until a card lands', async () => {
        const user = await makeUser();
        const sub = await makeIncompleteTrial(user);
        const stripeSub = trialingOnStripe(sub);
        mockStripe.subscriptions.retrieve.mockResolvedValue(stripeSub);
        noCardsOnFile();

        const out = await subscriptionController.applySubscriptionUpdated(stripeSub, false);

        expect(out.ignored).toBe('trial_awaiting_card');
        expect((await Subscription.findById(sub._id)).status).toBe('incomplete');
    });

    it('still mirrors a plan that is already running', async () => {
        const user = await makeUser();
        const sub = await makeIncompleteTrial(user, { status: 'active', activatedAt: new Date() });
        const stripeSub = trialingOnStripe(sub, { default_payment_method: 'pm_1' });
        mockStripe.subscriptions.retrieve.mockResolvedValue(stripeSub);

        const out = await subscriptionController.applySubscriptionUpdated(stripeSub, false);

        expect(out.handled).toBe(true);
        expect((await Subscription.findById(sub._id)).status).toBe('active');
    });
});

describe('the dollar card check clearing', () => {
    it('puts the card on the plan, starts it, and refunds the dollar', async () => {
        const user = await makeUser();
        const sub = await makeIncompleteTrial(user, { trialDepositPaymentIntentId: 'pi_check' });
        mockStripe.subscriptions.retrieve.mockResolvedValue(trialingOnStripe(sub));
        mockStripe.paymentIntents.retrieve.mockResolvedValue({
            id: 'pi_check',
            status: 'succeeded',
            payment_method: 'pm_entered_in_sheet',
        });
        mockStripe.subscriptions.update.mockResolvedValue({});
        mockStripe.refunds.create.mockResolvedValue({ id: 're_1' });

        const out = await subscriptionController.applyTrialCardCheckPaid({
            metadata: { purpose: 'trial_card_check', subscriptionId: sub._id.toString() },
        });

        expect(out.handled).toBe(true);
        expect(mockStripe.subscriptions.update).toHaveBeenCalledWith(sub.stripeSubscriptionId, {
            default_payment_method: 'pm_entered_in_sheet',
        });
        expect(mockStripe.refunds.create).toHaveBeenCalledWith({ payment_intent: 'pi_check' });
        const after = await Subscription.findById(sub._id);
        expect(after.status).toBe('active');
        expect(after.trialDepositRefundedAt).toBeTruthy();
    });

    it('leaves the plan alone while the dollar is unpaid', async () => {
        const user = await makeUser();
        const sub = await makeIncompleteTrial(user, { trialDepositPaymentIntentId: 'pi_check' });
        mockStripe.subscriptions.retrieve.mockResolvedValue(trialingOnStripe(sub));
        mockStripe.paymentIntents.retrieve.mockResolvedValue({
            id: 'pi_check',
            status: 'requires_payment_method',
            payment_method: null,
        });
        noCardsOnFile();

        const out = await subscriptionController.applyTrialCardCheckPaid({
            metadata: { purpose: 'trial_card_check', subscriptionId: sub._id.toString() },
        });

        expect(out.handled).toBe(false);
        expect(out.reason).toBe('no_payment_method');
        expect(mockStripe.refunds.create).not.toHaveBeenCalled();
        expect((await Subscription.findById(sub._id)).status).toBe('incomplete');
    });

    it('refunds the dollar only once', async () => {
        const user = await makeUser();
        const sub = await makeIncompleteTrial(user, {
            trialDepositPaymentIntentId: 'pi_check',
            trialDepositRefundedAt: new Date(),
            status: 'active',
            activatedAt: new Date(),
        });
        mockStripe.subscriptions.retrieve.mockResolvedValue(
            trialingOnStripe(sub, { default_payment_method: 'pm_1' })
        );

        await subscriptionController.applyTrialCardCheckPaid({
            metadata: { purpose: 'trial_card_check', subscriptionId: sub._id.toString() },
        });

        expect(mockStripe.refunds.create).not.toHaveBeenCalled();
    });
});
