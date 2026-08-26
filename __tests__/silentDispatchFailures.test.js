/**
 * Three ways a job could go quiet without anybody seeing an error.
 * Run: npx jest silentDispatchFailures
 *
 * Every case here failed the same way in production: an exception the client
 * swallows by contract, so the customer's screen looks fine and the work never
 * reaches a valet.
 *
 *  1. `loginUser` was load-mutate-save. The app posts it twice on every launch,
 *     both copies loaded the same `__v`, the second save's version guard matched
 *     nothing and threw, and the 500 made AuthContext drop a signed-in customer
 *     back to the phone-number screen.
 *  2. `requestKeyReturn` populated `user`, a path the Order schema does not
 *     have. Mongoose's strictPopulate threw before any logic ran, so the
 *     enterprise key handoff 500'd on every call, always.
 *  3. The ASP sweep only looked at `status: 'parked'`. An away-mode job whose
 *     valet never stamped the park is still a car in that valet's hands, and it
 *     got neither move reminders nor its automatic return.
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.STRIPE_API_KEY = 'sk_test_mocked';

const Order = require('../models/Order');
const User = require('../models/User');

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

/* -------------------------------------------------------------------------- */

describe('loginUser survives the launch double-call', () => {
    const authController = require('../controllers/authController');

    const login = (phone, extra = {}) =>
        authController.loginUser(
            { body: { phone, firebaseUid: 'fb_' + phone, ...extra }, headers: {} },
            mockRes()
        );

    it('twelve simultaneous logins produce one user and no failures', async () => {
        const phone = '+15550001111';
        const calls = Array.from({ length: 12 }, () => {
            const res = mockRes();
            return authController
                .loginUser({ body: { phone, firebaseUid: 'fb_' + phone, platform: 'ios' }, headers: {} }, res)
                .then(() => res);
        });
        const responses = await Promise.all(calls);

        expect(responses.filter((r) => r.statusCode >= 500)).toHaveLength(0);
        expect(await User.countDocuments({ phone })).toBe(1);
    });

    it('does not rewrite cleaningSchedule defaults on a repeat login', async () => {
        const phone = '+15550002222';
        await login(phone, { platform: 'ios' });
        await User.updateOne({ phone }, { $unset: { cleaningSchedule: '' } });

        await login(phone);

        const user = await User.findOne({ phone }).lean();
        expect(user.cleaningSchedule).toBeUndefined();
    });

    it('keeps signupPlatform at where they signed up', async () => {
        const phone = '+15550003333';
        await login(phone, { platform: 'ios' });
        await login(phone, { platform: 'web' });

        const user = await User.findOne({ phone }).lean();
        expect(user.signupPlatform).toBe('ios');
    });

    it('still refuses a deleted account', async () => {
        const phone = '+15550004444';
        await login(phone, { platform: 'ios' });
        await User.updateOne({ phone }, { $set: { isDeleted: true } });

        const res = mockRes();
        await authController.loginUser({ body: { phone, firebaseUid: 'x' }, headers: {} }, res);
        expect(res.statusCode).toBe(403);
    });

    it('reports isNewUser until a name exists, then stops', async () => {
        const phone = '+15550005555';
        const first = mockRes();
        await authController.loginUser({ body: { phone, firebaseUid: 'x', platform: 'ios' }, headers: {} }, first);
        expect(first.body.isNewUser).toBe(true);

        await User.updateOne({ phone }, { $set: { firstName: 'Ada' } });

        const second = mockRes();
        await authController.loginUser({ body: { phone, firebaseUid: 'x' }, headers: {} }, second);
        expect(second.body.isNewUser).toBe(false);
    });
});

/* -------------------------------------------------------------------------- */

describe('the enterprise key handoff can actually start', () => {
    const orderController = require('../controllers/orderController');

    it('requestKeyReturn flips a parked order to keys-returning', async () => {
        const customer = await User.create({ phone: '+15550100001', firebaseUid: 'fbc1', verified: false, isDoorman: true });
        const valet = await User.create({ phone: '+15550100002', firebaseUid: 'fbv1', verified: false, isValet: true });
        const order = await Order.create({
            customer: customer._id,
            valet: valet._id,
            customerLocation: { lat: 40.68, lng: -73.99, streetAddress: '84 2nd Pl' },
            paymentMethod: 'card',
            totalAmount: 1300,
            paymentStatus: 'paid',
            status: 'parked',
            serviceType: 'park-and-hold',
            duration: 180,
            pickUpTime: new Date(),
        });

        const res = mockRes();
        await orderController.requestKeyReturn(
            { params: { orderId: order._id.toString() }, body: { valetId: valet._id.toString() } },
            res
        );

        expect(res.statusCode).toBe(200);
        expect((await Order.findById(order._id)).status).toBe('keys-returning');
    });

    it('a valet who is not on the order cannot start it', async () => {
        const customer = await User.create({ phone: '+15550100003', firebaseUid: 'fbc2', verified: false });
        const valet = await User.create({ phone: '+15550100004', firebaseUid: 'fbv2', verified: false, isValet: true });
        const stranger = await User.create({ phone: '+15550100005', firebaseUid: 'fbv3', verified: false, isValet: true });
        const order = await Order.create({
            customer: customer._id,
            valet: valet._id,
            customerLocation: { lat: 40.68, lng: -73.99, streetAddress: '84 2nd Pl' },
            paymentMethod: 'card',
            totalAmount: 1300,
            paymentStatus: 'paid',
            status: 'parked',
            duration: 180,
            pickUpTime: new Date(),
        });

        const res = mockRes();
        await orderController.requestKeyReturn(
            { params: { orderId: order._id.toString() }, body: { valetId: stranger._id.toString() } },
            res
        );

        expect(res.statusCode).toBe(403);
        expect((await Order.findById(order._id)).status).toBe('parked');
    });
});

/* -------------------------------------------------------------------------- */

describe('the ASP sweep can see an away job the valet never closed out', () => {
    it('picks up an away-mode order still sitting at accepted', async () => {
        const customer = await User.create({ phone: '+15550300001', firebaseUid: 'fbc7', verified: false });
        const valet = await User.create({ phone: '+15550300002', firebaseUid: 'fbv7', verified: false, isValet: true });

        const base = {
            customer: customer._id,
            valet: valet._id,
            customerLocation: { lat: 40.68, lng: -73.99, streetAddress: '84 2nd Pl' },
            paymentMethod: 'card',
            totalAmount: 1500,
            paymentStatus: 'paid',
            aspMode: true,
            awayMode: true,
            serviceType: 'park-and-hold',
            duration: 90,
            pickUpTime: new Date(),
            // Well in the future: this test is about visibility to the query,
            // not about minting a return leg.
            asp_time: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        };

        await Order.create({ ...base, status: 'accepted' });
        await Order.create({ ...base, status: 'parked' });

        const visible = await Order.find({
            aspMode: true,
            asp_time: { $exists: true, $ne: null },
            $or: [
                { status: 'parked' },
                { awayMode: true, status: { $in: ['accepted', 'in_progress', 'in-progress'] } },
            ],
            linkedOrderId: { $exists: false },
        });

        expect(visible.map((o) => o.status).sort()).toEqual(['accepted', 'parked']);
    });

    it('an ordinary (non-away) accepted order stays out of the sweep', async () => {
        const customer = await User.create({ phone: '+15550300003', firebaseUid: 'fbc8', verified: false });
        const valet = await User.create({ phone: '+15550300004', firebaseUid: 'fbv8', verified: false, isValet: true });

        await Order.create({
            customer: customer._id,
            valet: valet._id,
            customerLocation: { lat: 40.68, lng: -73.99, streetAddress: '84 2nd Pl' },
            paymentMethod: 'card',
            totalAmount: 1500,
            paymentStatus: 'paid',
            aspMode: true,
            awayMode: false,
            status: 'accepted',
            duration: 90,
            pickUpTime: new Date(),
            asp_time: new Date(Date.now() + 60 * 60 * 1000),
        });

        const visible = await Order.find({
            aspMode: true,
            asp_time: { $exists: true, $ne: null },
            $or: [
                { status: 'parked' },
                { awayMode: true, status: { $in: ['accepted', 'in_progress', 'in-progress'] } },
            ],
            linkedOrderId: { $exists: false },
        });

        expect(visible).toHaveLength(0);
    });
});
