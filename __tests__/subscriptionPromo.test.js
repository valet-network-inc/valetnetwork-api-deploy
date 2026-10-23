/**
 * HANDSFREE — the first-month-free trial code.
 *
 * Run: npx jest subscriptionPromo
 *
 * Same shape as subscriptionsV2.test.js: mongodb-memory-server, controllers
 * called directly with hand-rolled req/res doubles, no Stripe key in env so
 * every Stripe client is null. The Stripe call itself is not what these
 * tests are about — the rules around it are: which plan the code covers, who
 * may redeem it, and the fact that a free month owes no refund.
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
delete process.env.STRIPE_API_KEY;
delete process.env.SUB_PROMO_CODES;

const Order = require('../models/Order');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const PricingConfig = require('../models/PricingConfig');

const subscriptionController = require('../controllers/subscriptionController');
const { buildStatusPayload } = require('../services/subscriptionService');
const promos = require('../services/subscriptionPromos');
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
});

afterEach(async () => {
    await Promise.all([
        Order.deleteMany({}),
        Subscription.deleteMany({}),
        User.deleteMany({}),
        PricingConfig.deleteMany({}),
    ]);
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

let phoneSeq = 5590000;
const makeCustomer = async (overrides = {}) =>
    User.create({
        phone: `+1917${phoneSeq++}`,
        verified: true,
        firstName: 'Promo',
        lastName: 'Tester',
        ...overrides,
    });

const STREET = { lat: 40.679, lng: -73.995, streetAddress: '123 Court St, Brooklyn' };

const makeSub = async (user, overrides = {}) =>
    Subscription.create({
        user: user._id,
        tier: 'street_cleaning',
        interval: 'month',
        status: 'active',
        amountCents: 5000,
        movesPerWeek: 1,
        stripeSubscriptionId: `sub_promo_${phoneSeq++}`,
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        aspSchedule: { address: STREET, days: [{ weekday: 2, hour: 9, minute: 0 }], source: 'onboarding' },
        ...overrides,
    });

const THE_PLAN = { tier: 'street_cleaning', interval: 'month', movesPerWeek: 1 };

// ---------------------------------------------------------------------------
// The code itself
// ---------------------------------------------------------------------------

describe('HANDSFREE lookup', () => {
    it('is found however the customer types it', () => {
        expect(promos.findStaticPromo('HANDSFREE').code).toBe('HANDSFREE');
        expect(promos.findStaticPromo(' handsfree ').code).toBe('HANDSFREE');
        expect(promos.findStaticPromo('HandsFree').code).toBe('HANDSFREE');
    });

    it('rejects anything else', () => {
        expect(promos.findStaticPromo('HANDFREE')).toBeNull();
        expect(promos.findStaticPromo('')).toBeNull();
        expect(promos.findStaticPromo(undefined)).toBeNull();
    });

    it('is a trial, not a discount — a card is required', () => {
        const promo = promos.findStaticPromo('HANDSFREE');
        expect(promo.kind).toBe('free_trial');
        expect(promo.trialDays).toBe(30);
        const shown = promos.describe(promo, { amountCents: 5000, interval: 'month' });
        expect(shown.dueTodayCents).toBe(0);
        expect(shown.thenCents).toBe(5000);
        expect(shown.requiresCard).toBe(true);
    });
});

describe('which plan HANDSFREE covers', () => {
    it('covers the $50 monthly plan with one move a week', () => {
        expect(promos.planMismatch(promos.findStaticPromo('HANDSFREE'), THE_PLAN)).toBeNull();
    });

    it('turns down the two-move, the weekly and the bigger tiers', () => {
        const promo = promos.findStaticPromo('HANDSFREE');
        expect(promos.planMismatch(promo, { ...THE_PLAN, movesPerWeek: 2 })).toMatch(/\$50 a month/);
        expect(promos.planMismatch(promo, { ...THE_PLAN, interval: 'week' })).toMatch(/\$50 a month/);
        expect(promos.planMismatch(promo, { ...THE_PLAN, tier: 'valet_anywhere' })).toMatch(/\$50 a month/);
        expect(promos.planMismatch(promo, { ...THE_PLAN, tier: 'home_garage' })).toMatch(/\$50 a month/);
    });
});

describe('who may redeem it', () => {
    it('lets a customer with no history through', async () => {
        const user = await makeCustomer();
        expect(await promos.promoRedemptionBlock(promos.findStaticPromo('HANDSFREE'), user._id)).toBeNull();
    });

    it('turns away a customer who already used the code', async () => {
        const user = await makeCustomer();
        await makeSub(user, { status: 'cancelled', promoCode: 'HANDSFREE', activatedAt: new Date('2026-07-01') });
        const blocked = await promos.promoRedemptionBlock(promos.findStaticPromo('HANDSFREE'), user._id);
        expect(blocked).toMatch(/already used/i);
    });

    it('turns away a customer whose plan has started before', async () => {
        const user = await makeCustomer();
        await makeSub(user, { status: 'cancelled', activatedAt: new Date('2026-06-01') });
        const blocked = await promos.promoRedemptionBlock(promos.findStaticPromo('HANDSFREE'), user._id);
        expect(blocked).toMatch(/first plan/i);
    });

    it('ignores an abandoned purchase that never started', async () => {
        const user = await makeCustomer();
        await makeSub(user, { status: 'cancelled' }); // voided incomplete, never activated
        expect(await promos.promoRedemptionBlock(promos.findStaticPromo('HANDSFREE'), user._id)).toBeNull();
    });

    it('lets a customer who backed out of the payment sheet try again', async () => {
        const user = await makeCustomer();
        // What abandoning the sheet leaves behind: the code is stamped on a
        // doc that never went live.
        await makeSub(user, { status: 'cancelled', promoCode: 'HANDSFREE' });
        expect(await promos.promoRedemptionBlock(promos.findStaticPromo('HANDSFREE'), user._id)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// POST /api/subscription/promo — what the review screen asks before it commits
// ---------------------------------------------------------------------------

describe('checking a code before subscribing', () => {
    const check = async (body) => {
        const res = mockRes();
        await subscriptionController.checkPromo({ body }, res);
        return res;
    };

    it('describes the free month on the right plan', async () => {
        const res = await check({ code: 'handsfree', ...THE_PLAN });
        expect(res.statusCode).toBe(200);
        expect(res.body.promo.headline).toBe('First month free');
        expect(res.body.promo.dueTodayCents).toBe(0);
        expect(res.body.promo.thenCents).toBe(5000);
        expect(res.body.amountCents).toBe(5000);
        expect(res.body.note).toBeNull();
    });

    it('points a customer on the wrong plan at the one the code covers', async () => {
        const res = await check({ code: 'HANDSFREE', tier: 'valet_anywhere', interval: 'month', movesPerWeek: 2 });
        expect(res.statusCode).toBe(200);
        expect(res.body.applyTo).toEqual(THE_PLAN);
        expect(res.body.note).toMatch(/\$50 a month/);
        // Priced as the plan the code will actually put them on.
        expect(res.body.amountCents).toBe(5000);
    });

    it('says so plainly when the code is wrong', async () => {
        const res = await check({ code: 'FREEPARKING', ...THE_PLAN });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/not valid/i);
    });

    it('says so when the customer has already had a plan', async () => {
        const user = await makeCustomer();
        await makeSub(user, { status: 'cancelled', activatedAt: new Date() });
        const res = await check({ code: 'HANDSFREE', ...THE_PLAN, userId: user._id.toString() });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/first plan/i);
    });
});

// ---------------------------------------------------------------------------
// The dollar card check (older app builds)
// ---------------------------------------------------------------------------

describe('the card check that starts a free month', () => {
    it('does nothing for a subscription it cannot find', async () => {
        const out = await subscriptionController.applyTrialCardCheckPaid({
            metadata: { purpose: 'trial_card_check', subscriptionId: new mongoose.Types.ObjectId().toString() },
        });
        expect(out.handled).toBe(false);
        expect(out.reason).toBe('unknown_subscription');
    });

    it('never revives a cancelled subscription', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user, { status: 'cancelled', promoCode: 'HANDSFREE' });
        const out = await subscriptionController.applyTrialCardCheckPaid({
            metadata: { purpose: 'trial_card_check', subscriptionId: sub._id.toString() },
        });
        expect(out.ignored).toBe('terminal');
        const after = await Subscription.findById(sub._id);
        expect(after.status).toBe('cancelled');
    });
});

// ---------------------------------------------------------------------------
// Living inside the free month
// ---------------------------------------------------------------------------

describe('a plan inside its free month', () => {
    it('is entitled, owes no refund, and says when the first bill lands', async () => {
        const user = await makeCustomer();
        const endsAt = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
        const sub = await makeSub(user, { promoCode: 'HANDSFREE', trialEndsAt: endsAt, currentPeriodEnd: endsAt });
        const payload = await buildStatusPayload(sub);
        expect(payload.status).toBe('active');
        expect(payload.trial.code).toBe('HANDSFREE');
        expect(payload.trial.thenCents).toBe(5000);
        expect(new Date(payload.trial.endsAt).getTime()).toBe(endsAt.getTime());
        expect(payload.refundIfCancelledCents).toBe(0);
    });

    it('goes back to normal refund math once the free month is over', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user, {
            promoCode: 'HANDSFREE',
            trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        });
        const payload = await buildStatusPayload(sub);
        expect(payload.trial).toBeNull();
        expect(payload.refundIfCancelledCents).toBe(5000);
    });

    it('cancels with nothing owed back and says the card was never charged', async () => {
        const user = await makeCustomer();
        await makeSub(user, {
            promoCode: 'HANDSFREE',
            trialEndsAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
        });
        const res = mockRes();
        await subscriptionController.cancelSubscription({ body: { userId: user._id.toString() } }, res);
        expect(res.statusCode).toBe(200);
        expect(res.body.refund.status).toBe('none');
        expect(res.body.refund.requestedCents).toBe(0);
        expect(res.body.message).toMatch(/never charged/i);
        const after = await Subscription.findOne({ user: user._id });
        expect(after.status).toBe('cancelled');
    });

    it('will not let the free month be moved onto a bigger plan', async () => {
        const user = await makeCustomer();
        await makeSub(user, {
            promoCode: 'HANDSFREE',
            trialEndsAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
        });
        const res = mockRes();
        await subscriptionController.changePlan(
            { body: { userId: user._id.toString(), tier: 'valet_anywhere', interval: 'month' } },
            res
        );
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/free month/i);
    });
});

// ---------------------------------------------------------------------------
// HANDSFREE2 — the same free month on a block that is swept twice a week
// ---------------------------------------------------------------------------

const TWO_MOVE_PLAN = { tier: 'street_cleaning', interval: 'month', movesPerWeek: 2 };

describe('HANDSFREE2', () => {
    it('is found however the customer types it', () => {
        expect(promos.findStaticPromo('HANDSFREE2').code).toBe('HANDSFREE2');
        expect(promos.findStaticPromo(' handsfree2 ').code).toBe('HANDSFREE2');
        // What people actually type when they hear it out loud.
        expect(promos.findStaticPromo('hands free 2').code).toBe('HANDSFREE2');
        expect(promos.findStaticPromo('HANDSFREE-2').code).toBe('HANDSFREE2');
        expect(promos.normalizeCode('FreeWeek!')).toBe('FREEWEEK');
    });

    it('does not swallow the one-move code, and the one-move code does not swallow it', () => {
        expect(promos.findStaticPromo('HANDSFREE').code).toBe('HANDSFREE');
        expect(promos.findStaticPromo('HANDSFREE2').appliesTo.movesPerWeek).toBe(2);
        expect(promos.findStaticPromo('HANDSFREE').appliesTo.movesPerWeek).toBe(1);
    });

    it('is a trial that converts to $100, not $50', () => {
        const promo = promos.findStaticPromo('HANDSFREE2');
        expect(promo.kind).toBe('free_trial');
        expect(promo.trialDays).toBe(30);
        const shown = promos.describe(promo, { amountCents: 10000, interval: 'month' });
        expect(shown.dueTodayCents).toBe(0);
        expect(shown.thenCents).toBe(10000);
        expect(shown.requiresCard).toBe(true);
    });

    it('covers the two-move monthly plan and nothing else', () => {
        const promo = promos.findStaticPromo('HANDSFREE2');
        expect(promos.planMismatch(promo, TWO_MOVE_PLAN)).toBeNull();
        expect(promos.planMismatch(promo, { ...TWO_MOVE_PLAN, movesPerWeek: 1 })).toMatch(/\$100 a month/);
        expect(promos.planMismatch(promo, { ...TWO_MOVE_PLAN, interval: 'week' })).toMatch(/\$100 a month/);
        expect(promos.planMismatch(promo, { ...TWO_MOVE_PLAN, tier: 'valet_anywhere' })).toMatch(/\$100 a month/);
    });

    it('tells the customer how many moves the code is for', () => {
        // The sentence used to be written for HANDSFREE alone and said "one
        // move a week" whichever code produced it.
        expect(promos.planMismatch(promos.findStaticPromo('HANDSFREE2'), THE_PLAN)).toMatch(/two moves a week/);
        expect(promos.planMismatch(promos.findStaticPromo('HANDSFREE'), TWO_MOVE_PLAN)).toMatch(/one move a week/);
    });

    it('is still one free month per customer', async () => {
        const user = await makeCustomer();
        expect(await promos.promoRedemptionBlock(promos.findStaticPromo('HANDSFREE2'), user._id)).toBeNull();
        await makeSub(user, { status: 'cancelled', activatedAt: new Date('2026-07-01') });
        expect(await promos.promoRedemptionBlock(promos.findStaticPromo('HANDSFREE2'), user._id)).toMatch(/first plan/i);
    });

    it('snaps a customer who picked one move onto the two-move plan, priced at $100', async () => {
        const res = mockRes();
        await subscriptionController.checkPromo({ body: { code: 'handsfree2', ...THE_PLAN } }, res);
        expect(res.statusCode).toBe(200);
        expect(res.body.applyTo).toEqual(TWO_MOVE_PLAN);
        expect(res.body.amountCents).toBe(10000);
        expect(res.body.promo.dueTodayCents).toBe(0);
        expect(res.body.promo.thenCents).toBe(10000);
        expect(res.body.note).toMatch(/two moves a week/);
    });

    it('quotes $100 with no complaint when they were already on the right plan', async () => {
        const res = mockRes();
        await subscriptionController.checkPromo({ body: { code: 'HANDSFREE2', ...TWO_MOVE_PLAN } }, res);
        expect(res.statusCode).toBe(200);
        expect(res.body.note).toBeNull();
        expect(res.body.amountCents).toBe(10000);
        expect(res.body.promo.thenCents).toBe(10000);
    });

    it('can be hung on an account ahead of the purchase', async () => {
        const user = await makeCustomer();
        const res = mockRes();
        await adminPromo.setPendingPromo(
            { body: { userIds: [user._id.toString()], code: 'handsfree2' } },
            res
        );
        expect(res.body.success).toBe(true);
        expect(res.body.code).toBe('HANDSFREE2');
        expect(res.body.appliesTo).toEqual(TWO_MOVE_PLAN);
        expect((await User.findById(user._id)).pendingPromoCode).toBe('HANDSFREE2');
    });
});

// ---------------------------------------------------------------------------
// LOLGARAGE — the Permanent valet free month. One code, no cap on how many
// customers redeem it; the only limit is one free month per customer.
// ---------------------------------------------------------------------------

const GARAGE_PLAN = { tier: 'home_garage', interval: 'month' };

describe('LOLGARAGE', () => {
    it('is found however the customer types it', () => {
        expect(promos.findStaticPromo('lolgarage').code).toBe('LOLGARAGE');
        expect(promos.findStaticPromo('LOL-GARAGE').code).toBe('LOLGARAGE');
        expect(promos.findStaticPromo('lol garage ').code).toBe('LOLGARAGE');
    });

    it('is a free month that converts at $250, with a card taken up front', () => {
        const promo = promos.findStaticPromo('LOLGARAGE');
        expect(promo.kind).toBe('free_trial');
        expect(promo.trialDays).toBe(30);
        const shown = promos.describe(promo, { amountCents: 25000, interval: 'month' });
        expect(shown.dueTodayCents).toBe(0);
        expect(shown.thenCents).toBe(25000);
        expect(shown.requiresCard).toBe(true);
    });

    it('covers Permanent valet monthly and nothing else', () => {
        const promo = promos.findStaticPromo('LOLGARAGE');
        expect(promos.planMismatch(promo, GARAGE_PLAN)).toBeNull();
        // Permanent valet is not bought by the move, so the sentence must not
        // invent a weekly cadence for it — and it is priced by its address
        // (2026-10-09), so the sentence names no one price either.
        expect(promos.planMismatch(promo, THE_PLAN)).toBe(
            'LOLGARAGE covers the Permanent valet plan, billed by the month.'
        );
        expect(promos.planMismatch(promo, { ...GARAGE_PLAN, tier: 'valet_anywhere' })).toMatch(
            /billed by the month/
        );
    });

    it('has no redemption cap of its own — a second customer redeems it fine', async () => {
        const first = await makeCustomer();
        await makeSub(first, {
            tier: 'home_garage',
            amountCents: 25000,
            promoCode: 'LOLGARAGE',
            activatedAt: new Date('2026-08-01'),
        });
        const second = await makeCustomer();
        expect(await promos.promoRedemptionBlock(promos.findStaticPromo('LOLGARAGE'), second._id)).toBeNull();
    });

    it('is one free month per customer, and says which limit they hit', async () => {
        const user = await makeCustomer();
        expect(await promos.promoRedemptionBlock(promos.findStaticPromo('LOLGARAGE'), user._id)).toBeNull();
        await makeSub(user, {
            tier: 'home_garage',
            amountCents: 25000,
            promoCode: 'LOLGARAGE',
            activatedAt: new Date('2026-08-01'),
        });
        expect(await promos.promoRedemptionBlock(promos.findStaticPromo('LOLGARAGE'), user._id)).toMatch(
            /already used LOLGARAGE/
        );
    });

    // A shipped app sends no address, and /plans showed it the Brooklyn and
    // Queens price, so that is the price the code converts at here.
    it('quotes the /plans price with nothing to fix when the customer is already on the plan', async () => {
        const res = mockRes();
        await subscriptionController.checkPromo({ body: { code: 'lolgarage', ...GARAGE_PLAN } }, res);
        expect(res.statusCode).toBe(200);
        expect(res.body.note).toBeNull();
        expect(res.body.amountCents).toBe(30000);
        expect(res.body.promo.dueTodayCents).toBe(0);
        expect(res.body.promo.thenCents).toBe(30000);
    });

    it('snaps a customer who came in on the street-cleaning plan onto Permanent valet', async () => {
        const res = mockRes();
        await subscriptionController.checkPromo({ body: { code: 'LOLGARAGE', ...THE_PLAN } }, res);
        expect(res.statusCode).toBe(200);
        expect(res.body.applyTo).toMatchObject(GARAGE_PLAN);
        expect(res.body.amountCents).toBe(30000);
        expect(res.body.note).toMatch(/Permanent valet/);
    });
});

// ---------------------------------------------------------------------------
// LMAOGARAGE — a week of Permanent valet instead of a month.
// ---------------------------------------------------------------------------

describe('LMAOGARAGE', () => {
    it('is a free week that converts at $250, with a card taken up front', () => {
        const promo = promos.findStaticPromo('lmao garage');
        expect(promo.code).toBe('LMAOGARAGE');
        expect(promo.kind).toBe('free_trial');
        expect(promo.trialDays).toBe(7);
        expect(promo.headline).toBe('First week free');
        const now = new Date('2026-09-23T16:00:00Z');
        const shown = promos.describe(promo, { amountCents: 25000, interval: 'month', now });
        expect(shown.dueTodayCents).toBe(0);
        expect(shown.thenCents).toBe(25000);
        expect(shown.trialEndsAt.toISOString()).toBe('2026-09-30T16:00:00.000Z');
    });

    it('covers Permanent valet monthly and nothing else', () => {
        const promo = promos.findStaticPromo('LMAOGARAGE');
        expect(promos.planMismatch(promo, GARAGE_PLAN)).toBeNull();
        expect(promos.planMismatch(promo, THE_PLAN)).toBe(
            'LMAOGARAGE covers the Permanent valet plan, billed by the month.'
        );
    });

    it('calls itself a free week, and leaves every other code a free month', () => {
        expect(promos.trialLabel('LMAOGARAGE')).toBe('free week');
        expect(promos.trialLabel(promos.findStaticPromo('LMAOGARAGE'))).toBe('free week');
        expect(promos.trialLabel('LOLGARAGE')).toBe('free month');
        expect(promos.trialLabel('HANDSFREE')).toBe('free month');
        expect(promos.trialLabel(undefined)).toBe('free month');
    });

    it('says "free week" when a customer cancels inside it', async () => {
        const user = await makeCustomer();
        await makeSub(user, {
            tier: 'home_garage',
            amountCents: 25000,
            promoCode: 'LMAOGARAGE',
            trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        });
        const res = mockRes();
        await subscriptionController.cancelSubscription({ body: { userId: user._id.toString() } }, res);
        expect(res.statusCode).toBe(200);
        expect(res.body.refund.requestedCents).toBe(0);
        expect(res.body.message).toBe('Cancelled — your free week ends here and your card was never charged.');
    });

    it('says "free week" when it blocks a plan switch', async () => {
        const user = await makeCustomer();
        await makeSub(user, {
            tier: 'home_garage',
            amountCents: 25000,
            promoCode: 'LMAOGARAGE',
            trialEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        });
        const res = mockRes();
        await subscriptionController.changePlan(
            { body: { userId: user._id.toString(), tier: 'valet_anywhere', interval: 'month' } },
            res
        );
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/^Your free week is running/);
    });
});
