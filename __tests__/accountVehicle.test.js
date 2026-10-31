/**
 * The car on the account (services/accountVehicle.js). The Your car screen's
 * save has to stick, and the car a valet logs has to land on the customer's
 * account, but never on a doorman's, whose orders carry their guests' cars.
 */
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../models/Order');
const User = require('../models/User');
const authRouter = require('../routes/auth');
const orderRouter = require('../routes/order');

let mongo;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    req.io = { emit: () => {}, to: () => ({ emit: () => {} }) };
    next();
});
app.use('/api/auth', authRouter);
app.use('/api/order', orderRouter);

const CURB = { lat: 40.6798, lng: -73.9899, streetAddress: '296 12th St' };
const CAR = { color: 'Black', model: 'Subaru Forester', licensePlate: 'mjz-5749' };
let seq = 9175558000;

const makeUser = (extra = {}) =>
    User.create({
        firstName: 'Randi',
        lastName: 'Tester',
        email: `u${new mongoose.Types.ObjectId()}@example.com`,
        phone: String(++seq),
        firebaseUid: `uid_${seq}`,
        verified: true,
        ...extra,
    });

const makeOrder = (customerId, valetId, extra = {}) =>
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
        ...extra,
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

test('the Your car screen saves the car on the account', async () => {
    const user = await makeUser();
    const res = await request(app)
        .post('/api/auth/updateUser')
        .send({ phone: user.phone, vehicle: { color: ' Black ', model: 'Subaru Forester', licensePlate: 'mjz-5749' } });
    expect(res.status).toBe(200);

    const got = await request(app).get(`/api/auth/getUserById/${user._id}`);
    expect(got.body.user.vehicle).toMatchObject({
        color: 'Black',
        model: 'Subaru Forester',
        licensePlate: 'MJZ-5749',
        source: 'customer',
    });
});

test('all three fields blank clears the car, and a car with no plate is ignored', async () => {
    const user = await makeUser({ vehicle: { color: 'Black', model: 'Subaru Forester', licensePlate: 'MJZ-5749', source: 'valet' } });

    await request(app).post('/api/auth/updateUser').send({ phone: user.phone, vehicle: { color: 'Red', model: 'Mini', licensePlate: '' } });
    expect((await User.findById(user._id).lean()).vehicle.licensePlate).toBe('MJZ-5749');

    await request(app).post('/api/auth/updateUser').send({ phone: user.phone, vehicle: { color: '', model: '', licensePlate: '' } });
    expect((await User.findById(user._id).lean()).vehicle).toBeUndefined();
});

test('the car a valet logs lands on the customer account', async () => {
    const customer = await makeUser();
    const valet = await makeUser({ isValet: true });
    const order = await makeOrder(customer._id, valet._id);

    const res = await request(app)
        .post('/api/order/addVehicleInfo')
        .send({ orderId: String(order._id), vehicle: CAR });
    expect(res.status).toBe(200);

    const after = await User.findById(customer._id).lean();
    expect(after.vehicle).toMatchObject({
        color: 'Black',
        model: 'Subaru Forester',
        licensePlate: 'MJZ-5749',
        source: 'valet',
    });
    expect(String(after.vehicle.by)).toBe(String(valet._id));
});

test("a doorman's guest car stays off the doorman's account", async () => {
    const doorman = await makeUser({ isDoorman: true });
    const valet = await makeUser({ isValet: true });
    const order = await makeOrder(doorman._id, valet._id, { endCustomerName: 'Guest', endCustomerPhone: '9175550000' });

    const res = await request(app)
        .post('/api/order/addVehicleInfo')
        .send({ orderId: String(order._id), vehicle: CAR });
    expect(res.status).toBe(200);

    const after = await User.findById(doorman._id).lean();
    expect(after.vehicle && after.vehicle.licensePlate).toBeFalsy();
});

test('a note typed into the car fields never becomes the customer\'s car', async () => {
    const customer = await makeUser();
    const valet = await makeUser({ isValet: true });
    const order = await makeOrder(customer._id, valet._id);

    await request(app)
        .post('/api/order/addVehicleInfo')
        .send({ orderId: String(order._id), vehicle: { color: 'Can\u2019t find vehicle/phone won\u2019t dial', model: 'x', licensePlate: 'X' } });

    const after = await User.findById(customer._id).lean();
    expect(after.vehicle && after.vehicle.licensePlate).toBeFalsy();
});
