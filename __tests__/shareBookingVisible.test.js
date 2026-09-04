/**
 * The front desk books a car and looks at the standing link.
 *
 * `customerActiveOrderQuery` requires `paymentStatus: 'paid'`, so between
 * createOrder and the card confirming this page answered `idle` — the same
 * "nothing booked" screen it shows on a quiet Tuesday. Standing at the desk
 * watching that is most of why the front desk said codes take forever.
 */
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../models/Order');
const User = require('../models/User');
const shareRouter = require('../routes/share');

let mongo;
const app = express();
app.use(express.json());
app.use('/api/share', shareRouter);

const CURB = { lat: 40.6798, lng: -73.9899, streetAddress: '296 12th St' };
let phoneSeq = 9175559000;

const makeCustomerWithLink = async () => {
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('base64url');
    const user = await User.create({
        firstName: 'Dana',
        lastName: 'Reed',
        email: `u${new mongoose.Types.ObjectId()}@example.com`,
        phone: String(++phoneSeq),
        firebaseUid: `uid_${phoneSeq}`,
        verified: true,
        doormanLink: { token, createdAt: new Date() },
    });
    return { user, token };
};

const bookUnpaid = (customerId) =>
    Order.create({
        customer: customerId,
        customerLocation: CURB,
        parkingType: 'street',
        orderType: 'parking',
        serviceType: 'park-and-hold',
        duration: 180,
        pickUpTime: new Date(),
        status: 'pending',
        totalAmount: 1000,
        paymentMethod: 'card',
        paymentStatus: 'pending',
        vehicle: { color: 'Blue', model: 'Honda Civic', licensePlate: 'BB33122' },
        otp: {
            code: '333444',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 36e5),
            verified: false,
            type: 'order_creation',
        },
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

test('a booking whose card has not landed yet still shows the front desk a job', async () => {
    const { user, token } = await makeCustomerWithLink();
    await bookUnpaid(user._id);

    const res = await request(app).get(`/api/share/${token}`);

    expect(res.status).toBe(200);
    expect(res.body.handoff.stage).toBe('waiting');
});

test('an abandoned checkout does not haunt the desk forever', async () => {
    const { user, token } = await makeCustomerWithLink();
    const stale = await bookUnpaid(user._id);
    // Mongoose's timestamps plugin overwrites createdAt on save, so age the
    // document through the driver rather than the model.
    await Order.collection.updateOne(
        { _id: stale._id },
        { $set: { createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }
    );

    const res = await request(app).get(`/api/share/${token}`);

    expect(res.body.handoff.stage).toBe('idle');
});
