/**
 * What a plan customer is TOLD a booking costs, and what extending a covered
 * park costs.
 *
 * Run: npx jest coveredParkPricing
 *
 * Two faults are pinned here.
 *
 *   The quote was a lie. Both clients priced a booking locally and neither knew
 *   what a plan covers, so the review screen offered a customer paying $250 a
 *   month a button reading "Pay & park · $10.00" for a park their plan pays
 *   for. POST /api/subscription/quote answers that before they commit, through
 *   the same evaluateParkCoverage the booking path calls — so the tests that
 *   matter most in this file are the ones checking the quote and the charge
 *   agree.
 *
 *   "Add more time" was a real charge. extensionController had no reference to
 *   subscriptions and billed $5 for the first extra hour on a car we are
 *   already holding under a flat monthly fee.
 *
 * Style matches subscriptionsV2.test.js: mongodb-memory-server, controllers
 * called directly with hand-rolled req/res doubles, no Stripe key in env. That
 * last part does double duty here — with `stripe` null, any path that reaches
 * Stripe answers 500, so a covered extension coming back 200 is proof it never
 * went near a PaymentIntent.
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
const extensionController = require('../controllers/extensionController');
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

let phoneSeq = 5570000;
const makeCustomer = async (overrides = {}) =>
    User.create({
        phone: `+1917${phoneSeq++}`,
        verified: true,
        firstName: 'Quote',
        lastName: 'Tester',
        ...overrides,
    });

const HOME = { lat: 40.679, lng: -73.995, streetAddress: '123 Court St, Brooklyn' };
// ~400 m north of HOME: outside the 250 m home radius, close enough that the
// refusal has to be worded in blocks rather than "miles away".
const FOUR_HUNDRED_M = { lat: 40.6826, lng: -73.995, streetAddress: '5 blocks up' };
const AWAY = { lat: 40.72, lng: -73.957, streetAddress: '99 Elsewhere Ave, Brooklyn' };

const makeSub = async (user, overrides = {}) =>
    Subscription.create({
        user: user._id,
        tier: 'home_garage',
        interval: 'month',
        status: 'active',
        amountCents: 25000,
        stripeSubscriptionId: `sub_test_${phoneSeq++}`,
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        aspSchedule: {
            address: HOME,
            days: [{ weekday: 2, hour: 9, minute: 0 }],
            source: 'onboarding',
        },
        homeAddress: HOME,
        ...overrides,
    });

const quote = async (body) => {
    const res = mockRes();
    await quoteController.quoteOrder({ body }, res);
    return res;
};

// The shape a booking screen sends: where the pin is, what service, how long.
const parkQuote = (user, overrides = {}) => ({
    userId: user._id.toString(),
    orderType: 'parking',
    serviceType: 'standard',
    duration: 120,
    lat: HOME.lat,
    lng: HOME.lng,
    ...overrides,
});

const createOrderVia = async (user, body, subscription = null) => {
    const req = {
        body: { customer: user._id.toString(), ...body },
        io: mockIo(),
        subscription,
        user,
    };
    const res = mockRes();
    await orderController.createOrder(req, res);
    return res;
};

const parkBody = (overrides = {}) => ({
    customerLocation: HOME,
    duration: 120,
    pickUpTime: new Date().toISOString(),
    totalAmount: 1000,
    orderType: 'parking',
    serviceType: 'standard',
    ...overrides,
});

// A park already on the books, priced the way the coverage engine prices one.
const coveredParkOrder = async (user, sub, overrides = {}) =>
    Order.create({
        customer: user._id,
        customerLocation: HOME,
        paymentMethod: 'card',
        duration: 120,
        pickUpTime: new Date(),
        totalAmount: 0,
        status: 'parked',
        paymentStatus: 'paid',
        orderType: 'parking',
        coveredBySubscription: sub._id,
        listPriceCents: 1000,
        ...overrides,
    });

const paidParkOrder = async (user, overrides = {}) =>
    Order.create({
        customer: user._id,
        customerLocation: HOME,
        paymentMethod: 'card',
        duration: 120,
        pickUpTime: new Date(),
        totalAmount: 1000,
        status: 'parked',
        paymentStatus: 'paid',
        orderType: 'parking',
        ...overrides,
    });

const extend = async (orderId, body = { additionalHours: 2 }) => {
    const res = mockRes();
    await extensionController.createExtensionIntent(
        { params: { orderId: String(orderId) }, body },
        res
    );
    return res;
};

const confirmExtend = async (orderId, body = {}) => {
    const res = mockRes();
    await extensionController.confirmExtension(
        { params: { orderId: String(orderId) }, body },
        res
    );
    return res;
};

// ---------------------------------------------------------------------------
// The quote, plan by plan
// ---------------------------------------------------------------------------

describe('POST /api/subscription/quote', () => {
    it('per-use customer: full price, and never a claim of coverage', async () => {
        const user = await makeCustomer();
        const res = await quote(parkQuote(user));

        expect(res.statusCode).toBe(200);
        expect(res.body.covered).toBe(false);
        expect(res.body.reason).toBe('no_active_subscription');
        expect(res.body.priceCents).toBe(1000);
        expect(res.body.listPriceCents).toBe(1000);
        expect(res.body.savedCents).toBe(0);
        expect(res.body.plan).toBeNull();
        expect(res.body.label).toBe('$10 to park');
    });

    it('home_garage at the home spot: free, and says so in words', async () => {
        const user = await makeCustomer();
        await makeSub(user);
        const res = await quote(parkQuote(user));

        expect(res.body.covered).toBe(true);
        expect(res.body.reason).toBe('daily_free_park');
        expect(res.body.priceCents).toBe(0);
        expect(res.body.listPriceCents).toBe(1000);
        expect(res.body.savedCents).toBe(1000);
        expect(res.body.label).toBe('Free with your plan');
        expect(res.body.detail).toBe('This is your free park for today. Tap Park — nothing to pay.');
        expect(res.body.plan).toEqual({
            tier: 'home_garage',
            name: 'Fixed garage',
            movesPerWeek: 2,
        });
    });

    it('the quote and the charge agree: quoted free → the order is $0 and paid', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);

        const quoted = await quote(parkQuote(user));
        expect(quoted.body.priceCents).toBe(0);

        const booked = await createOrderVia(user, parkBody(), sub);
        expect(booked.statusCode).toBe(201);
        expect(booked.body.order.totalAmount).toBe(0);
        expect(booked.body.order.paymentStatus).toBe('paid');
    });

    it('the quote and the charge agree: quoted $10 → the order is $10 and pending', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        // Today's free park is spent already.
        await coveredParkOrder(user, sub, { status: 'completed' });

        const quoted = await quote(parkQuote(user));
        expect(quoted.body.covered).toBe(false);
        expect(quoted.body.priceCents).toBe(1000);

        const booked = await createOrderVia(user, parkBody(), sub);
        expect(booked.statusCode).toBe(200);
        expect(booked.body.order.totalAmount).toBe(1000);
        expect(booked.body.order.paymentStatus).toBe('pending');
    });

    it("second park of the day: refused, and names today's free park as the reason", async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        await coveredParkOrder(user, sub, { status: 'completed' });

        const res = await quote(parkQuote(user));
        expect(res.body.reason).toBe('daily_free_park_used');
        expect(res.body.label).toBe("Not covered — today's free park is used");
        expect(res.body.detail).toContain('one free park a day');
        expect(res.body.detail).toContain('$10');
        expect(res.body.priceCents).toBe(1000);
        expect(res.body.savedCents).toBe(0);
    });

    it('home_garage 400 m from home: refused before they commit, distance in blocks', async () => {
        const user = await makeCustomer();
        await makeSub(user);
        const res = await quote(
            parkQuote(user, { lat: FOUR_HUNDRED_M.lat, lng: FOUR_HUNDRED_M.lng })
        );

        expect(res.body.covered).toBe(false);
        expect(res.body.reason).toBe('not_at_home_address');
        expect(res.body.label).toMatch(/^Not covered — about \d+ blocks from home$/);
        expect(res.body.detail).toContain('move the pin closer to home');
        expect(res.body.priceCents).toBe(1000);
    });

    it('valet_anywhere: the free park works away from home', async () => {
        const user = await makeCustomer();
        await makeSub(user, { tier: 'valet_anywhere', amountCents: 30000 });
        const res = await quote(parkQuote(user, { lat: AWAY.lat, lng: AWAY.lng }));

        expect(res.body.covered).toBe(true);
        expect(res.body.reason).toBe('daily_free_park');
        expect(res.body.priceCents).toBe(0);
    });

    it('home_garage with no pin: refused, and asks for the pin rather than guessing', async () => {
        const user = await makeCustomer();
        await makeSub(user);
        const res = await quote(parkQuote(user, { lat: undefined, lng: undefined }));

        expect(res.body.covered).toBe(false);
        expect(res.body.reason).toBe('order_location_missing');
        expect(res.body.detail).toContain('Drop the pin again');
        expect(res.body.priceCents).toBe(1000);
    });

    it('home_garage with no home spot saved: refused, and says what to add', async () => {
        const user = await makeCustomer();
        await makeSub(user, { homeAddress: undefined });
        const res = await quote(parkQuote(user));

        expect(res.body.reason).toBe('no_home_address_on_file');
        expect(res.body.detail).toContain('Add your home spot');
        expect(res.body.priceCents).toBe(1000);
    });

    it('street_cleaning: an ordinary park is full price, and the label says why', async () => {
        const user = await makeCustomer();
        await makeSub(user, { tier: 'street_cleaning', amountCents: 10000 });
        const res = await quote(parkQuote(user));

        expect(res.body.covered).toBe(false);
        expect(res.body.reason).toBe('tier_has_no_free_park');
        expect(res.body.priceCents).toBe(1000);
        expect(res.body.listPriceCents).toBe(1000);
    });

    it('street_cleaning: a sweep move is covered at the ASP list price', async () => {
        const user = await makeCustomer();
        await makeSub(user, { tier: 'street_cleaning', amountCents: 10000 });
        const res = await quote(
            parkQuote(user, { aspMode: true, serviceType: 'park-and-hold' })
        );

        expect(res.body.covered).toBe(true);
        expect(res.body.reason).toBe('asp_move_covered');
        expect(res.body.priceCents).toBe(0);
        expect(res.body.listPriceCents).toBe(1500);
        expect(res.body.savedCents).toBe(1500);
    });

    it('street_cleaning: the third sweep move this week is refused, in plain words', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user, { tier: 'street_cleaning', amountCents: 10000 });
        for (let i = 0; i < 2; i++) {
            await coveredParkOrder(user, sub, {
                status: 'completed',
                aspMode: true,
                duration: 90,
                listPriceCents: 1500,
            });
        }

        const res = await quote(
            parkQuote(user, { aspMode: true, serviceType: 'park-and-hold' })
        );
        expect(res.body.covered).toBe(false);
        expect(res.body.reason).toBe('weekly_asp_limit_reached');
        expect(res.body.label).toBe("Not covered — this week's moves are used");
        expect(res.body.detail).toContain('2 street cleaning moves a week');
        expect(res.body.detail).toContain('$15');
        expect(res.body.priceCents).toBe(1500);
    });

    it('Car Watch: refused, priced with the add-on, and says how to get the free park back', async () => {
        const user = await makeCustomer();
        await makeSub(user);
        const res = await quote(parkQuote(user, { carWatch: true }));

        expect(res.body.covered).toBe(false);
        expect(res.body.reason).toBe('car_watch_not_covered');
        // $10 park + 2h of Car Watch at $1/h — the same number createOrder charges.
        expect(res.body.priceCents).toBe(1200);
        expect(res.body.detail).toContain('Turn Car Watch off');
    });

    it('Car Watch: the quoted number is the number createOrder charges', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);

        const quoted = await quote(parkQuote(user, { carWatch: true }));
        const booked = await createOrderVia(
            user,
            parkBody({ carWatch: true, totalAmount: 1200 }),
            sub
        );
        expect(booked.body.order.totalAmount).toBe(quoted.body.priceCents);
    });

    it('a standalone retrieval is never covered, whatever the plan', async () => {
        const user = await makeCustomer();
        await makeSub(user, { tier: 'valet_anywhere', amountCents: 30000 });
        const res = await quote({ userId: user._id.toString(), orderType: 'retrieval' });

        expect(res.body.covered).toBe(false);
        expect(res.body.reason).toBe('retrieval_not_covered');
        expect(res.body.priceCents).toBe(500);
        expect(res.body.label).toBe('$5 to bring it back');
    });

    it('a retrieval against a park is already paid for — no price is shown', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        const park = await coveredParkOrder(user, sub);
        const res = await quote({
            userId: user._id.toString(),
            orderType: 'retrieval',
            originalOrderId: park._id.toString(),
        });

        expect(res.body.priceCents).toBe(0);
        expect(res.body.reason).toBe('retrieval_included_with_park');
        expect(res.body.covered).toBe(false); // paid at the park, not by the plan
        expect(res.body.savedCents).toBe(0);
        expect(res.body.label).toBe('Already paid');
    });

    it('a refusal never quotes a discount we will not give', async () => {
        // Every "not covered" answer has to charge the full list price. A
        // refusal that shaved the price would be the same lie as a free park
        // quoted at $10, pointed the other way.
        const user = await makeCustomer();
        await makeSub(user);
        const refusals = [
            parkQuote(user, { lat: AWAY.lat, lng: AWAY.lng }),
            parkQuote(user, { lat: undefined, lng: undefined }),
            parkQuote(user, { carWatch: true }),
        ];
        for (const body of refusals) {
            const res = await quote(body);
            expect(res.body.covered).toBe(false);
            expect(res.body.priceCents).toBe(res.body.listPriceCents);
            expect(res.body.savedCents).toBe(0);
        }
    });

    it('an expired plan is quoted as no plan at all', async () => {
        const user = await makeCustomer();
        await makeSub(user, {
            currentPeriodEnd: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        });
        const res = await quote(parkQuote(user));

        expect(res.body.covered).toBe(false);
        expect(res.body.reason).toBe('no_active_subscription');
        expect(res.body.priceCents).toBe(1000);
    });

    it('needs a real userId', async () => {
        const missing = await quote({ orderType: 'parking' });
        expect(missing.statusCode).toBe(400);

        const unknown = await quote({ userId: new mongoose.Types.ObjectId().toString() });
        expect(unknown.statusCode).toBe(404);
    });

    it('quotes what evaluateParkCoverage decides, never a second opinion', async () => {
        // The quote is only worth anything if it cannot disagree with the
        // booking path. Walk the coverage engine directly and check the
        // endpoint returns the same verdict and the same reason code.
        const user = await makeCustomer();
        const sub = await makeSub(user);

        const direct = await subscriptionService.evaluateParkCoverage(sub, {
            aspMode: false,
            lat: HOME.lat,
            lng: HOME.lng,
            listPriceCents: 1000,
        });
        const res = await quote(parkQuote(user));

        expect(res.body.covered).toBe(direct.covered);
        expect(res.body.reason).toBe(direct.reason);
    });
});

// ---------------------------------------------------------------------------
// Extending a park the plan already paid for
// ---------------------------------------------------------------------------

describe('extending a covered park', () => {
    it('costs nothing, takes no PaymentIntent, and gives the time', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        const order = await coveredParkOrder(user, sub);

        const res = await extend(order._id, { additionalHours: 2 });

        expect(res.statusCode).toBe(0); // res.json() without res.status() — a 200
        expect(res.body.success).toBe(true);
        expect(res.body.covered).toBe(true);
        expect(res.body.charged).toBe(false);
        expect(res.body.amountCents).toBe(0);
        expect(res.body.clientSecret).toBeUndefined();
        expect(res.body.newDurationMinutes).toBe(240);

        const saved = await Order.findById(order._id);
        expect(saved.duration).toBe(240);
        // The extensions array is the ledger of extension CHARGES. Nothing was
        // charged, so nothing is written to it.
        expect(saved.extensions).toHaveLength(0);
        expect(saved.paymentIntentId).toBeFalsy();
        expect(saved.totalAmount).toBe(0);
    });

    it('the per-use path is untouched — it still goes to Stripe', async () => {
        // With no STRIPE_API_KEY the Stripe client is null, so a per-use
        // extension answers 500. That is today's behaviour and it proves the
        // covered branch above is the only thing that skips the charge.
        const user = await makeCustomer();
        const order = await paidParkOrder(user);

        const res = await extend(order._id, { additionalHours: 1 });
        expect(res.statusCode).toBe(500);
        expect(res.body.message).toBe('Stripe is not configured.');

        const saved = await Order.findById(order._id);
        expect(saved.duration).toBe(120); // nothing given away either
    });

    it('confirm on a covered park is a no-op, not a charge', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        const order = await coveredParkOrder(user, sub);

        await extend(order._id, { additionalHours: 1 });
        const res = await confirmExtend(order._id); // no paymentIntentId to send

        expect(res.body.success).toBe(true);
        expect(res.body.covered).toBe(true);
        expect(res.body.charged).toBe(false);
        expect(res.body.newDurationMinutes).toBe(180);

        const saved = await Order.findById(order._id);
        expect(saved.duration).toBe(180); // confirm added nothing on top
        expect(saved.extensions).toHaveLength(0);
    });

    it('coverage does not bypass the guards: a finished park still refuses', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        const order = await coveredParkOrder(user, sub, { status: 'completed' });

        const res = await extend(order._id, { additionalHours: 1 });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toContain("status 'completed'");

        const saved = await Order.findById(order._id);
        expect(saved.duration).toBe(120);
    });

    it('a covered retrieval leg is still refused as the wrong kind of order', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        const order = await coveredParkOrder(user, sub, { orderType: 'retrieval' });

        const res = await extend(order._id, { additionalHours: 1 });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toContain('retrieval');
    });

    it('a covered street-cleaning move on the $50/$100 tier is free to extend too', async () => {
        // The stamp is what decides, not the tier. That tier's ordinary parks
        // and retrievals stay full price — but a sweep move we handed over for
        // nothing cannot then cost $5 to hold a little longer.
        const user = await makeCustomer();
        const sub = await makeSub(user, { tier: 'street_cleaning', amountCents: 10000 });
        const order = await coveredParkOrder(user, sub, {
            aspMode: true,
            duration: 90,
            listPriceCents: 1500,
        });

        const res = await extend(order._id, { additionalHours: 1 });
        expect(res.body.charged).toBe(false);
        expect((await Order.findById(order._id)).extensions).toHaveLength(0);
    });

    it('asking twice gives more time twice and still moves no money', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        const order = await coveredParkOrder(user, sub);

        await extend(order._id, { additionalHours: 1 });
        await extend(order._id, { additionalHours: 1 });

        const saved = await Order.findById(order._id);
        expect(saved.duration).toBe(240);
        expect(saved.extensions).toHaveLength(0);
    });
});

/**
 * A park on the flat plans has no end time. Rishi, 2026-09-04: we hold the car
 * and the keys until the customer asks for it, so a duration was always a
 * fiction on them.
 *
 * The line that matters: this is decided by TIER AND PLACE, never by whether
 * the plan paid. The second park of a day is charged for and still indefinite.
 */
describe('indefinite parks', () => {
    const svc = require('../services/subscriptionService');

    test('$300 is indefinite anywhere', async () => {
        const u = await makeCustomer();
        const sub = await makeSub(u, { tier: 'valet_anywhere' });
        expect(svc.parkIsIndefinite(sub, { lat: 40.75, lng: -73.99 })).toBe(true);
        expect(svc.parkIsIndefinite(sub, { lat: 40.60, lng: -74.10 })).toBe(true);
    });

    test('$250 is indefinite at the fixed address and finite away from it', async () => {
        const u = await makeCustomer();
        const sub = await makeSub(u, { tier: 'home_garage', homeAddress: HOME });
        expect(svc.parkIsIndefinite(sub, { lat: HOME.lat, lng: HOME.lng })).toBe(true);
        // ~2.5km away — outside the 250m circle the plan pays inside.
        expect(svc.parkIsIndefinite(sub, { lat: HOME.lat + 0.022, lng: HOME.lng })).toBe(false);
    });

    test('the per-move plan and a per-use customer are never indefinite', async () => {
        const u = await makeCustomer();
        const sc = await makeSub(u, { tier: 'street_cleaning' });
        expect(svc.parkIsIndefinite(sc, { lat: HOME.lat, lng: HOME.lng })).toBe(false);
        expect(svc.parkIsIndefinite(null, { lat: HOME.lat, lng: HOME.lng })).toBe(false);
    });

    test('a lapsed plan is not indefinite', async () => {
        const u = await makeCustomer();
        const sub = await makeSub(u, {
            tier: 'valet_anywhere',
            status: 'cancelled',
        });
        expect(svc.parkIsIndefinite(sub, { lat: 40.75, lng: -73.99 })).toBe(false);
    });

    test('no pin means finite — it fails toward an ending, never away from one', async () => {
        const u = await makeCustomer();
        const sub = await makeSub(u, { tier: 'home_garage', homeAddress: HOME });
        expect(svc.parkIsIndefinite(sub, {})).toBe(false);
        // And a $250 plan with no address saved cannot be inside a circle that
        // does not exist.
        const noHome = await makeSub(await makeCustomer(), { tier: 'home_garage', homeAddress: undefined });
        expect(svc.parkIsIndefinite(noHome, { lat: HOME.lat, lng: HOME.lng })).toBe(false);
    });
});
