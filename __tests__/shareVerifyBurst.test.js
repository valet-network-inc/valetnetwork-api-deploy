/**
 * The doorman link is a bearer credential guarding a six-digit code, so the
 * only thing between a forwarded link and somebody's car is the guess cap.
 * This is the regression for the day it did not hold.
 */
// Only the mint needs firebase-admin here: it wants the customer's Firebase ID
// token before it will hand a link out (`callerFirebaseUid`). A token is the
// string `uid:<firebaseUid>`. Nothing on the verify path reaches Firestore —
// these orders carry no conversation, so the arrival check returns before it
// looks.
jest.mock('firebase-admin', () => ({
    auth: () => ({
        verifyIdToken: async (token) => {
            const match = /^uid:(.+)$/.exec(String(token));
            if (!match) throw new Error('Decoding Firebase ID token failed');
            return { uid: match[1] };
        },
    }),
}));

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

let phoneSeq = 9175551000;
const makeUser = (isValet = false, extra = {}) => User.create({
    firstName: isValet ? 'Marco' : 'Randi',
    lastName: 'Tester',
    email: `u${new mongoose.Types.ObjectId()}@example.com`,
    phone: String(++phoneSeq),
    firebaseUid: `uid_${phoneSeq}`,
    verified: true,
    isValet,
    ...extra,
});

const CURB = { lat: 40.6798, lng: -73.9899, streetAddress: '296 12th St' };

const liveOtp = (code, type) => ({
    code, createdAt: new Date(),
    expiresAt: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000),
    verified: false, type,
});

const makeTypeItOrder = (customerId, valetId, code = '481902') => Order.create({
    customer: customerId, customerLocation: CURB, parkingType: 'street',
    orderType: 'parking', serviceType: 'park-and-hold', duration: 120,
    pickUpTime: new Date(), status: 'accepted', totalAmount: 1650,
    paymentMethod: 'card', paymentStatus: 'paid',
    vehicle: { color: 'Grey', model: 'Honda Civic', licensePlate: 'ABC1234' },
    valet: valetId, acceptedAt: new Date(),
    otp: liveOtp(code, 'order_creation'),
});

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => { await Order.deleteMany({}); await User.deleteMany({}); });

test('a concurrent burst cannot outrun the absolute guess cap', async () => {
    const customer = await makeUser();
    const valet = await makeUser(true);
    await makeTypeItOrder(customer._id, valet._id);
    const mint = await request(app)
        .post('/api/share/link')
        .set('Authorization', `Bearer uid:${customer.firebaseUid}`)
        .send({ userId: String(customer._id) });
    const token = mint.body.token;

    // 200 wrong guesses fired at once, no waiting between them. Counting a
    // try on the way out instead of the way in let all 200 pass a counter
    // still reading zero: 196 were graded, and a six-digit code stopped
    // being six digits.
    const res = await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
            request(app).post(`/api/share/${token}/verify`).send({ otp: String(100000 + i) })
        )
    );
    const wrongCodeAnswers = res.filter((r) => r.status === 400 && /Invalid OTP/.test(r.body.message || '')).length;
    const locked = res.filter((r) => r.status === 429 && r.body.locked).length;
    const paced = res.filter((r) => r.status === 429 && !r.body.locked).length;
    expect(wrongCodeAnswers).toBeLessThanOrEqual(10);   // the documented cap
    expect(locked + paced).toBe(200 - wrongCodeAnswers);
});
