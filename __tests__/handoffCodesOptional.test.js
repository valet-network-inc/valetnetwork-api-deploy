/**
 * Handoff codes are optional per customer (Nov 2026).
 * Run: npx jest handoffCodesOptional
 *
 * With codes off, a code is still minted (the handoff machinery runs on its
 * types and stamps), but nobody reads it out: the valet's swipe confirms the
 * beat through `confirmHandoff`, which checks it is THEIR job and an order
 * made with codes off, then runs the same `applyOtpVerification` the code
 * would have. Codes are three digits.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../models/Order');
const User = require('../models/User');
const orderController = require('../controllers/orderController');
const { newHandoffCode, handoffCodesOn } = require('../services/handoffCode');

let mongo;

const mockRes = () => {
    const res = {};
    res.statusCode = 200;
    res.body = null;
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
};
const mockIo = () => ({ emit: () => {}, to: () => ({ emit: () => {} }) });

let phoneSeq = 5592000000;
const makeUser = (extra = {}) => User.create({
    firstName: extra.isValet ? 'Val' : 'Cust',
    lastName: 'Tester',
    email: `u${new mongoose.Types.ObjectId()}@example.com`,
    phone: String(++phoneSeq),
    verified: true,
    ...extra,
});

const otp = (code, type, { expired = false } = {}) => ({
    code,
    createdAt: new Date(Date.now() - 60 * 60 * 1000),
    expiresAt: new Date(Date.now() + (expired ? -60 : 60) * 60 * 1000),
    verified: false,
    type,
});

const makePark = (customer, valet, extra = {}) => Order.create({
    customer: customer._id,
    valet: valet ? valet._id : undefined,
    customerLocation: { lat: 40.68652, lng: -73.99213, streetAddress: '38 Wyckoff St' },
    parkingType: 'street',
    orderType: 'parking',
    duration: 90,
    pickUpTime: new Date(),
    status: 'accepted',
    totalAmount: 1000,
    paymentMethod: 'card',
    paymentStatus: 'paid',
    serviceType: 'standard',
    otp: otp('482', 'order_creation'),
    ...extra,
});

const swipe = async (order, valet) => {
    const res = mockRes();
    await orderController.confirmHandoff(
        { body: { orderId: String(order._id) }, callerUserId: valet ? String(valet._id) : undefined, io: mockIo() },
        res
    );
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

describe('codes', () => {
    test('are three digits', () => {
        for (let i = 0; i < 500; i++) expect(newHandoffCode()).toMatch(/^[1-9]\d{2}$/);
    });

    test('are off for a customer who never switched them on', async () => {
        const customer = await makeUser();
        expect(await handoffCodesOn(customer._id)).toBe(false);
        const keen = await makeUser({ handoffCodes: true });
        expect(await handoffCodesOn(keen._id)).toBe(true);
    });
});

describe("the valet's swipe", () => {
    test('confirms the key pickup on an order made with codes off', async () => {
        const customer = await makeUser();
        const valet = await makeUser({ isValet: true });
        const park = await makePark(customer, valet, { handoffCode: false });

        const res = await swipe(park, valet);
        expect(res.statusCode).toBe(200);
        const after = await Order.findById(park._id).lean();
        expect(after.otp.verified).toBe(true);
        expect(after.otpVerifiedTimes.orderCreation).toBeInstanceOf(Date);
    });

    test('works on an expired code too: nobody was going to read it out', async () => {
        const customer = await makeUser();
        const valet = await makeUser({ isValet: true });
        const park = await makePark(customer, valet, { handoffCode: false, otp: otp('482', 'order_creation', { expired: true }) });

        const res = await swipe(park, valet);
        expect(res.statusCode).toBe(200);
        expect((await Order.findById(park._id).lean()).otpVerifiedTimes.orderCreation).toBeInstanceOf(Date);
    });

    test("is refused for someone else's job", async () => {
        const customer = await makeUser();
        const valet = await makeUser({ isValet: true });
        const other = await makeUser({ isValet: true });
        const park = await makePark(customer, valet, { handoffCode: false });

        const res = await swipe(park, other);
        expect(res.statusCode).toBe(403);
        expect((await Order.findById(park._id).lean()).otp.verified).toBe(false);
    });

    test('is refused when the customer uses codes, or the order predates the setting', async () => {
        const customer = await makeUser({ handoffCodes: true });
        const valet = await makeUser({ isValet: true });
        const withCodes = await makePark(customer, valet, { handoffCode: true });
        const legacy = await makePark(customer, valet);

        expect((await swipe(withCodes, valet)).statusCode).toBe(409);
        expect((await swipe(legacy, valet)).statusCode).toBe(409);
    });

    test('is refused when there is nothing left to confirm', async () => {
        const customer = await makeUser();
        const valet = await makeUser({ isValet: true });
        const park = await makePark(customer, valet, {
            handoffCode: false,
            otp: { ...otp('482', 'order_creation'), verified: true },
        });
        expect((await swipe(park, valet)).statusCode).toBe(409);
    });

    test("takes a retrieval's first beat and mints its second, three digits", async () => {
        const customer = await makeUser();
        const valet = await makeUser({ isValet: true });
        const leg = await Order.create({
            customer: customer._id,
            valet: valet._id,
            customerLocation: { lat: 40.68652, lng: -73.99213, streetAddress: '38 Wyckoff St' },
            parkingType: 'retrieval',
            orderType: 'retrieval',
            parkingLocation: { lat: 40.68655, lng: -73.99209, streetAddress: '43 Wyckoff St' },
            duration: 30,
            pickUpTime: new Date(),
            status: 'accepted',
            totalAmount: 500,
            paymentMethod: 'card',
            paymentStatus: 'paid',
            serviceType: 'standard',
            handoffCode: false,
            otp: otp('736', 'return_key'),
        });

        const res = await swipe(leg, valet);
        expect(res.statusCode).toBe(200);
        expect(res.body.otpRegenerated).toBe(true);
        const after = await Order.findById(leg._id).lean();
        expect(after.otpVerifiedTimes.returnKey).toBeInstanceOf(Date);
        expect(after.otp.verified).toBe(false);
        expect(after.otp.code).toMatch(/^\d{3}$/);

        // …and the second swipe hands the car back.
        const res2 = await swipe(await Order.findById(leg._id), valet);
        expect(res2.statusCode).toBe(200);
        expect((await Order.findById(leg._id).lean()).otp.verified).toBe(true);
    });
});

describe('a code read out at the car', () => {
    test('still has to match, and still expires', async () => {
        const customer = await makeUser({ handoffCodes: true });
        const valet = await makeUser({ isValet: true });
        const park = await makePark(customer, valet, { handoffCode: true });

        const wrong = await orderController.applyOtpVerification(await Order.findById(park._id), '999', mockIo());
        expect(wrong.status).toBe(400);
        const right = await orderController.applyOtpVerification(await Order.findById(park._id), '482', mockIo());
        expect(right.status).toBe(200);

        const stale = await makePark(customer, valet, { handoffCode: true, otp: otp('482', 'order_creation', { expired: true }) });
        const late = await orderController.applyOtpVerification(await Order.findById(stale._id), '482', mockIo());
        expect(late.status).toBe(400);
        expect(late.body.otpRegenerated).toBe(true);
    });
});
