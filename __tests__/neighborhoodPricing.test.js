/**
 * Permanent valet priced by its address (spec v2, 2026-10-09).
 *
 * Run: npx jest neighborhoodPricing
 *
 * The table, the /plans and /price responses, the price guard for shipped
 * clients, the lock on subscriptions sold before, and a new subscriber's
 * address move from the next bill. Stripe is a stub handed to
 * services/stripeClient.js; nothing here reaches the network.
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
delete process.env.STRIPE_API_KEY;

const Subscription = require('../models/Subscription');
const User = require('../models/User');
const PromoCode = require('../models/PromoCode');
const NeighborhoodPricing = require('../models/NeighborhoodPricing');
const stripeClient = require('../services/stripeClient');
const pricing = require('../services/neighborhoodPricing');
const prices = require('../services/subscriptionPrices');
const { buildPriceQuote } = require('../services/priceQuote');
const subscriptionController = require('../controllers/subscriptionController');

// Addresses the tests price. Points only matter; the text is for reading.
const CHELSEA = { lat: 40.7429, lng: -73.9985, streetAddress: '200 W 20th St, New York, NY 10011, USA' };
const SOHO = { lat: 40.7236, lng: -74.0004, streetAddress: '155 Spring St, New York, NY 10012, USA' };
const PARK_SLOPE = { lat: 40.6712, lng: -73.9779, streetAddress: '300 7th Ave, Brooklyn, NY 11215, USA' };
const ASTORIA = { lat: 40.7644, lng: -73.9235, streetAddress: '30-01 31st St, Astoria, NY 11102, USA' };
const FORDHAM = { lat: 40.8611, lng: -73.8906, streetAddress: '1 Fordham Plaza, Bronx, NY 10458, USA' };

const NOW = new Date('2026-10-09T16:00:00Z');

let mongod;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await Subscription.init();
    await PromoCode.init();
}, 60000);

afterAll(async () => {
    stripeClient.reset();
    await mongoose.disconnect();
    await mongod.stop();
});

afterEach(async () => {
    stripeClient.reset();
    prices.clearPriceCache();
    pricing.invalidate();
    await Promise.all([
        Subscription.deleteMany({}),
        User.deleteMany({}),
        PromoCode.deleteMany({}),
        NeighborhoodPricing.deleteMany({}),
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

let phoneSeq = 6460000;
const makeCustomer = (overrides = {}) =>
    User.create({ phone: `+1917${phoneSeq++}`, verified: true, firstName: 'Sam', lastName: 'Lee', ...overrides });

/** A Stripe double with just enough surface for subscriptions. */
function stripeStub() {
    const minted = new Map(); // lookup_key -> price
    let seq = 0;
    const stub = {
        minted,
        customers: {
            create: jest.fn(async () => ({ id: `cus_${++seq}` })),
            retrieve: jest.fn(async (id) => ({ id, invoice_settings: {} })),
            update: jest.fn(async (id) => ({ id })),
        },
        prices: {
            list: jest.fn(async ({ lookup_keys: [key] }) => {
                if (minted.has(key)) return { data: [minted.get(key)] };
                // The catalog the deploy script mints, so the anchor resolves.
                if (key.startsWith('vn_') && !/_c\d+$/.test(key)) {
                    return { data: [{ id: `price_${key}`, active: true, product: 'prod_garage' }] };
                }
                return { data: [] };
            }),
            create: jest.fn(async (args) => {
                const price = { id: `price_new_${++seq}`, active: true, product: args.product, ...args };
                minted.set(args.lookup_key, price);
                return price;
            }),
        },
        subscriptions: {
            create: jest.fn(async () => ({
                id: `sub_${++seq}`,
                status: 'incomplete',
                current_period_start: Math.floor(NOW.getTime() / 1000),
                current_period_end: Math.floor(NOW.getTime() / 1000) + 30 * 86400,
                latest_invoice: { id: `in_${seq}`, payment_intent: { client_secret: 'pi_secret' } },
            })),
            retrieve: jest.fn(async (id) => ({ id, status: 'active', items: { data: [{ id: 'si_1' }] } })),
            update: jest.fn(async (id, args) => ({ id, ...args })),
            cancel: jest.fn(async (id) => ({ id })),
        },
        ephemeralKeys: { create: jest.fn(async () => ({ secret: 'ek_secret' })) },
        coupons: { create: jest.fn(async (args) => ({ id: `co_${++seq}`, ...args })) },
        setupIntents: {
            create: jest.fn(async (args) => ({ id: `seti_${++seq}`, client_secret: 'seti_secret', ...args })),
        },
    };
    return stub;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

describe('the price at an address', () => {
    const table = pricing.seedTable();

    it('is the sheet price in Manhattan, by nearest neighborhood centre', () => {
        expect(pricing.garagePriceAt(table, CHELSEA, 'month')).toMatchObject({
            amountCents: 52500,
            borough: 'Manhattan',
            neighborhood: 'Chelsea',
            key: 'manhattan-chelsea',
            label: 'Chelsea',
        });
        expect(pricing.garagePriceAt(table, SOHO, 'month').amountCents).toBe(77500);
    });

    it('is $300 everywhere in Brooklyn and Queens, and still names the neighborhood', () => {
        expect(pricing.garagePriceAt(table, PARK_SLOPE, 'month')).toMatchObject({
            amountCents: 30000,
            borough: 'Brooklyn',
            neighborhood: 'Park Slope',
            label: 'Park Slope',
        });
        expect(pricing.garagePriceAt(table, ASTORIA, 'month')).toMatchObject({
            amountCents: 30000,
            borough: 'Queens',
            neighborhood: 'Astoria',
        });
    });

    it('is weekly at 30% of monthly, rounded to $5', () => {
        expect(pricing.garagePriceAt(table, PARK_SLOPE, 'week').amountCents).toBe(9000);
        expect(pricing.garagePriceAt(table, CHELSEA, 'week').amountCents).toBe(16000);
        expect(pricing.garagePriceAt(table, SOHO, 'week').amountCents).toBe(23500);
    });

    it('is not offered outside Manhattan, Brooklyn and Queens', () => {
        expect(pricing.garagePriceAt(table, FORDHAM, 'month')).toBeNull();
        expect(pricing.NOT_OFFERED_MESSAGE).toBe(
            'Permanent valet is offered in Manhattan, Brooklyn and Queens. We don’t cover that address yet.'
        );
    });

    it('lists every neighborhood that can unlock: 18, 47 and 46, then two not offered', () => {
        const all = pricing.allNeighborhoods(table);
        const count = (b) => all.filter((n) => n.borough === b).length;
        expect(count('Manhattan')).toBe(18);
        expect(count('Brooklyn')).toBe(47);
        expect(count('Queens')).toBe(46);
        expect(all.slice(-2).map((n) => [n.name, n.offered])).toEqual([
            ['Staten Island', false],
            ['The Bronx', false],
        ]);
        expect(new Set(all.map((n) => n.key)).size).toBe(all.length);
    });

    it('is seeded into Mongo once, and an admin edit is checked before it lands', async () => {
        const live = await pricing.getTable();
        expect(live.brooklynQueens.monthlyCents).toBe(30000);
        expect(await NeighborhoodPricing.countDocuments()).toBe(1);

        const bad = await pricing.saveTable({ brooklynQueens: { monthlyCents: 30000, commissionCents: 40000 } }, 'test');
        expect(bad.error).toMatch(/commission/);

        const ok = await pricing.saveTable({ brooklynQueens: { monthlyCents: 32500, commissionCents: 5000 } }, 'test');
        expect(ok.table.brooklynQueens.monthlyCents).toBe(32500);
        expect(pricing.garagePriceAt(ok.table, PARK_SLOPE, 'month').amountCents).toBe(32500);
    });
});

// ---------------------------------------------------------------------------
// /plans
// ---------------------------------------------------------------------------

describe('GET /plans', () => {
    it('sells Permanent valet "from $300/mo", hides Valet anywhere and carries Contact sales', async () => {
        const res = mockRes();
        await subscriptionController.getPlans({}, res);
        expect(res.statusCode).toBe(200);
        const tiers = res.body.plans.map((p) => p.tier);
        expect(tiers).toEqual(['street_cleaning', 'home_garage']);

        const garage = res.body.plans.find((p) => p.tier === 'home_garage');
        expect(garage.name).toBe('Permanent valet');
        expect(garage.pricedByAddress).toBe(true);
        expect(garage.fromAmountCents).toBe(30000);
        expect(garage.monthly).toEqual({ amountCents: 30000, fromAmountCents: 30000 });
        expect(garage.weekly).toEqual({ amountCents: 9000, fromAmountCents: 9000 });

        expect(res.body.contactSales).toEqual({
            prompt: 'Questions?',
            label: 'Contact sales',
            phone: '+19796616772',
            email: 'rishi@valetnetwork.co',
            subject: 'Subscription',
            message:
                'Hey Rishi, this is {name}. I’d like help with the subscription and was wondering if it could be cheaper in any way. Thanks!',
        });
    });
});

// ---------------------------------------------------------------------------
// /price — the review card
// ---------------------------------------------------------------------------

describe('POST /price', () => {
    const GARAGE = { tier: 'home_garage', interval: 'month' };

    it('prices the address and renders the lines the review screen shows', async () => {
        const { status, body } = await buildPriceQuote({ ...GARAGE, address: CHELSEA, now: NOW });
        expect(status).toBe(200);
        expect(body.available).toBe(true);
        expect(body.lines).toEqual([
            { label: 'Permanent valet in Chelsea', amountCents: 52500, amount: '$525/mo', kind: 'price' },
            { label: 'Due today', amountCents: 52500, amount: '$525', kind: 'total' },
        ]);
        expect(body.cta).toBe('Subscribe · $525/mo');
        expect(body.contactSales.label).toBe('Contact sales');
    });

    it('takes a percent code off the first month and says when the full price starts', async () => {
        await PromoCode.create({ code: 'SAVE20', kind: 'percent_off', percentOff: 20, duration: 'once' });
        const { body } = await buildPriceQuote({ ...GARAGE, address: CHELSEA, promoCode: 'save20', now: NOW });
        expect(body.lines).toEqual([
            { label: 'Permanent valet in Chelsea', amountCents: 52500, amount: '$525/mo', kind: 'price' },
            { label: 'SAVE20 · 20% off your first month', amountCents: -10500, amount: '−$105', kind: 'discount' },
            { label: 'Due today', amountCents: 42000, amount: '$420', kind: 'total' },
        ]);
        expect(body.note).toBe('Then $525/mo from Nov 9.');
        expect(body.cta).toBe('Subscribe · $420 today');
        expect(body.promo.label).toBe('SAVE20 · 20% off your first month');
    });

    it('refuses a code that would make the first bill $0, and keeps the plan', async () => {
        await PromoCode.create({ code: 'BIGOFF', kind: 'amount_off', amountOffCents: 60000 });
        const { body } = await buildPriceQuote({ ...GARAGE, address: CHELSEA, promoCode: 'BIGOFF', now: NOW });
        expect(body.promoError).toBe("That code can't be used on this plan.");
        expect(body.dueTodayCents).toBe(52500);
        expect(body.promo).toBeNull();
    });

    it('gives a rep code no discount', async () => {
        await PromoCode.create({ code: 'ALEX', kind: 'rep', rep: new mongoose.Types.ObjectId() });
        const { body } = await buildPriceQuote({ ...GARAGE, address: PARK_SLOPE, promoCode: 'ALEX', now: NOW });
        expect(body.dueTodayCents).toBe(30000);
        expect(body.lines.filter((l) => l.kind === 'discount')).toEqual([]);
    });

    it('says where the plan is not offered, as a 200 the screen can show', async () => {
        const { status, body } = await buildPriceQuote({ ...GARAGE, address: FORDHAM, now: NOW });
        expect(status).toBe(200);
        expect(body.available).toBe(false);
        expect(body.message).toBe(
            'Permanent valet is offered in Manhattan, Brooklyn and Queens. We don’t cover that address yet.'
        );
    });

    it('will not sell Valet anywhere', async () => {
        const { body } = await buildPriceQuote({ tier: 'valet_anywhere', interval: 'month', now: NOW });
        expect(body.available).toBe(false);
        expect(body.message).toMatch(/no longer offered/);
    });
});

// ---------------------------------------------------------------------------
// The price guard on /create
// ---------------------------------------------------------------------------

describe('POST /create price guard', () => {
    const create = async (body) => {
        const res = mockRes();
        await subscriptionController.createSubscription({ body }, res);
        return res;
    };

    it('stops a purchase whose price moved since the client showed it', async () => {
        stripeClient.set(stripeStub());
        const user = await makeCustomer();
        const res = await create({
            userId: String(user._id),
            tier: 'home_garage',
            interval: 'month',
            homeAddress: CHELSEA,
            expectedAmountCents: 50000,
        });
        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('PRICE_CHANGED');
        expect(res.body.amountCents).toBe(52500);
    });

    it('tells a shipped app that cannot show a Manhattan price to update', async () => {
        stripeClient.set(stripeStub());
        const user = await makeCustomer();
        const res = await create({ userId: String(user._id), tier: 'home_garage', interval: 'month', homeAddress: CHELSEA });
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('UPDATE_REQUIRED');
        expect(res.body.message).toBe(
            'Permanent valet at this address is $525 a month. Update the Valet Network app to subscribe.'
        );
    });

    it('refuses Valet anywhere to a new subscriber', async () => {
        stripeClient.set(stripeStub());
        const user = await makeCustomer();
        const res = await create({ userId: String(user._id), tier: 'valet_anywhere', interval: 'month' });
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('NOT_ON_SALE');
    });

    it('refuses an address it does not cover', async () => {
        stripeClient.set(stripeStub());
        const user = await makeCustomer();
        const res = await create({
            userId: String(user._id),
            tier: 'home_garage',
            interval: 'month',
            homeAddress: FORDHAM,
            expectedAmountCents: 30000,
        });
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('NOT_OFFERED');
    });
});

// ---------------------------------------------------------------------------
// Stripe prices, one per amount
// ---------------------------------------------------------------------------

describe('Stripe prices for neighborhood amounts', () => {
    it('mints a price the first time an amount is sold and reuses it after', async () => {
        const stub = stripeStub();
        stripeClient.set(stub);
        const a = await prices.ensureGaragePriceId('month', 52500);
        const b = await prices.ensureGaragePriceId('month', 52500);
        expect(a).toBe(b);
        expect(stub.prices.create).toHaveBeenCalledTimes(1);
        expect(stub.prices.create.mock.calls[0][0]).toMatchObject({
            unit_amount: 52500,
            recurring: { interval: 'month' },
            lookup_key: 'vn_home_garage_month_c52500',
            product: 'prod_garage',
        });
        prices.clearPriceCache();
        // A fresh process finds it by lookup key instead of minting again.
        expect(await prices.ensureGaragePriceId('month', 52500)).toBe(a);
        expect(stub.prices.create).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// Locked in, and moving
// ---------------------------------------------------------------------------

const subFor = (user, overrides = {}) =>
    Subscription.create({
        user: user._id,
        tier: 'home_garage',
        interval: 'month',
        status: 'active',
        amountCents: 25000,
        stripeSubscriptionId: `sub_t_${phoneSeq++}`,
        currentPeriodStart: NOW,
        currentPeriodEnd: new Date('2026-11-09T16:00:00Z'),
        homeAddress: CHELSEA,
        ...overrides,
    });

const newPriceSub = (user, overrides = {}) =>
    subFor(user, {
        amountCents: 52500,
        pricing: { model: 'neighborhood_v1', borough: 'Manhattan', neighborhood: 'Chelsea', listAmountCents: 52500 },
        ...overrides,
    });

describe('a subscriber sold before neighborhood pricing', () => {
    it('keeps its price on an address move, and says so', async () => {
        const stub = stripeStub();
        stripeClient.set(stub);
        const user = await makeCustomer();
        await subFor(user);

        const preview = mockRes();
        await subscriptionController.movePreview({ body: { userId: String(user._id), homeAddress: SOHO } }, preview);
        expect(preview.body.locked).toBe(true);
        expect(preview.body.priceChanges).toBe(false);
        expect(preview.body.note).toBe('Your price stays $250/mo.');

        const res = mockRes();
        await subscriptionController.updateSchedule({ body: { userId: String(user._id), homeAddress: SOHO } }, res);
        expect(res.statusCode).toBe(200);
        expect(stub.subscriptions.update).not.toHaveBeenCalled();
        const after = await Subscription.findOne({ user: user._id });
        expect(after.amountCents).toBe(25000);
        expect(after.homeAddress.streetAddress).toBe(SOHO.streetAddress);
    });

    it('keeps the old catalog price when it switches between weekly and monthly', async () => {
        const stub = stripeStub();
        stripeClient.set(stub);
        const user = await makeCustomer();
        await subFor(user);
        const res = mockRes();
        await subscriptionController.changePlan({ body: { userId: String(user._id), interval: 'week' } }, res);
        expect(res.statusCode).toBe(200);
        const after = await Subscription.findOne({ user: user._id });
        expect(after.amountCents).toBe(7500);
        expect(after.pricing && after.pricing.model).toBeFalsy();
    });
});

describe('a new subscriber who moves the fixed address', () => {
    it('sees the new price and when it starts before saving', async () => {
        stripeClient.set(stripeStub());
        const user = await makeCustomer();
        await newPriceSub(user);
        const res = mockRes();
        await subscriptionController.movePreview({ body: { userId: String(user._id), homeAddress: SOHO } }, res);
        expect(res.body.priceChanges).toBe(true);
        expect(res.body.priceLine).toEqual({
            label: 'Permanent valet in SoHo',
            amountCents: 77500,
            amount: '$775/mo',
        });
        expect(res.body.note).toBe('From your next bill on Nov 9. Until then you pay $525/mo.');
    });

    it('needs a client that showed the price, then pays it from the next bill', async () => {
        const stub = stripeStub();
        stripeClient.set(stub);
        const user = await makeCustomer();
        await newPriceSub(user);

        const old = mockRes();
        await subscriptionController.updateSchedule({ body: { userId: String(user._id), homeAddress: SOHO } }, old);
        expect(old.statusCode).toBe(400);
        expect(old.body.code).toBe('UPDATE_REQUIRED');

        const res = mockRes();
        await subscriptionController.updateSchedule(
            { body: { userId: String(user._id), homeAddress: SOHO, expectedAmountCents: 77500 } },
            res
        );
        expect(res.statusCode).toBe(200);
        expect(stub.subscriptions.update).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ proration_behavior: 'none' })
        );
        let after = await Subscription.findOne({ user: user._id });
        expect(after.amountCents).toBe(52500);
        expect(after.pendingAmountCents).toBe(77500);
        expect(after.pricing.neighborhood).toBe('SoHo');

        // The renewal is billed at it, and the mirror follows.
        subscriptionController.applyPendingAmount(after, { billing_reason: 'subscription_cycle' }, after.pendingAmountFrom);
        expect(after.amountCents).toBe(77500);
        expect(after.pendingAmountCents).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Redemption counts
// ---------------------------------------------------------------------------

describe('admin codes', () => {
    it('count a redemption once per subscription, however often it activates', async () => {
        await PromoCode.create({ code: 'SAVE20', kind: 'percent_off', percentOff: 20 });
        const user = await makeCustomer();
        const sub = await newPriceSub(user, { status: 'incomplete', promoCode: 'SAVE20' });
        await subscriptionController.activateLocal(sub, { id: 'in_1', amount_paid: 42000 }, null);
        await subscriptionController.activateLocal(sub, { id: 'in_1', amount_paid: 42000 }, null);
        expect((await PromoCode.findOne({ code: 'SAVE20' })).redemptions).toBe(1);
    });

    it('stop being found once they are used up', async () => {
        const { findPromo } = require('../services/subscriptionPromos');
        await PromoCode.create({ code: 'ONCE', kind: 'percent_off', percentOff: 10, maxRedemptions: 1, redemptions: 1 });
        expect(await findPromo('ONCE')).toBeNull();
    });
});
