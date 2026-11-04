/**
 * The car a valet's form opens with, for a customer we've parked before.
 * Run: npx jest suggestedVehicle
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Order = require('../models/Order');
const User = require('../models/User');
const { suggestedVehicleFor } = require('../services/accountVehicle');

let mongo;
let phoneSeq = 5593000000;
const makeUser = (extra = {}) => User.create({
    firstName: 'Cust', lastName: 'Tester', email: `u${new mongoose.Types.ObjectId()}@example.com`,
    phone: String(++phoneSeq), verified: true, ...extra,
});
const makeOrder = (customer, vehicle, createdAt) => Order.create({
    customer: customer._id,
    customerLocation: { lat: 40.68652, lng: -73.99213, streetAddress: '38 Wyckoff St' },
    parkingType: 'street', orderType: 'parking', duration: 90, pickUpTime: new Date(),
    status: 'completed', totalAmount: 1000, paymentMethod: 'card', paymentStatus: 'paid',
    serviceType: 'standard', vehicle, createdAt,
});

beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); }, 60000);
afterAll(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });
afterEach(async () => { await Order.deleteMany({}); await User.deleteMany({}); });

test("the account's own car comes first", async () => {
    const c = await makeUser({ vehicle: { color: 'Blue', model: 'Subaru Outback', licensePlate: 'KDT4417', source: 'customer' } });
    await makeOrder(c, { color: 'Red', model: 'Honda Fit', licensePlate: 'ZZZ9999' });
    const v = await suggestedVehicleFor(c._id);
    expect(v.licensePlate).toBe('KDT4417');
});

test('else the last real-looking car a valet noted', async () => {
    const c = await makeUser();
    await makeOrder(c, { color: 'Red', model: 'Honda Fit', licensePlate: 'ABC1234' }, new Date(Date.now() - 86400000));
    await makeOrder(c, { color: 'Grey', model: 'Toyota RAV4', licensePlate: 'LMN5678' }, new Date());
    const v = await suggestedVehicleFor(c._id);
    expect(v.model).toBe('Toyota RAV4');
});

test('nothing for someone we have never parked, or junk entries', async () => {
    const fresh = await makeUser();
    expect(await suggestedVehicleFor(fresh._id)).toBeNull();
    const junk = await makeUser();
    await makeOrder(junk, { licensePlate: 'X' });
    expect(await suggestedVehicleFor(junk._id)).toBeNull();
});
