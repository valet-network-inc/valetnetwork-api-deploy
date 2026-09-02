/**
 * "Swipe to End Order" has to actually close the park out.
 * Run: npx jest parkCloseOutSwipe
 *
 * `parkClosedAt` is what turns a park into a keys-held ticket: it is what
 * gives the customer the "bring my car back" button and the cancel-for-refund,
 * what takes the job off the valet's screen, and what lets them book again at
 * all. Nothing on a phone was setting it. `updateOrder` only stamped it for the
 * retired 'parked-with-keys' spelling or an explicit `parkClosed` flag, and the
 * shipped valet build sends neither — it sends a bare `{ status: 'parked' }`.
 * Every Park & Retrieve customer since the collapse to one parked state has
 * been stuck until somebody edited Mongo by hand.
 *
 * The whole difficulty is that the FIRST save of the parking spot sends that
 * same `{ status: 'parked' }`, minutes earlier, while the valet is still
 * walking the keys back. Closing the park there would take the job off their
 * screen mid-task. So these tests are mostly about the saves that must NOT
 * close it.
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

const mockIo = () => ({
    emit: () => {},
    to: () => ({ emit: () => {} }),
});

let phoneSeq = 7185550000;
const makeUser = (isValet = false) => User.create({
    firstName: isValet ? 'Marco' : 'Randi',
    lastName: 'Tester',
    email: `u${new mongoose.Types.ObjectId()}@example.com`,
    phone: String(++phoneSeq),
    verified: true,
    isValet,
});

const SPOT = { lat: 40.68016, lng: -73.99266, streetAddress: '336 President St' };

const makePark = (customerId, valetId, extra = {}) => Order.create({
    customer: customerId,
    valet: valetId,
    customerLocation: { lat: 40.6798, lng: -73.9899, streetAddress: '296 12th St' },
    parkingType: 'street',
    orderType: 'parking',
    serviceType: 'park-and-hold',
    duration: 120,
    pickUpTime: new Date(),
    status: 'accepted',
    totalAmount: 1650,
    paymentMethod: 'card',
    paymentStatus: 'paid',
    vehicle: { color: 'Grey', model: 'Honda Civic', licensePlate: 'ABC1234' },
    otpVerifiedTimes: { orderCreation: new Date() },
    ...extra,
});

const update = async (orderId, updates) => {
    const req = { body: { orderId: String(orderId), updates }, io: mockIo() };
    const res = mockRes();
    await orderController.updateOrder(req, res);
    return res;
};

const closedAt = async (orderId) =>
    (await Order.findById(orderId)).parkClosedAt;

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

test('the swipe closes the park, on the build already on phones', async () => {
    const customer = await makeUser();
    const valet = await makeUser(true);
    // Where a park stands when the valet swipes: car parked, keys handed back.
    const order = await makePark(customer._id, valet._id, {
        status: 'parked',
        parkingLocation: SPOT,
        parkedAt: new Date(),
        otpVerifiedTimes: { orderCreation: new Date(), returnKey: new Date() },
    });

    const res = await update(order._id, { status: 'parked' });

    expect(res.statusCode).toBe(200);
    expect(await closedAt(order._id)).toBeTruthy();
});

test('the first save of the parking spot does not — the valet is still walking the keys over', async () => {
    const customer = await makeUser();
    const valet = await makeUser(true);
    const order = await makePark(customer._id, valet._id);

    const res = await update(order._id, { status: 'parked', parkingLocation: SPOT });

    expect(res.statusCode).toBe(200);
    expect(await closedAt(order._id)).toBeUndefined();
    expect((await Order.findById(order._id)).status).toBe('parked');
});

test('an enterprise dispatch stays on its own close-out path', async () => {
    const customer = await makeUser();
    const valet = await makeUser(true);
    const order = await makePark(customer._id, valet._id, {
        status: 'parked',
        parkingLocation: SPOT,
        parkedAt: new Date(),
        endCustomerName: 'Suite 4B',
        otpVerifiedTimes: { orderCreation: new Date(), returnKey: new Date() },
    });

    await update(order._id, { status: 'parked' });

    expect(await closedAt(order._id)).toBeUndefined();
});

test('a street-cleaning move is untouched — the valet keeps the keys through the sweep', async () => {
    const customer = await makeUser();
    const valet = await makeUser(true);
    // An ASP order is a park-and-hold park like any other; what it never has
    // while the car sits is a key handoff, because the keys never went back.
    const order = await makePark(customer._id, valet._id, {
        status: 'parked',
        parkingLocation: SPOT,
        parkedAt: new Date(),
        aspMode: true,
    });

    await update(order._id, { status: 'parked' });

    expect(await closedAt(order._id)).toBeUndefined();
});

test('an already-closed park is not restamped by a later save', async () => {
    const customer = await makeUser();
    const valet = await makeUser(true);
    const firstClose = new Date(Date.now() - 60 * 60 * 1000);
    const order = await makePark(customer._id, valet._id, {
        status: 'parked',
        parkingLocation: SPOT,
        parkedAt: new Date(),
        parkClosedAt: firstClose,
        otpVerifiedTimes: { orderCreation: new Date(), returnKey: new Date() },
    });

    await update(order._id, { status: 'parked' });

    expect((await closedAt(order._id)).getTime()).toBe(firstClose.getTime());
});

test('the retired spelling still closes it, for anyone on an older build', async () => {
    const customer = await makeUser();
    const valet = await makeUser(true);
    const order = await makePark(customer._id, valet._id, {
        status: 'parked',
        parkingLocation: SPOT,
        parkedAt: new Date(),
    });

    await update(order._id, { status: 'parked-with-keys' });

    expect(await closedAt(order._id)).toBeTruthy();
    expect((await Order.findById(order._id)).status).toBe('parked');
});
