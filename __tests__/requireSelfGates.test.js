/**
 * "Prove you are the account you are naming." — the five routes that now do.
 * Run: npx jest requireSelfGates
 *
 * Every one of these read a customer ObjectId off the request and acted on it
 * with no proof at all, and an ObjectId is not a secret — the pending-order
 * feed published them until 2026-09-04. What that bought a stranger:
 *
 *   POST /api/subscription/change   — Stripe `always_invoice` on the victim's
 *                                     saved card, e.g. $50/mo → $300/mo.
 *   POST /api/subscription/cancel   — ends their plan and their street-cleaning
 *                                     coverage; the ASP scheduler skips a
 *                                     cancelled subscription, so the car stops
 *                                     being moved before the sweep.
 *   GET  /api/order/hasActiveOrder  — the live `otp.code` that releases a car
 *   GET  /api/order/getOrdersByUser   that is parked on the street right now,
 *                                     plus the address it is parked at.
 *   POST /api/custody/request-keys  — dispatches a valet to walk the keys to
 *                                     the address on file AND answers with the
 *                                     `return_key` code that releases them.
 *
 * Three assertions per route, and the third matters as much as the first two:
 * a gate that also refuses the owner is a lockout, not a fix.
 *
 * Deliberately NOT here, because they are deliberately NOT gated — see
 * routes/custody.js and the notes in this run's report:
 *   GET /api/custody/mine/:userId   (its only caller is the valet, asking
 *                                    about the customer — requireSelf 403s it
 *                                    and the valet hands back keys he should
 *                                    keep)
 *   GET /api/auth/getUserById/:userId (the shipped app resolves the OTHER
 *                                    party's firebaseUid through it on every
 *                                    push)
 *   POST /api/order/:orderId/tip    (the web sends no token on this one call)
 *   POST /api/payment/createPaymentIntent (iOS uses raw fetch — gating it
 *                                    breaks checkout on a shipped binary)
 */

// The in-memory Mongo's first write in a suite this size runs past Jest's
// 5s default on a cold machine, and a timeout here reads exactly like a gate
// that hangs. Give it room so a failure means what it says.
jest.setTimeout(30000);

// `uid:<firebaseUid>` stands in for a real Firebase ID token.
jest.mock('firebase-admin', () => ({
    auth: () => ({
        verifyIdToken: async (token) => {
            const m = /^uid:(.+)$/.exec(String(token));
            if (!m) throw new Error('Decoding Firebase ID token failed');
            return { uid: m[1] };
        },
    }),
    // The controllers behind these routes reach for messaging/firestore on the
    // happy path; a mock that only answers auth() hangs the run.
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
                collection: () => ({ add: async () => {}, get: async () => ({ docs: [] }) }),
            }),
            add: async () => {},
            where: () => ({ get: async () => ({ docs: [], empty: true }) }),
        }),
    }),
    apps: [{}],
    initializeApp: () => {},
    credential: { cert: () => ({}), applicationDefault: () => ({}) },
    storage: () => ({ bucket: () => ({ file: () => ({}) }) }),
}));

// Stripe is only reached PAST the gate. Nothing in this suite is meant to get
// that far on a wrong-account call, and the owner cases here stop at the
// controller's own "no subscription" / "not holding a car" answer.
jest.mock('stripe', () => {
    return jest.fn(() => ({
        subscriptions: {
            update: async () => ({ id: 'sub_mock', items: { data: [{ id: 'si_mock' }] } }),
            retrieve: async () => ({ id: 'sub_mock', items: { data: [{ id: 'si_mock' }] } }),
            cancel: async () => ({ id: 'sub_mock', status: 'canceled' }),
            del: async () => ({ id: 'sub_mock', status: 'canceled' }),
        },
        invoices: { list: async () => ({ data: [] }) },
        refunds: { create: async () => ({ id: 're_mock', amount: 0 }) },
        prices: { list: async () => ({ data: [] }) },
        customers: { retrieve: async () => ({ id: 'cus_mock' }) },
        paymentIntents: { create: async () => ({ id: 'pi_mock', client_secret: 'cs_mock' }) },
        webhooks: { constructEvent: () => ({}) },
    }));
});

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const User = require('../models/User');
const Order = require('../models/Order');
const orderRouter = require('../routes/order');
const subscriptionRouter = require('../routes/subscription');
const custodyRouter = require('../routes/custody');

let mongo;

const app = express();
app.use(express.json());
// Several of these controllers emit on the socket; nothing reads it back.
app.use((req, res, next) => {
    req.io = { emit: () => {}, to: () => ({ emit: () => {} }) };
    next();
});
app.use('/api/order', orderRouter);
app.use('/api/subscription', subscriptionRouter);
app.use('/api/custody', custodyRouter);

let phoneSeq = 9175558000;
const makeUser = (extra = {}) => User.create({
    firstName: 'Randi',
    lastName: 'Tester',
    email: `u${new mongoose.Types.ObjectId()}@example.com`,
    phone: String(++phoneSeq),
    firebaseUid: `uid_${phoneSeq}`,
    verified: true,
    ...extra,
});

/** The Authorization header a signed-in client sends. */
const as = (user) => ['Authorization', `Bearer uid:${user.firebaseUid}`];

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
});

afterEach(async () => {
    await Order.deleteMany({});
    await User.deleteMany({});
});

/**
 * The three questions, asked the same way of every gated route.
 *
 * `send` runs one request against the route naming `victim`, with whatever
 * headers the caller adds. The owner case asserts only that the gate let the
 * request through — the status the controller then answers with is that
 * controller's business, and is checked per-route below where it is specific.
 */
function gateSuite(name, send) {
    describe(name, () => {
        test('a stranger with no token at all is refused', async () => {
            const victim = await makeUser();
            const res = await send(victim, (r) => r);
            expect(res.statusCode).toBe(401);
        });

        test('a signed-in stranger naming somebody else’s id is refused', async () => {
            const victim = await makeUser();
            const attacker = await makeUser();
            const res = await send(victim, (r) => r.set(...as(attacker)));
            expect(res.statusCode).toBe(403);
            expect(res.body.message).toBe('That is not your account.');
        });

        test('a forged token is refused, not waved through', async () => {
            const victim = await makeUser();
            const res = await send(victim, (r) => r.set('Authorization', 'Bearer not-a-token'));
            expect(res.statusCode).toBe(401);
        });

        test('the owner is not refused', async () => {
            const victim = await makeUser();
            const res = await send(victim, (r) => r.set(...as(victim)));
            expect(res.statusCode).not.toBe(401);
            expect(res.statusCode).not.toBe(403);
        });
    });
}

/* -------------------------------------------------------------------------- */
/* subscriptions                                                              */
/* -------------------------------------------------------------------------- */

gateSuite('POST /api/subscription/cancel', (victim, auth) =>
    auth(request(app).post('/api/subscription/cancel')).send({ userId: String(victim._id) })
);

gateSuite('POST /api/subscription/change', (victim, auth) =>
    auth(request(app).post('/api/subscription/change')).send({
        userId: String(victim._id),
        tier: 'valet_anywhere',
        interval: 'month',
    })
);

describe('the subscription gate reads the BODY and only the body', () => {
    test('an attacker cannot satisfy it with ?userId=me while the body names the victim', async () => {
        // The middleware's DEFAULT pick is `body.userId || query.userId`. Both
        // controllers read the body alone, so a default pick would let this
        // through against the victim's plan. The routes name the body
        // explicitly for exactly this.
        const victim = await makeUser();
        const attacker = await makeUser();

        const res = await request(app)
            .post(`/api/subscription/cancel?userId=${attacker._id}`)
            .set(...as(attacker))
            .send({ userId: String(victim._id) });

        expect(res.statusCode).toBe(403);
    });
});

/* -------------------------------------------------------------------------- */
/* the live handoff code                                                      */
/* -------------------------------------------------------------------------- */

const CURB = { lat: 40.6798, lng: -73.9899, streetAddress: '296 12th St' };

const makeParkedOrder = (customerId, valetId) => Order.create({
    customer: customerId,
    valet: valetId,
    customerLocation: CURB,
    parkingType: 'street',
    orderType: 'parking',
    serviceType: 'park-and-hold',
    duration: 120,
    pickUpTime: new Date(),
    status: 'accepted',
    acceptedAt: new Date(),
    totalAmount: 1650,
    paymentMethod: 'card',
    paymentStatus: 'paid',
    vehicle: { color: 'Grey', model: 'Honda Civic', licensePlate: 'ABC1234' },
    otp: {
        code: '424242',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000),
        verified: false,
        type: 'order_creation',
    },
});

gateSuite('GET /api/order/hasActiveOrder', (victim, auth) =>
    auth(request(app).get('/api/order/hasActiveOrder')).query({
        userId: String(victim._id),
        isValet: 'false',
    })
);

gateSuite('GET /api/order/getOrdersByUser', (victim, auth) =>
    auth(request(app).get('/api/order/getOrdersByUser')).query({
        userId: String(victim._id),
        isValet: 'false',
    })
);

describe('the code that releases a car', () => {
    test('is no longer handed to a stranger holding the customer’s ObjectId', async () => {
        const customer = await makeUser();
        const valet = await makeUser({ isValet: true });
        await makeParkedOrder(customer._id, valet._id);

        // This is the whole attack: the ObjectId came off the job board, and
        // one GET used to answer with the six digits and the curb address.
        const anon = await request(app)
            .get('/api/order/hasActiveOrder')
            .query({ userId: String(customer._id), isValet: 'false' });
        expect(anon.statusCode).toBe(401);
        expect(JSON.stringify(anon.body)).not.toContain('424242');

        const attacker = await makeUser();
        const other = await request(app)
            .get('/api/order/hasActiveOrder')
            .set(...as(attacker))
            .query({ userId: String(customer._id), isValet: 'false' });
        expect(other.statusCode).toBe(403);
        expect(JSON.stringify(other.body)).not.toContain('424242');
    });

    test('and is still there for the customer herself, who says it out loud', async () => {
        // Not an oversight. UserHomeScreen.js:574 and tracking.tsx:236 both
        // read `otp.code` off this document to draw the number she reads to
        // the valet. Redacting it strands her at the curb.
        const customer = await makeUser();
        const valet = await makeUser({ isValet: true });
        await makeParkedOrder(customer._id, valet._id);

        const res = await request(app)
            .get('/api/order/hasActiveOrder')
            .set(...as(customer))
            .query({ userId: String(customer._id), isValet: 'false' });

        expect(res.statusCode).toBe(200);
        expect(res.body.activeOrder.otp.code).toBe('424242');
    });

    test('and still there for the valet on his own side, who says it first', async () => {
        // `hasActiveOrder` is the valet's ONLY source of this number:
        // OrderContext.js short-circuits before the getOrdersByUser fallback on
        // the valet branch, and that fallback strips the code anyway.
        const customer = await makeUser();
        const valet = await makeUser({ isValet: true });
        await makeParkedOrder(customer._id, valet._id);

        const res = await request(app)
            .get('/api/order/hasActiveOrder')
            .set(...as(valet))
            .query({ userId: String(valet._id), isValet: 'true' });

        expect(res.statusCode).toBe(200);
        expect(res.body.activeOrders[0].otp.code).toBe('424242');
    });

    test('a valet cannot read the customer’s side by naming her id', async () => {
        const customer = await makeUser();
        const valet = await makeUser({ isValet: true });
        await makeParkedOrder(customer._id, valet._id);

        const res = await request(app)
            .get('/api/order/hasActiveOrder')
            .set(...as(valet))
            .query({ userId: String(customer._id), isValet: 'false' });

        expect(res.statusCode).toBe(403);
    });

    test('the trip history answers its owner and nobody else', async () => {
        const customer = await makeUser();
        const valet = await makeUser({ isValet: true });
        await makeParkedOrder(customer._id, valet._id);

        const mine = await request(app)
            .get('/api/order/getOrdersByUser')
            .set(...as(customer))
            .query({ userId: String(customer._id), isValet: 'false' });
        expect(mine.statusCode).toBe(200);
        expect(mine.body.orders).toHaveLength(1);

        const attacker = await makeUser();
        const theirs = await request(app)
            .get('/api/order/getOrdersByUser')
            .set(...as(attacker))
            .query({ userId: String(customer._id), isValet: 'false' });
        expect(theirs.statusCode).toBe(403);
        expect(theirs.body.orders).toBeUndefined();
    });
});

/* -------------------------------------------------------------------------- */
/* the keys                                                                   */
/* -------------------------------------------------------------------------- */

gateSuite('POST /api/custody/request-keys', (victim, auth) =>
    auth(request(app).post('/api/custody/request-keys')).send({ userId: String(victim._id) })
);

describe('asking for the keys back', () => {
    test('a stranger cannot dispatch a key delivery on somebody else’s car', async () => {
        const customer = await makeUser();
        const attacker = await makeUser();

        const res = await request(app)
            .post('/api/custody/request-keys')
            .set(...as(attacker))
            .send({ userId: String(customer._id) });

        expect(res.statusCode).toBe(403);
        // No order was minted, so no `return_key` code exists to leak.
        expect(await Order.countDocuments({})).toBe(0);
    });

    test('the owner reaches the controller and gets its own answer, not the gate’s', async () => {
        // No custody row for this account, so the controller refuses with 409
        // "We are not holding a car for you right now." Reaching that at all
        // is the proof the gate let the rightful owner through.
        const customer = await makeUser();

        const res = await request(app)
            .post('/api/custody/request-keys')
            .set(...as(customer))
            .send({ userId: String(customer._id) });

        expect(res.statusCode).toBe(409);
        expect(res.body.message).toBe('We are not holding a car for you right now.');
    });
});

/* -------------------------------------------------------------------------- */
/* what a gate must NOT do                                                    */
/* -------------------------------------------------------------------------- */

describe('the gate refuses on identity, not on existence', () => {
    test('an unknown id and a wrong id answer the same 403', async () => {
        // Telling them apart is a way to enumerate which ObjectIds are real
        // accounts, which is the first half of the attack these gates close.
        const attacker = await makeUser();
        const victim = await makeUser();
        const ghost = new mongoose.Types.ObjectId();

        const real = await request(app)
            .get('/api/order/getOrdersByUser')
            .set(...as(attacker))
            .query({ userId: String(victim._id), isValet: 'false' });
        const fake = await request(app)
            .get('/api/order/getOrdersByUser')
            .set(...as(attacker))
            .query({ userId: String(ghost), isValet: 'false' });

        expect(real.statusCode).toBe(403);
        expect(fake.statusCode).toBe(403);
        expect(fake.body.message).toBe(real.body.message);
    });

    test('the routes left open on purpose are still open', async () => {
        // A copy-pasted `router.use(requireSelf(...))` at the top of
        // routes/subscription.js would gate these two, and the /park pricing
        // screen is meant to answer a signed-out visitor.
        const plans = await request(app).get('/api/subscription/plans');
        expect(plans.statusCode).toBe(200);

        // /promo answers a signed-out visitor too. Whatever it says about the
        // code, it must not be 401.
        const promo = await request(app).post('/api/subscription/promo').send({ code: 'NOPE' });
        expect(promo.statusCode).not.toBe(401);

        // And the custody read the VALET makes about his customer.
        const customer = await makeUser();
        const valet = await makeUser({ isValet: true });
        const mine = await request(app)
            .get(`/api/custody/mine/${customer._id}`)
            .set(...as(valet));
        expect(mine.statusCode).toBe(200);
    });
});

/**
 * A tip charges the customer's saved card off-session, and it names an ORDER
 * rather than a person. Order ids travel with the order documents themselves,
 * so anybody holding one could tip a valet off somebody else's card.
 */
describe('tipping somebody else’s order', () => {
    const Order = require('../models/Order');

    const paidOrder = (customerId) =>
        Order.create({
            customer: customerId,
            customerLocation: { lat: 40.6798, lng: -73.9899, streetAddress: '296 12th St' },
            parkingType: 'street',
            orderType: 'parking',
            serviceType: 'park-and-hold',
            duration: 120,
            pickUpTime: new Date(),
            status: 'completed',
            totalAmount: 1000,
            paymentMethod: 'card',
            paymentStatus: 'paid',
            vehicle: { color: 'Grey', model: 'Honda Civic', licensePlate: 'TIP1234' },
        });

    test('an anonymous caller is refused', async () => {
        const victim = await makeUser();
        const order = await paidOrder(victim._id);

        const res = await request(app)
            .post(`/api/order/${order._id}/tip`)
            .send({ amountCents: 500, percentagePreset: null, context: 'test' });

        expect(res.status).toBe(401);
    });

    test('a signed-in stranger is refused', async () => {
        const victim = await makeUser();
        const attacker = await makeUser();
        const order = await paidOrder(victim._id);

        const res = await request(app)
            .post(`/api/order/${order._id}/tip`)
            .set(...as(attacker))
            .send({ amountCents: 500, percentagePreset: null, context: 'test' });

        expect(res.status).toBe(403);
    });

    test('an order that does not exist answers the same as one that is not yours', async () => {
        const attacker = await makeUser();
        const ghost = new mongoose.Types.ObjectId();

        const res = await request(app)
            .post(`/api/order/${ghost}/tip`)
            .set(...as(attacker))
            .send({ amountCents: 500, percentagePreset: null, context: 'test' });

        // Same answer either way, so this cannot be used to find real order ids.
        expect(res.status).toBe(403);
    });

    test('the owner reaches the controller — the gate is not what stops them', async () => {
        const owner = await makeUser();
        const order = await paidOrder(owner._id);

        const res = await request(app)
            .post(`/api/order/${order._id}/tip`)
            .set(...as(owner))
            .send({ amountCents: 500, percentagePreset: null, context: 'test' });

        // Whatever the tip controller decides about a card we have not set up
        // here, it is no longer the gate refusing them.
        expect([401, 403]).not.toContain(res.status);
    });
});
