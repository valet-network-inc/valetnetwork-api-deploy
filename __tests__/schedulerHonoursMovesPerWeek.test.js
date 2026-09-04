/**
 * The auto-sweep scheduler must cap on the plan the customer BOUGHT.
 *
 * Run: npx jest schedulerHonoursMovesPerWeek
 *
 * street_cleaning is sold in two sizes: one covered move a week ($15/wk, $50/mo,
 * and the HANDSFREE promo) or two. `Subscription.movesPerWeek` is that Stripe
 * quantity. The /park path gates on it (evaluateParkCoverage), but the scheduler
 * gated on the module constant ASP_MOVES_PER_WEEK (2), so the same plan carried
 * two different weekly limits.
 *
 * What that cost, live: a 1-move subscriber books their move on Monday — quota
 * spent — and on their cleaning day the tick still sees 1 < 2, books a second $0
 * covered move and dispatches a valet for it. Valet pay falls back to
 * listPriceCents on a $0 order at 70%, so ~$10.50 out the door for that move,
 * plus the +1.5h auto-return leg, every week they do it. Saving two cleaning days
 * on the free schedule screen (which has no plan cap) reaches it with no manual
 * booking at all.
 *
 * Harness follows aspWeekCapWindow.test.js / subscriptionsV2.test.js:
 * mongodb-memory-server, scheduler.tick() driven directly with an io double and
 * a no-op notify, so no push or dispatch leaves the process.
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
delete process.env.STRIPE_API_KEY;

const Order = require('../models/Order');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const PricingConfig = require('../models/PricingConfig');

const scheduler = require('../services/subscriptionScheduler');
const nyTime = require('../services/nyTime');

let mongod;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    // The scheduler leans on the unique sparse autoBookKey index.
    await Order.init();
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

const HOME = { lat: 40.679, lng: -73.995, streetAddress: '123 Court St, Brooklyn' };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const mockIo = () => {
    const io = { emits: [] };
    io.emit = (event, payload) => io.emits.push({ room: null, event, payload });
    io.to = (room) => ({
        emit: (event, payload) => io.emits.push({ room, event, payload }),
    });
    return io;
};

// A Thursday 8:30 AM NY sweep, with `now` sitting inside the firing window.
const THU_830 = { weekday: 4, hour: 8, minute: 30 };
const OCCURRENCE = nyTime.nextNyOccurrence(THU_830, new Date('2026-09-07T12:00:00Z'));
const IN_WINDOW = new Date(OCCURRENCE.getTime() - 20 * 60 * 1000);
const WEEK_START = nyTime.nyStartOfWeek(IN_WINDOW);

let phoneSeq = 5570000;

const makeCustomer = () =>
    User.create({
        phone: `+1917${phoneSeq++}`,
        verified: true,
        firstName: 'Sweep',
        lastName: 'Tester',
    });

const makeSub = (user, overrides = {}) =>
    Subscription.create({
        user: user._id,
        tier: 'street_cleaning',
        interval: 'month',
        status: 'active',
        amountCents: 5000,
        movesPerWeek: 1,
        stripeSubscriptionId: `sub_test_${phoneSeq++}`,
        currentPeriodEnd: new Date(IN_WINDOW.getTime() + 20 * DAY),
        aspSchedule: {
            address: HOME,
            days: [THU_830],
            source: 'onboarding',
        },
        ...overrides,
    });

// A covered move already taken earlier in the same NY week. `completed` so the
// live-order guard does not short-circuit the tick before it reaches the cap.
const usedMove = (user, sub, at) =>
    Order.create({
        customer: user._id,
        customerLocation: HOME,
        paymentMethod: 'card',
        duration: 90,
        pickUpTime: at,
        totalAmount: 0,
        status: 'completed',
        paymentStatus: 'paid',
        orderType: 'parking',
        aspMode: true,
        coveredBySubscription: sub._id,
        listPriceCents: 1500,
    });

const runTick = () => scheduler.tick({ io: mockIo(), now: IN_WINDOW, notify: async () => {} });

describe('auto-sweep scheduler caps on the plan the customer bought', () => {
    it('a 1-move plan that already used its move gets no free second one', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        await usedMove(user, sub, new Date(WEEK_START.getTime() + 8 * HOUR));

        const results = await runTick();

        expect(results.filter((r) => r.outcome === 'weekly_cap_reached')).toHaveLength(1);
        expect(results.filter((r) => r.outcome === 'booked')).toHaveLength(0);
        // Nothing auto-booked means no valet dispatched and no $0 order minted.
        expect(await Order.countDocuments({ autoBookKey: { $exists: true } })).toBe(0);
    });

    it('a 1-move plan with nothing used yet still gets its move', async () => {
        const user = await makeCustomer();
        await makeSub(user);

        const results = await runTick();

        expect(results.filter((r) => r.outcome === 'booked')).toHaveLength(1);
    });

    it('the 2-move plan is untouched: one used, the second still books', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user, { movesPerWeek: 2, amountCents: 10000 });
        await usedMove(user, sub, new Date(WEEK_START.getTime() + 8 * HOUR));

        const results = await runTick();

        expect(results.filter((r) => r.outcome === 'booked')).toHaveLength(1);
    });

    it('a legacy doc with no movesPerWeek still falls back to two', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        // Documents written before movesPerWeek existed have no such field.
        await Subscription.updateOne({ _id: sub._id }, { $unset: { movesPerWeek: '' } });
        await usedMove(user, sub, new Date(WEEK_START.getTime() + 8 * HOUR));

        const results = await runTick();

        expect(results.filter((r) => r.outcome === 'booked')).toHaveLength(1);
    });
});
