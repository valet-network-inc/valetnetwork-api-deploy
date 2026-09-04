/**
 * `updateOrder` used to hand the caller's `updates` object straight to
 * `findByIdAndUpdate`. Order ids are published unauthenticated by
 * `getPendingOrders`, so anyone could set any field on any order — and
 * `totalAmount` is what the valet-pay hook takes 70% of.
 */
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
// The controller emits socket events on every write; without a stub it throws
// on `req.io.to(...)` and every call comes back 500, which would make the two
// attack assertions below pass for the wrong reason.
const emitted = [];
app.use((req, _res, next) => {
    req.io = {
        emit: (...a) => emitted.push(a),
        to: () => ({ emit: (...a) => emitted.push(a) }),
    };
    next();
});
app.use('/api/order', orderRouter);

const CURB = { lat: 40.6798, lng: -73.9899, streetAddress: '296 12th St' };
let seq = 9175557000;

const makeUser = (isValet = false) =>
    User.create({
        firstName: isValet ? 'Marco' : 'Randi',
        lastName: 'Tester',
        email: `u${new mongoose.Types.ObjectId()}@example.com`,
        phone: String(++seq),
        firebaseUid: `uid_${seq}`,
        verified: true,
        isValet,
    });

const makeOrder = (customerId, valetId) =>
    Order.create({
        customer: customerId,
        valet: valetId,
        customerLocation: CURB,
        parkingType: 'street',
        orderType: 'parking',
        serviceType: 'park-and-hold',
        duration: 120,
        pickUpTime: new Date(),
        status: 'accepted',
        totalAmount: 1000,
        paymentMethod: 'card',
        paymentStatus: 'paid',
        vehicle: { color: 'Grey', model: 'Honda Civic', licensePlate: 'ABC1234' },
    });

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
});
afterEach(async () => {
    await Order.deleteMany({});
    await User.deleteMany({});
});

test('a caller cannot inflate the amount the valet gets paid from', async () => {
    const customer = await makeUser();
    const valet = await makeUser(true);
    const order = await makeOrder(customer._id, valet._id);

    await request(app)
        .post('/api/order/updateOrder')
        .send({
            orderId: String(order._id),
            updates: { status: 'completed', totalAmount: 500000, creditedValet: false },
        });

    const after = await Order.findById(order._id).lean();
    expect(after.totalAmount).toBe(1000);
});

test('a caller cannot mark an unpaid order paid, or hand the job to themselves', async () => {
    const customer = await makeUser();
    const valet = await makeUser(true);
    const stranger = await makeUser(true);
    const order = await makeOrder(customer._id, valet._id);
    await Order.updateOne({ _id: order._id }, { $set: { paymentStatus: 'pending' } });

    await request(app)
        .post('/api/order/updateOrder')
        .send({
            orderId: String(order._id),
            updates: { paymentStatus: 'paid', valet: String(stranger._id) },
        });

    const after = await Order.findById(order._id).lean();
    expect(after.paymentStatus).toBe('pending');
    expect(String(after.valet)).toBe(String(valet._id));
});

test('the fields the shipped clients actually send still go through', async () => {
    const customer = await makeUser();
    const valet = await makeUser(true);
    const order = await makeOrder(customer._id, valet._id);

    // `review` is the customer's own write and the one this bare harness can
    // run end to end — the valet's parked+parkingLocation path reaches the
    // notification and custody hooks, which need an io and a Firebase app this
    // suite deliberately does not stand up. Both `status` and `parkingLocation`
    // are exercised for real by __tests__/parkCloseOutSwipe.test.js.
    const res = await request(app)
        .post('/api/order/updateOrder')
        .send({
            orderId: String(order._id),
            updates: { review: { rating: 5, comment: 'great' } },
        });

    expect(res.status).toBe(200);
    const after = await Order.findById(order._id).lean();
    expect(after.review.rating).toBe(5);
    expect(after.review.comment).toBe('great');
});
