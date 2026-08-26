/**
 * Subscribers tab data — GET /api/admin/subscriptions.
 *
 * Run: npx jest adminSubscriptions
 *
 * The point of these is the arithmetic the console shows as fact: MRR across
 * two billing intervals, trial plans kept out of it, legacy pre-v2 docs kept
 * out of every count, and the covered-order / credit joins.
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
delete process.env.STRIPE_API_KEY;

const Subscription = require('../models/Subscription');
const User = require('../models/User');
const Order = require('../models/Order');
const AspCredit = require('../models/AspCredit');
const adminSubscriptionController = require('../controllers/adminSubscriptionController');

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
        Subscription.deleteMany({}),
        User.deleteMany({}),
        Order.deleteMany({}),
        AspCredit.deleteMany({}),
    ]);
});

const mockRes = () => {
    const res = { statusCode: 0, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
};

let seq = 6000000;
const makeCustomer = (overrides = {}) =>
    User.create({
        phone: `+1917${seq++}`,
        verified: true,
        firstName: 'Sub',
        lastName: 'Scriber',
        ...overrides,
    });

const makeSub = (user, overrides = {}) =>
    Subscription.create({
        user: user._id,
        tier: 'street_cleaning',
        interval: 'month',
        status: 'active',
        amountCents: 10000,
        stripeSubscriptionId: `sub_admin_${seq++}`,
        ...overrides,
    });

const load = async () => {
    const res = mockRes();
    await adminSubscriptionController.getSubscriptionOverview({ query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    return res.body.data;
};

const DAY = 24 * 60 * 60 * 1000;

describe('admin subscriptions overview', () => {
    it('returns an empty, zeroed shape when nobody has subscribed', async () => {
        const data = await load();
        expect(data.rows).toEqual([]);
        expect(data.summary.total).toBe(0);
        expect(data.summary.mrrCents).toBe(0);
        expect(data.summary.byTier).toHaveLength(3);
        expect(data.summary.growth).toHaveLength(6);
        // Buckets end on the New York month. Render runs UTC, so on the 1st
        // between midnight and 4am the server's own month is already the next
        // one and the strip would show a month New York has not reached.
        const nyMonth = require('../services/nyTime').nyDateKey(new Date()).slice(0, 7);
        expect(data.summary.growth[5].month).toBe(nyMonth);
    });

    it('normalises weekly plans to a monthly figure before adding them up', async () => {
        const a = await makeCustomer();
        const b = await makeCustomer();
        await makeSub(a, { interval: 'month', amountCents: 10000 });
        await makeSub(b, { interval: 'week', amountCents: 3000, tier: 'street_cleaning' });

        const data = await load();
        // $30/wk is $130/mo at 52/12, not $120 — four-week months undercount.
        expect(data.summary.mrrCents).toBe(10000 + 13000);
        expect(data.summary.arrCents).toBe((10000 + 13000) * 12);
        expect(data.summary.byInterval).toEqual({ week: 1, month: 1 });
    });

    it('keeps trial plans out of MRR and reports them on their own', async () => {
        const paying = await makeCustomer();
        const trial = await makeCustomer();
        await makeSub(paying, { amountCents: 25000, tier: 'home_garage' });
        await makeSub(trial, {
            amountCents: 5000,
            promoCode: 'HANDSFREE',
            trialEndsAt: new Date(Date.now() + 20 * DAY),
        });

        const data = await load();
        expect(data.summary.active).toBe(2);
        expect(data.summary.trialing).toBe(1);
        expect(data.summary.mrrCents).toBe(25000);
        expect(data.summary.trialMrrCents).toBe(5000);

        const trialRow = data.rows.find((r) => r.promoCode === 'HANDSFREE');
        expect(trialRow.inTrial).toBe(true);
    });

    it('counts only active plans as MRR — past_due and cancelled do not bill', async () => {
        const good = await makeCustomer();
        const late = await makeCustomer();
        const gone = await makeCustomer();
        await makeSub(good, { amountCents: 10000 });
        await makeSub(late, { amountCents: 30000, status: 'past_due' });
        await makeSub(gone, { amountCents: 30000, status: 'cancelled', cancelledAt: new Date() });

        const data = await load();
        expect(data.summary.mrrCents).toBe(10000);
        expect(data.summary.active).toBe(1);
        expect(data.summary.live).toBe(2);
        expect(data.summary.pastDue).toBe(1);
        expect(data.summary.cancelled).toBe(1);
        expect(data.summary.cancelledLast30).toBe(1);
    });

    it('flags pre-v2 docs as legacy and leaves them out of the counts', async () => {
        const ghost = await makeCustomer();
        // Written the way the old doorman-referral schema left them: no status.
        await Subscription.collection.insertOne({
            user: ghost._id,
            subscriptionType: 'Standard',
            amountCents: 9900,
        });
        const real = await makeCustomer();
        await makeSub(real, { amountCents: 10000 });

        const data = await load();
        expect(data.summary.total).toBe(2);
        expect(data.summary.legacy).toBe(1);
        expect(data.summary.active).toBe(1);
        expect(data.summary.incomplete).toBe(0);
        expect(data.summary.mrrCents).toBe(10000);

        const legacyRow = data.rows.find((r) => r.legacy);
        expect(legacyRow.status).toBe('legacy');
        expect(legacyRow.monthlyEquivalentCents).toBe(0);
    });

    it('joins the customer, the covered orders and the suspension credits onto the row', async () => {
        const user = await makeCustomer({ firstName: 'Dana', lastName: 'Ruiz' });
        const sub = await makeSub(user, {
            amountCents: 10000,
            payments: [
                { invoiceId: 'in_1', amountCents: 10000, paidAt: new Date(Date.now() - 40 * DAY) },
                { invoiceId: 'in_2', amountCents: 10000, paidAt: new Date(Date.now() - 3 * DAY) },
            ],
        });

        const orderBase = {
            customer: user._id,
            customerLocation: { streetAddress: '1 Court St, Brooklyn', lat: 40.69, lng: -73.99 },
            pickUpTime: new Date(),
            duration: 60,
            totalAmount: 0,
            paymentMethod: 'card',
        };
        await Order.create([
            { ...orderBase, coveredBySubscription: sub._id, listPriceCents: 2500 },
            { ...orderBase, coveredBySubscription: sub._id, listPriceCents: 2500 },
        ]);
        await AspCredit.create([
            { subscription: sub._id, user: user._id, date: '2026-07-04', amountCents: 1200, reason: 'suspension', stripeStatus: 'applied' },
            { subscription: sub._id, user: user._id, date: '2026-07-05', amountCents: 1200, reason: 'suspension', stripeStatus: 'failed' },
        ]);

        const data = await load();
        const row = data.rows[0];
        expect(row.name).toBe('Dana Ruiz');
        expect(row.phone).toBe(user.phone);
        expect(row.tierName).toBe('Street cleaning moves');
        expect(row.coveredOrders).toBe(2);
        expect(row.coveredValueCents).toBe(5000);
        // A failed credit is money that never moved, so it is not counted.
        expect(row.creditedCents).toBe(1200);
        expect(row.creditedDays).toBe(1);
        expect(row.paidCents).toBe(20000);
        expect(row.paymentsCount).toBe(2);

        expect(data.summary.lifetimeRevenueCents).toBe(20000);
        // Only the invoice inside the window counts toward last-30 revenue,
        // even though the plan itself is older than that.
        expect(data.summary.revenueLast30Cents).toBe(10000);
        expect(data.summary.coveredOrders).toBe(2);
        expect(data.summary.creditedCents).toBe(1200);
    });

    it('breaks MRR down by tier', async () => {
        const a = await makeCustomer();
        const b = await makeCustomer();
        const c = await makeCustomer();
        await makeSub(a, { tier: 'street_cleaning', amountCents: 10000 });
        await makeSub(b, { tier: 'home_garage', amountCents: 25000 });
        await makeSub(c, { tier: 'valet_anywhere', interval: 'week', amountCents: 9000 });

        const data = await load();
        const byTier = Object.fromEntries(data.summary.byTier.map((t) => [t.tier, t]));
        expect(byTier.street_cleaning.mrrCents).toBe(10000);
        expect(byTier.home_garage.mrrCents).toBe(25000);
        expect(byTier.valet_anywhere.mrrCents).toBe(39000);
        expect(data.summary.byTier.map((t) => t.tier)).toEqual([
            'street_cleaning', 'home_garage', 'valet_anywhere',
        ]);
    });

    it('counts a pending cancellation without treating it as gone yet', async () => {
        const user = await makeCustomer();
        await makeSub(user, { amountCents: 10000, cancelAtPeriodEnd: true });

        const data = await load();
        expect(data.summary.active).toBe(1);
        expect(data.summary.cancelAtPeriodEnd).toBe(1);
        expect(data.summary.mrrCents).toBe(10000);
    });
});

/* -------------------------------------------------------------------------- */
/* The cleaning day, which is the thing an operator actually dispatches on      */
/* -------------------------------------------------------------------------- */

describe('the cleaning day on a subscriber row', () => {
    const TUE = [{ weekday: 2, hour: 11, minute: 30 }];
    const THU = [{ weekday: 4, hour: 9, minute: 0 }];

    it('reads the customer\'s own schedule, which is what the scheduler books off', async () => {
        const user = await makeCustomer({
            cleaningSchedule: {
                days: TUE,
                status: 'active',
                source: 'subscription',
                address: { streetAddress: '264 President St, Brooklyn, NY 11231' },
            },
        });
        await makeSub(user, { aspSchedule: { days: TUE } });

        const [row] = (await load()).rows;
        expect(row.cleaning.hasSchedule).toBe(true);
        expect(row.cleaning.shortLabel).toBe('Tue 11:30 AM');
        expect(row.cleaning.label).toBe('Tuesdays at 11:30 AM');
        expect(row.cleaning.from).toBe('customer');
        expect(row.cleaning.address).toContain('264 President St');
        expect(row.cleaning.next).toBeTruthy();
        expect(row.cleaning.matchesPlan).toBe(true);
    });

    it('falls back to the plan\'s own copy for a customer with no home schedule', async () => {
        const user = await makeCustomer();
        await makeSub(user, { aspSchedule: { days: THU } });

        const [row] = (await load()).rows;
        expect(row.cleaning.shortLabel).toBe('Thu 9:00 AM');
        expect(row.cleaning.from).toBe('subscription');
        // Nothing to compare against, so no false alarm.
        expect(row.cleaning.matchesPlan).toBeNull();
    });

    it('flags a plan and a home schedule that have drifted apart', async () => {
        const user = await makeCustomer({ cleaningSchedule: { days: TUE, status: 'active' } });
        await makeSub(user, { aspSchedule: { days: [...TUE, ...THU] } });

        const [row] = (await load()).rows;
        expect(row.cleaning.shortLabel).toBe('Tue 11:30 AM');
        expect(row.cleaning.matchesPlan).toBe(false);
        expect(row.cleaning.planLabel).toBe('Tue 11:30 AM · Thu 9:00 AM');
    });

    it('shows a paused schedule as paused — nothing gets booked while it is', async () => {
        const user = await makeCustomer({
            cleaningSchedule: { days: TUE, status: 'paused', pausedUntil: null },
        });
        await makeSub(user, { aspSchedule: { days: TUE } });

        const [row] = (await load()).rows;
        expect(row.cleaning.active).toBe(false);
        expect(row.cleaning.status).toBe('paused');
    });

    it('says so plainly when there is no schedule anywhere', async () => {
        const user = await makeCustomer();
        await makeSub(user);

        const [row] = (await load()).rows;
        expect(row.cleaning).toMatchObject({ hasSchedule: false, next: null });
        expect(row.cleaning.from).toBeNull();
    });

    it('stamps New York\'s date so the tab can say "today" without guessing', async () => {
        const data = await load();
        expect(data.todayKey).toBe(require('../services/nyTime').nyDateKey(new Date()));
    });
});
