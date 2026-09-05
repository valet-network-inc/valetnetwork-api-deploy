/**
 * The live handoff code, and which unauthenticated reads publish it.
 * Run: npx jest orderCodeExposure
 *
 * `otp.code` is the six digits that release a car. Three endpoints in
 * orderController answered with whole Order documents and none of them asks
 * who is calling, so the number sat on the open internet — captured live from
 * `GET /api/order/getPendingOrders` as `otp: { code: "777777" }`, beside the
 * customer ObjectId that unlocks the next read.
 *
 * These assert on the SERIALISED body, not on a field name. A projection that
 * renames or nests the code is not a projection, and the only question worth
 * asking of a response is whether the number is in it.
 *
 * Four things are asserted as loudly as the redaction itself, because all four
 * are shipped-client contracts that a tidier projection would quietly break.
 * Each one is a record of something still exposed, not a claim that it is
 * fine — they are here so the next person removes them WITH an app release
 * rather than the night before a live morning:
 *
 *   - the `otp` OBJECT survives on the pending feed. Valet 2.2.0 reads its
 *     presence and not its contents (`!!displayOrder?.otp`,
 *     screens/valet/valetorder/ValetOrderScreen.js:325), off the pending
 *     document until he accepts.
 *   - the pending feed still names the customer by raw ObjectId. The valet's
 *     Swipe to Accept reads it off that document and writes it into the chat
 *     that the customer's app then finds the job by. It is no longer public,
 *     though: since 2026-09-04 the board answers only a signed-in valet, which
 *     is what took those ObjectIds off the open internet and with them the way
 *     an attacker found which accounts to aim the other endpoints at.
 *   - `hasActiveOrder` still carries the code on the VALET side, because that
 *     is where his app gets the number he reads out at the curb.
 *   - `getOrdersByUser` still carries the code on the CUSTOMER side. It is the
 *     only place two shipped surfaces can get the number the customer reads out
 *     to get her keys back, and neither can be rebuilt before tomorrow morning.
 *     Stripping it there is a regression, not a fix.
 */

// The valet job board now proves the caller is a signed-in valet, so this
// suite needs a token. `uid:<firebaseUid>` stands in for a real ID token.
jest.mock('firebase-admin', () => ({
    auth: () => ({
        verifyIdToken: async (token) => {
            const m = /^uid:(.+)$/.exec(String(token));
            if (!m) throw new Error('Decoding Firebase ID token failed');
            return { uid: m[1] };
        },
    }),
    // The order controller reaches for these on paths this suite touches;
    // a mock that only answers auth() hangs the run rather than failing it.
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

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../models/Order');
const User = require('../models/User');
const orderRouter = require('../routes/order');

let mongo;

const app = express();
app.use(express.json());
// The socket is only ever emitted on; nothing here reads it back.
app.use((req, res, next) => {
    req.io = { emit: () => {}, to: () => ({ emit: () => {} }) };
    next();
});
app.use('/api/order', orderRouter);

let phoneSeq = 9175552000;
const makeUser = (isValet = false) => User.create({
    firstName: isValet ? 'Marco' : 'Randi',
    lastName: 'Tester',
    email: `u${new mongoose.Types.ObjectId()}@example.com`,
    phone: String(++phoneSeq),
    firebaseUid: `uid_${phoneSeq}`,
    verified: true,
    isValet,
});

/** The header a signed-in app sends. Same shape for a valet and a customer. */
const asValet = (valet) => ['Authorization', `Bearer uid:${valet.firebaseUid}`];
const asUser = asValet;

const CURB = { lat: 40.6798, lng: -73.9899, streetAddress: '296 12th St' };

const liveOtp = (code, type = 'order_creation') => ({
    code,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000),
    verified: false,
    type,
});

const makeOrder = (customerId, extra = {}) => Order.create({
    customer: customerId,
    customerLocation: CURB,
    parkingType: 'street',
    orderType: 'parking',
    serviceType: 'park-and-hold',
    duration: 120,
    pickUpTime: new Date(),
    status: 'pending',
    totalAmount: 1650,
    paymentMethod: 'card',
    paymentStatus: 'paid',
    vehicle: { color: 'Grey', model: 'Honda Civic', licensePlate: 'ABC1234' },
    otp: liveOtp('777777'),
    ...extra,
});

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

describe('the valet feed', () => {
    test('publishes the job without publishing the code that opens the car', async () => {
        const customer = await makeUser();
        await makeOrder(customer._id);

        const valet = await makeUser(true);
        const res = await request(app).get('/api/order/getPendingOrders').set(...asValet(valet));

        expect(res.statusCode).toBe(200);
        expect(res.body.orders).toHaveLength(1);
        // The whole body, under any key, at any depth.
        expect(JSON.stringify(res.body)).not.toContain('777777');
        expect(res.body.orders[0].otp.code).toBeUndefined();
    });

    test('and keeps the otp object, because a shipped valet build reads it exists', async () => {
        // `arrivalRequiresOtp = !!displayOrder?.otp` — and before he accepts,
        // `displayOrder` IS the document from this feed. Deleting the object
        // takes the code ritual off the screen for every unaccepted job.
        const customer = await makeUser();
        await makeOrder(customer._id);

        const valet = await makeUser(true);
        const { body } = await request(app).get('/api/order/getPendingOrders').set(...asValet(valet));

        expect(body.orders[0].otp).toBeDefined();
        expect(body.orders[0].otp.type).toBe('order_creation');
        expect(body.orders[0].otp.verified).toBe(false);
    });

    test('refuses a caller who is not a signed-in valet at all', async () => {
        const customer = await makeUser();
        await makeOrder(customer._id);

        // No token. This is the read that used to hand a stranger every
        // pending customer's ObjectId — the input every other
        // userId-trusting endpoint takes and believes.
        const anon = await request(app).get('/api/order/getPendingOrders');
        expect(anon.statusCode).toBe(401);

        // A signed-in CUSTOMER is not a valet, and the board is not theirs.
        const notAValet = await makeUser(false);
        const wrongRole = await request(app)
            .get('/api/order/getPendingOrders')
            .set(...asValet(notAValet));
        expect(wrongRole.statusCode).toBe(403);
    });

    test('and still names the customer by ObjectId, now only to a signed-in valet', async () => {
        // Read this one as a record, not as an approval.
        //
        // That id is the key to the rest of the chain: it opens
        // `getOrdersByUser` (which still carries the live code on the customer
        // side, above) and, until tonight, the doorman-link mint. The obvious
        // fix — publish a first name and drop the id — breaks dispatch on the
        // build every valet is carrying tomorrow morning:
        //
        //   ValetOrderScreen reads its job straight out of this feed
        //   (`pendingOrders.find(...)`, hooks/useValetOrder.js:86), and Swipe
        //   to Accept then does `extractCustomerId(selectedOrder.customer)`
        //   (:218) and hands the result to two things —
        //     * `createFirebaseConversation(customerId, valetId)`, which writes
        //       `customerId` INTO the chat document. It is how the customer's
        //       app finds the thread afterwards, so an undefined one leaves
        //       her with no chat and the valet reading his code into a room
        //       she is not in;
        //     * `sendOrderUpdateNotification(valetId, customerId, …)`, which is
        //       the "Order Accepted" push.
        //   (context/OrderContext.js:471-500, NotificationService.js:170.)
        //
        // So the id stays until a build that does not need it is on phones.
        // What was closed instead is what the id UNLOCKS: the mint now wants
        // the customer's own Firebase ID token, and the doorman token is off
        // every user document. This asserts the shipped contract so nobody
        // strips the field without shipping the app first.
        const customer = await makeUser();
        await makeOrder(customer._id);

        const valet = await makeUser(true);
        const { body } = await request(app).get('/api/order/getPendingOrders').set(...asValet(valet));

        expect(body.orders[0].customer).toBe(String(customer._id));
    });
});

describe('the live-order read', () => {
    test('the valet’s half carries the code, because he is the one who reads it out', async () => {
        // Also a record rather than an approval. `hasActiveOrder` now proves
        // the caller owns the id it is handed, and answers on both sides; the
        // valet's side is
        // where his app gets the number he says at the curb:
        // `sendOtpAndMaybeOpenModal(activeOrder?.otp?.code, sendParkHoldCollectOTP)`
        // (hooks/useConversation.js:599,717). That message is also the signal
        // the doorman's page waits on before it draws a keypad. Strip it and
        // no handoff can start on 2.2.0 at all.
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeOrder(customer._id, {
            status: 'accepted',
            valet: valet._id,
            acceptedAt: new Date(),
        });

        const res = await request(app)
            .get('/api/order/hasActiveOrder')
            .set(...asUser(valet))
            .query({ userId: String(valet._id), isValet: 'true' });

        expect(res.statusCode).toBe(200);
        expect(res.body.activeOrders[0].otp.code).toBe('777777');
    });
});

describe('the valet location write', () => {
    test('echoes the order it updated without the code on it', async () => {
        // This endpoint takes an order id and nothing else, so anybody who read
        // one off the pending feed could post it here and be handed the whole
        // document back.
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeOrder(customer._id, {
            status: 'accepted',
            valet: valet._id,
            acceptedAt: new Date(),
        });

        const res = await request(app)
            .post('/api/order/updateValetLocation')
            .send({
                orderId: String(order._id),
                valetLocation: { lat: 40.6835, lng: -73.9899 },
            });

        expect(res.statusCode).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain('777777');
        expect(res.body.order.otp.code).toBeUndefined();
        // The write itself still happened — this is a redaction of the answer,
        // not a refusal.
        expect(res.body.order.valetLocation.lat).toBe(40.6835);
    });
});

describe('the order list', () => {
    test('the valet’s half drops the code — nothing shipped has ever read it there', async () => {
        // The only shipped caller that passes isValet=true is the history list
        // (screens/PreviousOrdersScreen.js:84), which draws receipts. The
        // valet's live-order path returns before it reaches this endpoint.
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeOrder(customer._id, {
            status: 'accepted',
            valet: valet._id,
            acceptedAt: new Date(),
        });

        const res = await request(app)
            .get('/api/order/getOrdersByUser')
            .set(...asUser(valet))
            .query({ userId: String(valet._id), isValet: 'true' });

        expect(res.statusCode).toBe(200);
        expect(res.body.orders).toHaveLength(1);
        expect(JSON.stringify(res.body)).not.toContain('777777');
    });

    test('the customer’s half still carries it, and has to until both clients ship', async () => {
        // Not an oversight. A park the valet has closed out is excluded by
        // `customerActiveOrderQuery`, so this list is where BOTH shipped
        // customer surfaces read the code she says out loud to get her keys
        // back — iOS 2.2.0 UserOrderScreen.js:325 and /park tracking.tsx:172,
        // each reached through their own `fetchLiveOrder` fallback. Blanking it
        // takes the number off her screen with a valet standing at the car.
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeOrder(customer._id, {
            status: 'parked',
            valet: valet._id,
            acceptedAt: new Date(),
            parkedAt: new Date(),
            parkClosedAt: new Date(),
            otpVerifiedTimes: { orderCreation: new Date() },
            otp: liveOtp('773311', 'return_key'),
        });

        const res = await request(app)
            .get('/api/order/getOrdersByUser')
            .set(...asUser(customer))
            .query({ userId: String(customer._id), isValet: 'false' });

        expect(res.statusCode).toBe(200);
        expect(res.body.orders[0].otp.code).toBe('773311');
    });
});
