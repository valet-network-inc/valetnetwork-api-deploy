/**
 * More than one car, and a second car on a plan (Nov 4 2026).
 * Run: npx jest accountCars
 *
 * Rishi: "enable people to add multiple cars in the your car section of the
 * app, and when a linked account adds a different vehicle (linked accounts
 * initially default to whatever car is already in the your car section in
 * profile), and if it's the same car by the end of the transaction, it gets
 * saved to the linked account as well. also, if an account is on a plan, and
 * another account is added to the plan, an additional car on the plan is
 * another $150/mo."
 *
 *  1. The account keeps a list of cars, first = the one we expect next;
 *     `vehicle` mirrors it for apps from before the list.
 *  2. Linking copies one side's cars into the other's empty list.
 *  3. A park that ends on the car the customer's side named shares that car
 *     with the linked partner; a car the valet found to be another never does.
 *  4. A plan with an extra car covers two parks of a pair at once, and two
 *     free parks a day; the holder adds the car at $150/mo through Stripe.
 */
jest.setTimeout(30000);

jest.mock('firebase-admin', () => ({
    auth: () => ({
        verifyIdToken: async (token) => {
            const m = /^uid:(.+)$/.exec(String(token));
            if (!m) throw new Error('Decoding Firebase ID token failed');
            return { uid: m[1] };
        },
    }),
    messaging: () => ({
        send: async () => 'mock',
        sendEachForMulticast: async () => ({ responses: [], successCount: 0, failureCount: 0 }),
    }),
    firestore: () => ({
        collection: () => ({
            doc: () => ({
                get: async () => ({ exists: false, data: () => null }),
                set: async () => {},
                update: async () => {},
                collection: () => ({ add: async () => {}, get: async () => ({ docs: [] }) }),
            }),
            add: async () => {},
            where: () => ({ get: async () => ({ docs: [], empty: true }) }),
        }),
    }),
    apps: [{}],
    initializeApp: () => {},
    credential: { cert: () => ({}), applicationDefault: () => ({}) },
    storage: () => ({ bucket: () => ({ file: () => ({}) }) }),
}));

process.env.NODE_ENV = 'test';
delete process.env.STRIPE_API_KEY;

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const User = require('../models/User');
const Order = require('../models/Order');
const Subscription = require('../models/Subscription');
const AccountLink = require('../models/AccountLink');
const CurbCustody = require('../models/CurbCustody');
const accountLinkRouter = require('../routes/accountLink');
const subscriptionRouter = require('../routes/subscription');
const authController = require('../controllers/authController');
const orderController = require('../controllers/orderController');
const notificationController = require('../controllers/notificationController');
const subscriptionService = require('../services/subscriptionService');
const accountLinks = require('../services/accountLinks');
const accountVehicle = require('../services/accountVehicle');
const stripeClient = require('../services/stripeClient');
const subscriptionPrices = require('../services/subscriptionPrices');

let mongo;

const mockRes = () => {
    const res = { statusCode: 200, body: null };
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (payload) => {
        res.body = payload;
        return res;
    };
    return res;
};
const mockIo = () => ({ emit: () => {}, to: () => ({ emit: () => {} }) });

const app = express();
app.use(express.json());
app.use((req, res, next) => {
    req.io = mockIo();
    next();
});
app.use('/api/account-link', accountLinkRouter);
app.use('/api/subscription', subscriptionRouter);

let phoneSeq = 6465552000;
const makeUser = (extra = {}) => {
    const n = ++phoneSeq;
    return User.create({
        firstName: 'Sam',
        lastName: 'Tester',
        phone: `+1${n}`,
        firebaseUid: `uid_${n}`,
        verified: true,
        ...extra,
    });
};
const as = (user) => ['Authorization', `Bearer uid:${user.firebaseUid}`];

const HOME = { lat: 40.679, lng: -73.995, streetAddress: '123 Court St, Brooklyn' };
const DAY = 24 * 60 * 60 * 1000;
let planSeq = 0;
const makePlan = (user, extra = {}) =>
    Subscription.create({
        user: user._id,
        tier: 'home_garage',
        interval: 'month',
        status: 'active',
        amountCents: 30000,
        stripeCustomerId: `cus_cars${++planSeq}`,
        stripeSubscriptionId: `sub_cars${planSeq}`,
        currentPeriodEnd: new Date(Date.now() + 30 * DAY),
        homeAddress: HOME,
        ...extra,
    });
const makeOrder = (customer, extra = {}) =>
    Order.create({
        customer: customer._id,
        customerLocation: HOME,
        parkingType: 'street',
        orderType: 'parking',
        serviceType: 'standard',
        duration: 120,
        pickUpTime: new Date(),
        status: 'parked',
        totalAmount: 1500,
        paymentMethod: 'card',
        paymentStatus: 'paid',
        ...extra,
    });

const linkPair = async (approver, requester) => {
    const sent = await request(app)
        .post('/api/account-link/request')
        .set(...as(requester))
        .send({ userId: String(requester._id), phone: approver.phone });
    expect(sent.statusCode).toBe(200);
    const ok = await request(app)
        .post('/api/account-link/authorize')
        .set(...as(approver))
        .send({ userId: String(approver._id), linkId: String(sent.body.link._id) });
    expect(ok.statusCode).toBe(200);
};

const carsOn = async (user) => {
    const u = await User.findById(user._id).select('+vehicle +vehicles').lean();
    return { list: accountVehicle.carsOf(u).map((v) => v.licensePlate), vehicle: u.vehicle && u.vehicle.licensePlate };
};

const updateUser = async (user, body) => {
    const res = mockRes();
    await authController.updateUser({ body: { phone: user.phone, ...body } }, res);
    expect(res.statusCode).toBe(200);
    return res.body;
};

/** Let the completion hook (setImmediate, then a few awaits) finish. */
const settle = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 50));
};

const BLUE = { color: 'Blue', model: 'Subaru Outback', licensePlate: 'KDT-4417' };
const SILVER = { color: 'Silver', model: 'Honda Civic', licensePlate: 'JKL-2210' };
const RED = { color: 'Red', model: 'Mazda 3', licensePlate: 'RTE-5521' };

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await AccountLink.syncIndexes();
    await User.init();
    await Order.init();
    await Subscription.init();
    await CurbCustody.init();
}, 60000);

afterAll(async () => {
    await settle();
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
});

beforeEach(() => {
    jest.spyOn(notificationController, 'sendPushNotification').mockResolvedValue({ success: true });
});

afterEach(async () => {
    jest.restoreAllMocks();
    stripeClient.reset();
    subscriptionPrices.clearPriceCache();
    await settle();
    await Promise.all([
        AccountLink.deleteMany({}),
        Order.deleteMany({}),
        Subscription.deleteMany({}),
        CurbCustody.deleteMany({}),
        User.deleteMany({}),
    ]);
});

describe('the list of cars', () => {
    it('keeps every car, one per plate, first mirrored as `vehicle`', async () => {
        const sam = await makeUser();
        const body = await updateUser(sam, { vehicles: [BLUE, SILVER, { ...BLUE, color: 'Navy' }] });
        expect(body.user.vehicles.map((v) => v.licensePlate)).toEqual(['KDT-4417', 'JKL-2210']);
        expect(await carsOn(sam)).toEqual({ list: ['KDT-4417', 'JKL-2210'], vehicle: 'KDT-4417' });
    });

    it('an app from before the list sends one car: it goes first, the rest stay', async () => {
        const sam = await makeUser();
        await updateUser(sam, { vehicles: [BLUE, SILVER] });
        await updateUser(sam, { vehicle: { ...SILVER, color: 'Grey' } });
        const u = await User.findById(sam._id).select('+vehicles').lean();
        expect(u.vehicles.map((v) => `${v.color} ${v.licensePlate}`)).toEqual(['Grey JKL-2210', 'Blue KDT-4417']);
        // All three blank takes the first car off.
        await updateUser(sam, { vehicle: { color: '', model: '', licensePlate: '' } });
        expect(await carsOn(sam)).toEqual({ list: ['KDT-4417'], vehicle: 'KDT-4417' });
    });

    it('an account from before the list reads as a list of one', async () => {
        const sam = await makeUser({ vehicle: { ...BLUE, source: 'customer' } });
        expect((await carsOn(sam)).list).toEqual(['KDT-4417']);
    });

    it("the valet's car goes first, replacing the same plate", async () => {
        const sam = await makeUser();
        await updateUser(sam, { vehicles: [BLUE, SILVER] });
        const order = await makeOrder(sam);
        await accountVehicle.copyOrderCarToAccount(order, { ...SILVER, color: 'Charcoal' });
        const u = await User.findById(sam._id).select('+vehicles').lean();
        expect(u.vehicles.map((v) => `${v.color} ${v.licensePlate} ${v.source}`)).toEqual([
            'Charcoal JKL-2210 valet',
            'Blue KDT-4417 customer',
        ]);
    });

    it('the valet is offered the first car on the list', async () => {
        const sam = await makeUser();
        await updateUser(sam, { vehicles: [SILVER, BLUE] });
        const s = await accountVehicle.suggestedVehicleFor(sam._id);
        expect(s.licensePlate).toBe('JKL-2210');
    });

    it("a user's car on their live trip goes on the order's suggestion, never on `vehicle`", async () => {
        const sam = await makeUser();
        const order = await makeOrder(sam, { status: 'accepted' });
        const res = mockRes();
        await orderController.updateOrder(
            { body: { orderId: String(order._id), updates: { suggestedVehicle: { ...RED, licensePlate: 'rte 5521' } } }, io: mockIo() },
            res
        );
        const after = await Order.findById(order._id).lean();
        expect(after.suggestedVehicle.licensePlate).toBe('RTE 5521');
        expect(after.vehicle && after.vehicle.color).toBeFalsy();
    });
});

describe('a linked pair', () => {
    it("linking copies one side's cars into the other's empty list", async () => {
        const rishi = await makeUser({ firstName: 'Rishi' });
        const alex = await makeUser({ firstName: 'Alex' });
        await updateUser(rishi, { vehicles: [BLUE, SILVER] });
        await linkPair(rishi, alex);
        expect(await carsOn(alex)).toEqual({ list: ['KDT-4417', 'JKL-2210'], vehicle: 'KDT-4417' });
    });

    it('a park that ends on the car the customer named shares it with the partner', async () => {
        const rishi = await makeUser({ firstName: 'Rishi' });
        const alex = await makeUser({ firstName: 'Alex' });
        await updateUser(rishi, { vehicles: [BLUE] });
        await linkPair(rishi, alex);
        // Alex parks a different car: named it on the live trip, the valet confirmed it.
        const order = await makeOrder(alex, { suggestedVehicle: RED, vehicle: { ...RED, keyTagNumber: '12' } });
        await Order.findByIdAndUpdate(order._id, { status: 'completed' });
        await settle();
        expect((await carsOn(rishi)).list).toEqual(['KDT-4417', 'RTE-5521']);
        // Rishi's first car is still the one we expect for him.
        expect((await carsOn(rishi)).vehicle).toBe('KDT-4417');
    });

    it('also when the park completes through save()', async () => {
        const rishi = await makeUser({ firstName: 'Rishi' });
        const alex = await makeUser({ firstName: 'Alex' });
        await linkPair(rishi, alex);
        const order = await makeOrder(alex, { suggestedVehicle: RED, vehicle: RED });
        order.status = 'completed';
        await order.save();
        await settle();
        expect((await carsOn(rishi)).list).toEqual(['RTE-5521']);
    });

    it('a car the valet found to be a different one never travels', async () => {
        const rishi = await makeUser({ firstName: 'Rishi' });
        const alex = await makeUser({ firstName: 'Alex' });
        await updateUser(rishi, { vehicles: [BLUE] });
        await linkPair(rishi, alex);
        const order = await makeOrder(alex, { suggestedVehicle: RED, vehicle: SILVER });
        await Order.findByIdAndUpdate(order._id, { status: 'completed' });
        await settle();
        expect((await carsOn(rishi)).list).toEqual(['KDT-4417']);
    });

    it('nothing is shared before the park ends, or without a link', async () => {
        const rishi = await makeUser({ firstName: 'Rishi' });
        const alex = await makeUser({ firstName: 'Alex' });
        const order = await makeOrder(alex, { suggestedVehicle: RED, vehicle: RED });
        await Order.findByIdAndUpdate(order._id, { status: 'completed' });
        await settle();
        expect((await carsOn(rishi)).list).toEqual([]);
        await linkPair(rishi, alex);
        const parked = await makeOrder(alex, { suggestedVehicle: SILVER, vehicle: SILVER });
        await Order.findByIdAndUpdate(parked._id, { status: 'parked' });
        await settle();
        expect((await carsOn(rishi)).list).toEqual([]);
    });
});

describe('a second car on the plan', () => {
    const fakeStripe = () => {
        const calls = [];
        const stub = {
            calls,
            prices: {
                // Only the plan's anchor price exists; anything else is minted.
                list: async ({ lookup_keys: keys }) => ({
                    data: keys[0] === subscriptionPrices.GARAGE_ANCHOR_LOOKUP_KEY ? [{ id: 'price_anchor', active: true, product: 'prod_garage' }] : [],
                }),
                create: async (p) => {
                    calls.push(['prices.create', p]);
                    return { id: `price_${p.lookup_key}` };
                },
            },
            subscriptionItems: {
                create: async (p) => {
                    calls.push(['items.create', p]);
                    return { id: 'si_extra' };
                },
                update: async (id, p) => {
                    calls.push(['items.update', id, p]);
                    return { id };
                },
                del: async (id, p) => {
                    calls.push(['items.del', id, p]);
                    return { id, deleted: true };
                },
            },
        };
        stripeClient.set(stub);
        return stub;
    };
    const addCar = (user) =>
        request(app).post('/api/subscription/extra-car').set(...as(user)).send({ userId: String(user._id) });
    const removeCar = (user) =>
        request(app).post('/api/subscription/extra-car/remove').set(...as(user)).send({ userId: String(user._id) });

    it('the holder adds a car at $150 a month: one Stripe item, prorated now', async () => {
        const stub = fakeStripe();
        const rishi = await makeUser();
        await makePlan(rishi);
        const res = await addCar(rishi);
        expect(res.statusCode).toBe(200);
        expect(res.body.subscription).toMatchObject({ extraCars: 1, carsOnPlan: 2, extraCarAmountCents: 15000, canAddCar: true });
        const create = stub.calls.find((c) => c[0] === 'items.create');
        expect(create[1]).toMatchObject({
            subscription: 'sub_cars1',
            quantity: 1,
            proration_behavior: 'always_invoice',
            metadata: { vn: 'extra_car' },
        });
        expect(stub.calls.find((c) => c[0] === 'prices.create')[1]).toMatchObject({
            unit_amount: 15000,
            recurring: { interval: 'month' },
            lookup_key: 'vn_extra_car_month_c15000',
        });
        // A second one raises the quantity; a third is refused.
        expect((await addCar(rishi)).body.subscription.carsOnPlan).toBe(3);
        expect(stub.calls.find((c) => c[0] === 'items.update')[2]).toMatchObject({ quantity: 2 });
        const third = await addCar(rishi);
        expect(third.statusCode).toBe(400);
        expect(third.body.code).toBe('max_cars');
    });

    it('takes a car off with a credit on the next bill', async () => {
        const stub = fakeStripe();
        const rishi = await makeUser();
        await makePlan(rishi, { extraCars: 1, extraCarStripeItemId: 'si_extra', extraCarAmountCents: 15000 });
        const res = await removeCar(rishi);
        expect(res.statusCode).toBe(200);
        expect(res.body.subscription).toMatchObject({ extraCars: 0, carsOnPlan: 1 });
        expect(stub.calls.find((c) => c[0] === 'items.del')).toEqual(['items.del', 'si_extra', { proration_behavior: 'create_prorations' }]);
    });

    it('only the holder adds a car; street cleaning is by the move', async () => {
        fakeStripe();
        const rishi = await makeUser({ firstName: 'Rishi' });
        const alex = await makeUser({ firstName: 'Alex' });
        await makePlan(rishi);
        await linkPair(rishi, alex);
        const partner = await addCar(alex);
        expect(partner.statusCode).toBe(403);
        expect(partner.body.code).toBe('not_plan_holder');

        const sam = await makeUser();
        await makePlan(sam, { tier: 'street_cleaning', amountCents: 10000, movesPerWeek: 2 });
        const perMove = await addCar(sam);
        expect(perMove.statusCode).toBe(400);
        expect(perMove.body.code).toBe('per_move_plan');
    });

    it("the partner's plan view shows the cars but not the add switch", async () => {
        const rishi = await makeUser({ firstName: 'Rishi' });
        const alex = await makeUser({ firstName: 'Alex' });
        await makePlan(rishi, { extraCars: 1 });
        await linkPair(rishi, alex);
        const res = await request(app)
            .get(`/api/subscription/status/${alex._id}`)
            .set(...as(alex));
        expect(res.statusCode).toBe(200);
        expect(res.body.subscription.carsOnPlan).toBe(2);
        expect(res.body.subscription.canAddCar).toBeFalsy();
    });

    it("with two cars on it, a partner's park no longer blocks the other's", async () => {
        const rishi = await makeUser({ firstName: 'Rishi' });
        const alex = await makeUser({ firstName: 'Alex' });
        const sub = await makePlan(rishi);
        await linkPair(rishi, alex);
        await makeOrder(alex, { status: 'parked', coveredBySubscription: sub._id, indefinite: true });
        expect(await accountLinks.householdCoveredParkLive(sub, rishi._id)).toBe(true);
        sub.extraCars = 1;
        await sub.save();
        expect(await accountLinks.householdCoveredParkLive(sub, rishi._id)).toBe(false);
    });

    it('two cars, two free parks a day', async () => {
        const rishi = await makeUser();
        const sub = await makePlan(rishi, { extraCars: 1 });
        await makeOrder(rishi, { coveredBySubscription: sub._id, status: 'completed' });
        const second = await subscriptionService.evaluateParkCoverage(sub, { lat: HOME.lat, lng: HOME.lng, listPriceCents: 1000 });
        expect(second.covered).toBe(true);
        await makeOrder(rishi, { coveredBySubscription: sub._id, status: 'completed' });
        const third = await subscriptionService.evaluateParkCoverage(sub, { lat: HOME.lat, lng: HOME.lng, listPriceCents: 1000 });
        expect(third).toMatchObject({ covered: false, reason: 'daily_free_park_used' });
    });
});
