/**
 * Moving a car that is already parked.
 * Run: npx jest reparkMove
 *
 * An away / street-cleaning job is one order that gets parked many times: the
 * valet moves the car for the sweep and re-parks it after, for days. Only the
 * first save is a park. The ones after it are moves, and they have to:
 *
 *  1. actually change where the order says the car is,
 *  2. leave the return-key OTP alone — the customer is already holding that
 *     code, and a verified handoff must not silently un-verify,
 *  3. leave `parkedAt` alone — the admin dashboard reads it as "accepted →
 *     parked" and a restamp turns a 40-minute job into a 4-second one.
 *
 * Plus the wiring that carries the move to the phones: the live update has to
 * land in the customer's and the valet's own socket rooms. It didn't — the
 * order is populated by the time the emit runs, so `order.customer.toString()`
 * produced a document inspect string and every update went to a room nobody
 * was in.
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

let phoneSeq = 5590000000;
const makeUser = (isValet = false) => User.create({
    firstName: isValet ? 'Val' : 'Cust',
    lastName: 'Tester',
    email: `u${new mongoose.Types.ObjectId()}@example.com`,
    phone: String(++phoneSeq),
    verified: true,
    isValet,
});

const SPOT_A = { lat: 40.68016, lng: -73.99266, streetAddress: '336 President St' };
const SPOT_B = { lat: 40.68282, lng: -73.99293, streetAddress: '366 Degraw St' };

const makeAwayOrder = async (customerId, valetId) => Order.create({
    customer: customerId,
    valet: valetId,
    customerLocation: { lat: 40.6828, lng: -73.9929, streetAddress: '360 Degraw St' },
    parkingType: 'street',
    orderType: 'parking',
    duration: 10080,
    pickUpTime: new Date(),
    status: 'accepted',
    totalAmount: 5000,
    paymentMethod: 'card',
    paymentStatus: 'paid',
    serviceType: 'park-and-hold',
    awayMode: true,
    awayDays: [{ weekday: 5, hour: 11, minute: 30 }],
    vehicle: { color: 'Black', model: 'Civic', licensePlate: 'ABC1234' },
});

const update = async (orderId, updates) => {
    const req = { body: { orderId: String(orderId), updates }, io: mockIo() };
    const res = mockRes();
    await orderController.updateOrder(req, res);
    return { req, res };
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

describe('parking a car, then moving it', () => {
    test('the first save parks it: location, return-key OTP, parkedAt', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeAwayOrder(customer._id, valet._id);

        const { res } = await update(order._id, { status: 'parked', parkingLocation: SPOT_A });
        expect(res.statusCode).toBe(200);

        const after = await Order.findById(order._id);
        expect(after.status).toBe('parked');
        expect(after.parkingLocation.streetAddress).toBe(SPOT_A.streetAddress);
        expect(after.otp.type).toBe('return_key');
        expect(after.otp.code).toMatch(/^\d{6}$/);
        expect(after.parkedAt).toBeTruthy();
    });

    test('a later move rewrites the spot and touches nothing else', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeAwayOrder(customer._id, valet._id);

        await update(order._id, { status: 'parked', parkingLocation: SPOT_A });
        const parked = await Order.findById(order._id);
        const firstCode = parked.otp.code;
        const firstParkedAt = parked.parkedAt.getTime();

        // Street cleaning: the car goes somewhere else and comes back.
        const { res } = await update(order._id, { parkingLocation: SPOT_B });
        expect(res.statusCode).toBe(200);

        const moved = await Order.findById(order._id);
        expect(moved.parkingLocation.streetAddress).toBe(SPOT_B.streetAddress);
        expect(moved.parkingLocation.lat).toBeCloseTo(SPOT_B.lat, 5);
        expect(moved.status).toBe('parked');
        // The customer is holding this code already.
        expect(moved.otp.code).toBe(firstCode);
        // "Accepted → parked" stays honest.
        expect(moved.parkedAt.getTime()).toBe(firstParkedAt);
    });

    test('a move after the keys went back leaves the handoff verified', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeAwayOrder(customer._id, valet._id);

        await update(order._id, { status: 'parked', parkingLocation: SPOT_A });
        await Order.findByIdAndUpdate(order._id, { 'otp.verified': true });

        await update(order._id, { parkingLocation: SPOT_B });

        const moved = await Order.findById(order._id);
        expect(moved.otp.verified).toBe(true);
    });
});

describe('telling the phones', () => {
    test('the update lands in the customer and valet rooms, by id', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeAwayOrder(customer._id, valet._id);

        const { req } = await update(order._id, { status: 'parked', parkingLocation: SPOT_A });

        const rooms = req.io.emits.map((e) => e.room);
        expect(rooms).toContain(String(customer._id));
        expect(rooms).toContain(String(valet._id));
        const parkingEmit = req.io.emits.find(
            (e) => e.payload && e.payload.type === 'PARKING_LOCATION_UPDATE'
        );
        expect(parkingEmit).toBeTruthy();
        expect(parkingEmit.payload.parkingLocation.streetAddress).toBe(SPOT_A.streetAddress);
    });

    test('the location ping reminds the valet app that the car is parked', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeAwayOrder(customer._id, valet._id);
        await update(order._id, { status: 'parked', parkingLocation: SPOT_A });

        // The app pings the valet's own position every few seconds while a job
        // is open. On a parked job that ping carries the parked spot back, so
        // an app that cold-started gets the move control back without a new
        // build.
        const req = {
            body: { orderId: String(order._id), valetLocation: { lat: 40.7, lng: -73.9, streetAddress: 'x' } },
            io: mockIo(),
        };
        await orderController.updateValetLocation(req, mockRes());

        const toValet = req.io.emits.filter((e) => e.room === String(valet._id));
        expect(toValet.map((e) => e.payload.type)).toEqual(
            expect.arrayContaining(['LOCATION_UPDATE', 'PARKING_LOCATION_UPDATE'])
        );
        const hydrate = toValet.find((e) => e.payload.type === 'PARKING_LOCATION_UPDATE');
        expect(hydrate.payload.order.parkingLocation.streetAddress).toBe(SPOT_A.streetAddress);

        // Nothing extra goes to the customer — their app already tracks this.
        const toCustomer = req.io.emits.filter((e) => e.room === String(customer._id));
        expect(toCustomer.map((e) => e.payload.type)).toEqual(['LOCATION_UPDATE']);
    });

    test('a job that is not parked yet gets the plain location ping only', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeAwayOrder(customer._id, valet._id);

        const req = {
            body: { orderId: String(order._id), valetLocation: { lat: 40.7, lng: -73.9, streetAddress: 'x' } },
            io: mockIo(),
        };
        await orderController.updateValetLocation(req, mockRes());

        const types = req.io.emits.map((e) => e.payload.type);
        expect(types).not.toContain('PARKING_LOCATION_UPDATE');
    });

    test('an order with no valet yet still updates instead of blowing up', async () => {
        const customer = await makeUser();
        const order = await Order.create({
            customer: customer._id,
            customerLocation: { lat: 40.68, lng: -73.99, streetAddress: '1 Court St' },
            parkingType: 'street',
            orderType: 'parking',
            duration: 120,
            pickUpTime: new Date(),
            status: 'pending',
            totalAmount: 1300,
            paymentMethod: 'card',
            paymentStatus: 'paid',
        });

        const { res } = await update(order._id, { review: { rating: 5 } });
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
    });
});
