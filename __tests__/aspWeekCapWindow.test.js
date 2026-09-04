/**
 * A sweep move booked for NEXT week must not spend THIS week's covered moves.
 *
 * Run: npx jest aspWeekCapWindow
 *
 * /park lets a subscriber pick a street-cleaning move up to 8 days out, and the
 * order is stamped `coveredBySubscription` the moment it is booked. The weekly
 * tally counted every covered ASP order with `pickUpTime >= this NY Monday` and
 * nothing on the top end, so that one future booking read as a move already
 * spent in every week between now and its pickup date.
 *
 * Two live consequences, both pinned below:
 *   - the customer is told their plan is out of moves and pays $15 for a move
 *     they still had;
 *   - the auto-sweep booker (services/subscriptionScheduler.js) sees the cap
 *     reached and books nothing on their cleaning day — silently, no push and
 *     no credit — so the car sits on the block for a $65 ticket.
 *
 * Harness follows coveredParkPricing.test.js: mongodb-memory-server, the
 * service called directly. No controller, so no io/firebase doubles needed.
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
delete process.env.STRIPE_API_KEY;

const Order = require('../models/Order');
const Subscription = require('../models/Subscription');
const User = require('../models/User');

const subscriptionService = require('../services/subscriptionService');
const { nyStartOfWeek } = require('../services/nyTime');

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
});

afterEach(async () => {
    await Promise.all([Order.deleteMany({}), Subscription.deleteMany({}), User.deleteMany({})]);
});

const HOME = { lat: 40.679, lng: -73.995, streetAddress: '123 Court St, Brooklyn' };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// A Wednesday afternoon in NY. Fixed so the week boundaries the assertions lean
// on cannot move with the calendar.
const NOW = new Date('2026-09-09T19:00:00Z');
const WEEK_START = nyStartOfWeek(NOW);

let phoneSeq = 5590000;

const makeCustomer = () =>
    User.create({
        phone: `+1917${phoneSeq++}`,
        verified: true,
        firstName: 'Sweep',
        lastName: 'Tester',
    });

// One covered move a week — the $50/mo plan, where a single miscount is the
// difference between covered and charged.
const makeSub = (user, overrides = {}) =>
    Subscription.create({
        user: user._id,
        tier: 'street_cleaning',
        interval: 'month',
        status: 'active',
        amountCents: 5000,
        movesPerWeek: 1,
        stripeSubscriptionId: `sub_test_${phoneSeq++}`,
        currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY),
        aspSchedule: {
            address: HOME,
            days: [{ weekday: 4, hour: 8, minute: 30 }],
            source: 'onboarding',
        },
        ...overrides,
    });

const coveredAspOrder = (user, sub, pickUpTime) =>
    Order.create({
        customer: user._id,
        customerLocation: HOME,
        paymentMethod: 'card',
        duration: 120,
        pickUpTime,
        totalAmount: 0,
        status: 'pending',
        paymentStatus: 'paid',
        orderType: 'parking',
        aspMode: true,
        coveredBySubscription: sub._id,
        listPriceCents: 1500,
    });

const askCoverage = (sub) =>
    subscriptionService.evaluateParkCoverage(
        sub,
        { aspMode: true, lat: HOME.lat, lng: HOME.lng, listPriceCents: 1500 },
        NOW
    );

describe('weekly covered-move tally is bounded to the week it is asked about', () => {
    it('a move booked for next Tuesday leaves this week untouched', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        // 8 days out — the far end of what /park offers.
        await coveredAspOrder(user, sub, new Date(WEEK_START.getTime() + 8 * DAY + 9 * HOUR));

        expect(await subscriptionService.aspMovesUsedThisWeek(sub, NOW)).toBe(0);

        const coverage = await askCoverage(sub);
        expect(coverage.covered).toBe(true);
        expect(coverage.reason).toBe('asp_move_covered');
    });

    it('the app counter the customer reads stays at zero too', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        await coveredAspOrder(user, sub, new Date(WEEK_START.getTime() + 8 * DAY + 9 * HOUR));

        const status = await subscriptionService.buildStatusPayload(sub, NOW);
        expect(status.aspMovesUsedThisWeek).toBe(0);
    });

    it('that same move does count once its own week arrives', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        const pickUp = new Date(WEEK_START.getTime() + 8 * DAY + 9 * HOUR);
        await coveredAspOrder(user, sub, pickUp);

        const nextWeek = new Date(WEEK_START.getTime() + 9 * DAY);
        expect(await subscriptionService.aspMovesUsedThisWeek(sub, nextWeek)).toBe(1);

        const coverage = await subscriptionService.evaluateParkCoverage(
            sub,
            { aspMode: true, lat: HOME.lat, lng: HOME.lng, listPriceCents: 1500 },
            nextWeek
        );
        expect(coverage.covered).toBe(false);
        expect(coverage.reason).toBe('weekly_asp_limit_reached');
    });

    it('a move already taken THIS week still spends the cap', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        // Monday morning, before `NOW`.
        await coveredAspOrder(user, sub, new Date(WEEK_START.getTime() + 8 * HOUR));

        expect(await subscriptionService.aspMovesUsedThisWeek(sub, NOW)).toBe(1);
        const coverage = await askCoverage(sub);
        expect(coverage.covered).toBe(false);
        expect(coverage.reason).toBe('weekly_asp_limit_reached');
    });

    it('last week\'s move is not counted either', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        await coveredAspOrder(user, sub, new Date(WEEK_START.getTime() - 2 * DAY));

        expect(await subscriptionService.aspMovesUsedThisWeek(sub, NOW)).toBe(0);
    });

    /**
     * The window was half the mistake. The other half was the INSTANT it was
     * measured from: both callers asked "how many has she used THIS week?"
     * even when booking a move for a different week. A sweep just after
     * midnight on Monday is booked ~45 minutes earlier on Sunday, so the cap
     * was read against the wrong week in both directions — refusing a move the
     * plan still owed, and letting a second one through free.
     */
    it('a move next week is still covered when this week is already full', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user, { movesPerWeek: 1 });

        // This week's one covered move is spent.
        await coveredAspOrder(user, sub, new Date(WEEK_START.getTime() + 2 * DAY + 9 * HOUR));
        expect(await subscriptionService.aspMovesUsedThisWeek(sub, NOW)).toBe(1);

        const nextWeekSweep = new Date(WEEK_START.getTime() + 8 * DAY + 9 * HOUR);
        const coverage = await subscriptionService.evaluateParkCoverage(
            sub,
            { aspMode: true, lat: HOME.lat, lng: HOME.lng, listPriceCents: 1500 },
            nextWeekSweep
        );

        expect(coverage.covered).toBe(true);
        expect(coverage.reason).toBe('asp_move_covered');
    });
});
