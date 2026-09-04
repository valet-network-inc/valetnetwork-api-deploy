/**
 * A park booked for a later day must not spend today's free park.
 *
 * Run: npx jest futureParkBurnsFreePark
 *
 * The fault: freeParksUsedToday counted covered parks from NY midnight with no
 * upper bound. Book a park for next Friday on a $250/$300 plan — it is covered,
 * $0, pickUpTime Friday — and from that moment every day in between reported
 * the free park as used. The quote told the customer "your plan gives one free
 * park a day and today's is used", the home screen dropped the free-park flag,
 * and createOrder billed $10 for a park the plan already pays for. Four days
 * between booking and pickup was $40 taken off a customer who owed nothing.
 *
 * Style matches coveredParkPricing.test.js: mongodb-memory-server, controllers
 * called directly with hand-rolled req/res/io doubles, no Stripe key in env.
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
delete process.env.STRIPE_API_KEY;

const Order = require('../models/Order');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const PricingConfig = require('../models/PricingConfig');

const quoteController = require('../controllers/quoteController');
const orderController = require('../controllers/orderController');
const subscriptionService = require('../services/subscriptionService');

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
    await Promise.all([
        Order.deleteMany({}),
        Subscription.deleteMany({}),
        User.deleteMany({}),
        PricingConfig.deleteMany({}),
    ]);
});

// ---------------------------------------------------------------------------
// Doubles + factories
// ---------------------------------------------------------------------------

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

const mockIo = () => {
    const io = { emits: [] };
    io.emit = (event, payload) => io.emits.push({ room: null, event, payload });
    io.to = (room) => ({
        emit: (event, payload) => io.emits.push({ room, event, payload }),
    });
    return io;
};

let phoneSeq = 5591000;
const makeCustomer = async () =>
    User.create({
        phone: `+1917${phoneSeq++}`,
        verified: true,
        firstName: 'Advance',
        lastName: 'Booker',
    });

const SPOT = { lat: 40.679, lng: -73.995, streetAddress: '123 Court St, Brooklyn' };

// valet_anywhere ($300): the free daily park works anywhere, so nothing in
// these tests turns on the home-radius check.
const makeSub = async (user) =>
    Subscription.create({
        user: user._id,
        tier: 'valet_anywhere',
        interval: 'month',
        status: 'active',
        amountCents: 30000,
        stripeSubscriptionId: `sub_test_${phoneSeq++}`,
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        homeAddress: SPOT,
    });

const DAY_MS = 24 * 60 * 60 * 1000;

const quote = async (user) => {
    const res = mockRes();
    await quoteController.quoteOrder(
        {
            body: {
                userId: user._id.toString(),
                orderType: 'parking',
                serviceType: 'standard',
                duration: 120,
                lat: SPOT.lat,
                lng: SPOT.lng,
            },
        },
        res
    );
    return res;
};

const book = async (user, sub, pickUpTime) => {
    const req = {
        body: {
            customer: user._id.toString(),
            customerLocation: SPOT,
            duration: 120,
            pickUpTime: new Date(pickUpTime).toISOString(),
            totalAmount: 1000,
            orderType: 'parking',
            serviceType: 'standard',
            paymentMethod: 'card',
        },
        io: mockIo(),
        subscription: sub,
        user,
    };
    const res = mockRes();
    await orderController.createOrder(req, res);
    return res;
};

// ---------------------------------------------------------------------------

describe("a park booked for a later day and today's free park", () => {
    it('booking next Friday still leaves today free: quote, charge and status all say so', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);

        // Sunday: book the park for four days out. Covered, $0.
        const friday = await book(user, sub, Date.now() + 4 * DAY_MS);
        expect(friday.body.order.totalAmount).toBe(0);
        expect(friday.body.order.coveredBySubscription).toBeTruthy();

        // Nothing has been parked today, so nothing has been spent today.
        expect(await subscriptionService.freeParksUsedToday(sub)).toBe(0);

        // What the review screen is told before the customer commits.
        const quoted = await quote(user);
        expect(quoted.body.reason).not.toBe('daily_free_park_used');
        expect(quoted.body.covered).toBe(true);
        expect(quoted.body.priceCents).toBe(0);

        // What the home screen renders.
        const status = await subscriptionService.buildStatusPayload(sub);
        expect(status.freeParkAvailableToday).toBe(true);

        // And what actually gets charged.
        const today = await book(user, sub, Date.now() + 60 * 1000);
        expect(today.body.order.totalAmount).toBe(0);
        expect(today.body.order.paymentStatus).toBe('paid');
    });

    it('the scheduled park still spends the free park on the day it happens', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);

        const pickUp = Date.now() + 4 * DAY_MS;
        await book(user, sub, pickUp);

        // Standing on that Friday: the plan's one free park for the day is the
        // one already booked, so a second park that day is per-use.
        expect(await subscriptionService.freeParksUsedToday(sub, new Date(pickUp))).toBe(1);
        const coverage = await subscriptionService.evaluateParkCoverage(
            sub,
            { aspMode: false, lat: SPOT.lat, lng: SPOT.lng, listPriceCents: 1000 },
            new Date(pickUp)
        );
        expect(coverage.covered).toBe(false);
        expect(coverage.reason).toBe('daily_free_park_used');
    });

    it("a park taken today still spends today's free park", async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);

        await Order.create({
            customer: user._id,
            customerLocation: SPOT,
            paymentMethod: 'card',
            duration: 120,
            pickUpTime: new Date(),
            totalAmount: 0,
            status: 'completed',
            paymentStatus: 'paid',
            orderType: 'parking',
            coveredBySubscription: sub._id,
            listPriceCents: 1000,
        });

        expect(await subscriptionService.freeParksUsedToday(sub)).toBe(1);
        const quoted = await quote(user);
        expect(quoted.body.covered).toBe(false);
        expect(quoted.body.reason).toBe('daily_free_park_used');
        expect(quoted.body.priceCents).toBe(1000);
    });
});
