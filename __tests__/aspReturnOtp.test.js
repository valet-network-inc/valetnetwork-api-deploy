/**
 * The key-return code on an ASP job, when two orders share one chat.
 * Run: npx jest aspReturnOtp
 *
 * An ASP park ends by the sweep minting a RETURN LEG — a second order, on the
 * PARENT'S conversation (it has to be: the leg never passes through
 * `acceptOrder`, so nothing else would ever give it a thread). For the rest of
 * the job both orders are live on one chat, and both carry a `return_key` OTP:
 *
 *   parent  — minted by `updateCarLocation` when the car was parked. Dead the
 *             moment the leg takes the handoff over. Nothing retired it.
 *   leg     — minted by the sweep. This is the one the customer's app shows,
 *             because `hasActiveOrder` drops the parent once `parkClosedAt`
 *             is stamped.
 *
 * The valet app binds its OTP modal to the first order it finds on the chat,
 * which is the older parent. So the customer reads out the leg's code and the
 * valet's app checks it against the parent — "Invalid OTP" on a code that is
 * perfectly correct. Happened live to Chelsey Shockley's job on 2026-08-25:
 * her screen said 909011, the parent held 386682, seven 400s in a row.
 *
 * Two rules, both tested here:
 *   1. `verifyOTP` follows the link to the leg that owns the live handoff, so
 *      the code the customer is holding verifies whichever of the pair the app
 *      addressed.
 *   2. The sweep leaves ONE code in the world for the pair — the parent stops
 *      advertising the dead one — so the number on the valet's screen is the
 *      number on the customer's.
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../models/Order');
const User = require('../models/User');
const orderController = require('../controllers/orderController');

let mongo;

const mockRes = () => {
    const res = {};
    res.statusCode = 200;
    res.body = null;
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
};

const mockIo = () => {
    const emits = [];
    return {
        emits,
        emit: (event, payload) => emits.push({ room: null, event, payload }),
        to: (room) => ({ emit: (event, payload) => emits.push({ room, event, payload }) }),
    };
};

let phoneSeq = 5591000000;
const makeUser = (isValet = false) => User.create({
    firstName: isValet ? 'Val' : 'Cust',
    lastName: 'Tester',
    email: `u${new mongoose.Types.ObjectId()}@example.com`,
    phone: String(++phoneSeq),
    verified: true,
    isValet,
});

const CHAT = 'conv-shared-by-both-legs';
const SPOT = { lat: 40.68655, lng: -73.99209, streetAddress: '43 Wyckoff St' };

const returnKeyOtp = (code) => ({
    code,
    createdAt: new Date(Date.now() - 60 * 60 * 1000),
    expiresAt: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000),
    verified: false,
    type: 'return_key',
});

/** The state Chelsey's job was in at 14:05: parent closed out, leg live. */
const makeAspPair = async (customerId, valetId, { parentCode, legCode }) => {
    const parent = await Order.create({
        customer: customerId,
        valet: valetId,
        customerLocation: { lat: 40.68652, lng: -73.99213, streetAddress: '38 Wyckoff St' },
        parkingType: 'street',
        orderType: 'parking',
        duration: 90,
        pickUpTime: new Date(),
        status: 'parked',
        totalAmount: 1650,
        paymentMethod: 'card',
        paymentStatus: 'paid',
        serviceType: 'park-and-hold',
        aspMode: true,
        conversationId: CHAT,
        parkingLocation: SPOT,
        parkedAt: new Date(),
        parkClosedAt: new Date(),
        otpVerifiedTimes: { orderCreation: new Date() },
        otp: returnKeyOtp(parentCode),
    });
    const leg = await Order.create({
        customer: customerId,
        valet: valetId,
        customerLocation: { lat: 40.68652, lng: -73.99213, streetAddress: '38 Wyckoff St' },
        parkingType: 'retrieval',
        orderType: 'retrieval',
        parkingLocation: SPOT,
        duration: 30,
        pickUpTime: new Date(),
        status: 'accepted',
        totalAmount: 0,
        paymentMethod: 'card',
        paymentStatus: 'paid',
        isFreeService: true,
        serviceType: 'park-and-hold',
        aspMode: true,
        conversationId: CHAT,
        linkedOrderId: parent._id,
        autoBookKey: `aspreturn:${parent._id}`,
        otp: returnKeyOtp(legCode),
    });
    parent.linkedOrderId = leg._id;
    parent.aspOrderCreated = true;
    await parent.save();
    return { parent, leg };
};

const verify = async (orderId, otp) => {
    const req = { body: { orderId: String(orderId), otp }, io: mockIo() };
    const res = mockRes();
    await orderController.verifyOTP(req, res);
    return res;
};

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

describe('the code the customer is holding', () => {
    test("Chelsey's case: the leg's code verifies even when the app addressed the parent", async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const { parent, leg } = await makeAspPair(customer._id, valet._id, {
            parentCode: '386682',
            legCode: '909011',
        });

        const res = await verify(parent._id, '909011');

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);

        // It has to land on the LEG — that is the order the handoff belongs to
        // and the one whose completion closes the job out.
        const legAfter = await Order.findById(leg._id);
        expect(legAfter.otpVerifiedTimes.returnKey).toBeTruthy();

        const parentAfter = await Order.findById(parent._id);
        expect(parentAfter.otpVerifiedTimes.returnKey).toBeFalsy();
    });

    test('typing it as digits, or with the spaces a keypad leaves, still works', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const { parent } = await makeAspPair(customer._id, valet._id, {
            parentCode: '386682',
            legCode: '909011',
        });

        expect((await verify(parent._id, 909011)).statusCode).toBe(200);
    });

    test('and with the whitespace a paste or a keypad leaves on it', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const { parent } = await makeAspPair(customer._id, valet._id, {
            parentCode: '386682',
            legCode: '909011',
        });

        expect((await verify(parent._id, ' 909011 ')).statusCode).toBe(200);
    });

    test('the parent’s own code is dead once the leg owns the handoff', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const { parent } = await makeAspPair(customer._id, valet._id, {
            parentCode: '386682',
            legCode: '909011',
        });

        const res = await verify(parent._id, '386682');

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/Invalid OTP/);
    });

    test('addressing the leg directly is unchanged', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const { leg } = await makeAspPair(customer._id, valet._id, {
            parentCode: '386682',
            legCode: '909011',
        });

        const res = await verify(leg._id, '909011');

        expect(res.statusCode).toBe(200);
        const legAfter = await Order.findById(leg._id);
        expect(legAfter.otpVerifiedTimes.returnKey).toBeTruthy();
    });

    test('a retrieval on its own chat is never redirected into', async () => {
        // A customer-booked retrieval gets its own conversation on accept, so
        // no client can confuse the two. Nothing here should reach across.
        const customer = await makeUser();
        const valet = await makeUser(true);
        const { parent, leg } = await makeAspPair(customer._id, valet._id, {
            parentCode: '386682',
            legCode: '909011',
        });
        await Order.findByIdAndUpdate(leg._id, { conversationId: 'its-own-thread' });

        const res = await verify(parent._id, '909011');

        expect(res.statusCode).toBe(400);
        const legAfter = await Order.findById(leg._id);
        expect(legAfter.otpVerifiedTimes.returnKey).toBeFalsy();
    });

    test('a cancelled leg hands the handoff back — nothing to redirect to', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const { parent, leg } = await makeAspPair(customer._id, valet._id, {
            parentCode: '386682',
            legCode: '909011',
        });
        await Order.findByIdAndUpdate(leg._id, { status: 'cancelled' });

        expect((await verify(parent._id, '909011')).statusCode).toBe(400);
        expect((await verify(parent._id, '386682')).statusCode).toBe(200);
    });

    test('an ordinary park with no leg is untouched', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await Order.create({
            customer: customer._id,
            valet: valet._id,
            customerLocation: { lat: 40.68652, lng: -73.99213, streetAddress: '38 Wyckoff St' },
            parkingType: 'street',
            orderType: 'parking',
            duration: 90,
            pickUpTime: new Date(),
            status: 'parked',
            totalAmount: 1000,
            paymentMethod: 'card',
            paymentStatus: 'paid',
            serviceType: 'park-and-hold',
            conversationId: 'solo-chat',
            parkingLocation: SPOT,
            otp: returnKeyOtp('112233'),
        });

        expect((await verify(order._id, '112233')).statusCode).toBe(200);
        const after = await Order.findById(order._id);
        expect(after.otpVerifiedTimes.returnKey).toBeTruthy();
    });
});

describe('the sweep leaves one code in the world', () => {
    test('the parent stops advertising the code the park minted', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await Order.create({
            customer: customer._id,
            valet: valet._id,
            customerLocation: { lat: 40.68652, lng: -73.99213, streetAddress: '38 Wyckoff St' },
            parkingType: 'street',
            orderType: 'parking',
            duration: 90,
            pickUpTime: new Date(),
            status: 'parked',
            totalAmount: 1650,
            paymentMethod: 'card',
            paymentStatus: 'paid',
            serviceType: 'park-and-hold',
            aspMode: true,
            asp_time: new Date(Date.now() - 60 * 1000),
            conversationId: CHAT,
            parkingLocation: SPOT,
            parkedAt: new Date(),
            otp: returnKeyOtp('386682'),
        });

        await orderController.runAspSweep(mockIo());

        const parent = await Order.findById(order._id);
        expect(parent.linkedOrderId).toBeTruthy();
        const leg = await Order.findById(parent.linkedOrderId);

        expect(leg.otp.code).toMatch(/^\d{6}$/);
        expect(leg.otp.code).not.toBe('386682');
        // Same number on both screens, whichever order the app is bound to.
        expect(parent.otp.code).toBe(leg.otp.code);
        expect(parent.otp.type).toBe('return_key');
        expect(parent.otp.verified).toBe(false);

        // And it verifies from either side.
        expect((await verify(parent._id, leg.otp.code)).statusCode).toBe(200);
    });
});
