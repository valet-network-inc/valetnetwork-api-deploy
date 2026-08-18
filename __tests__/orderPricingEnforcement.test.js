/**
 * The server prices the order; the client only quotes it.
 *
 * createOrder used to store req.body.totalAmount verbatim and
 * createPaymentIntent charged exactly that, on endpoints with no auth — so
 * anyone who could POST an order could name their own price, and because the
 * same field feeds valetPayBaseCents, an inflated one paid a valet 70% of an
 * invented number. These tests pin the amount to the customer's CHOICES.
 *
 * Also covers the two routes closed at the same time: PUT /api/pricing (which
 * sets the prices these orders are computed from) and the deleted
 * POST /api/payment/updatePaymentStatus.
 *
 * Run: npx jest orderPricingEnforcement
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');

process.env.NODE_ENV = 'test';
delete process.env.STRIPE_API_KEY;

const Order = require('../models/Order');
const User = require('../models/User');
const PricingConfig = require('../models/PricingConfig');
const orderController = require('../controllers/orderController');
const orderPricing = require('../services/orderPricing');

let mongod;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await Order.init();
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

afterEach(async () => {
    await Promise.all([Order.deleteMany({}), User.deleteMany({}), PricingConfig.deleteMany({})]);
});

// --------------------------------------------------------------------------
// Doubles + factories (same shape as subscriptionsV2.test.js)
// --------------------------------------------------------------------------

const mockRes = () => {
    const res = { statusCode: 0, body: null };
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

const mockIo = () => {
    const io = { emits: [] };
    io.emit = (event, payload) => io.emits.push({ event, payload });
    io.to = () => ({ emit: (event, payload) => io.emits.push({ event, payload }) });
    return io;
};

let phoneSeq = 8000000;
const makeCustomer = async () =>
    User.create({
        phone: `+1917${phoneSeq++}`,
        verified: true,
        firstName: 'Price',
        lastName: 'Tester',
    });

const HOME = { lat: 40.679, lng: -73.995, streetAddress: '123 Court St, Brooklyn' };

const createOrderVia = async (user, body) => {
    const req = {
        body: { customer: user._id.toString(), ...body },
        io: mockIo(),
        subscription: null,
        user,
    };
    const res = mockRes();
    await orderController.createOrder(req, res);
    return res;
};

const parkBody = (overrides = {}) => ({
    customerLocation: HOME,
    duration: 120,
    pickUpTime: new Date().toISOString(),
    orderType: 'parking',
    serviceType: 'standard',
    ...overrides,
});

// --------------------------------------------------------------------------

describe('createOrder prices server-side', () => {
    it('ignores a client that lowballs the price', async () => {
        const user = await makeCustomer();
        const res = await createOrderVia(user, parkBody({ totalAmount: 50 }));

        expect(res.statusCode).toBe(200);
        expect(res.body.order.totalAmount).toBe(1000);
    });

    it('ignores a client that inflates the price', async () => {
        // The dangerous direction: totalAmount feeds valetPayBaseCents, so an
        // inflated order pays a valet 70% of it on completion.
        const user = await makeCustomer();
        const res = await createOrderVia(user, parkBody({ totalAmount: 500000 }));

        expect(res.statusCode).toBe(200);
        expect(res.body.order.totalAmount).toBe(1000);
    });

    it('prices park-and-hold, ASP, and plain parking from their own fields', async () => {
        const hold = await createOrderVia(
            await makeCustomer(),
            parkBody({ serviceType: 'park-and-hold', totalAmount: 1 })
        );
        expect(hold.body.order.totalAmount).toBe(1300);

        const asp = await createOrderVia(
            await makeCustomer(),
            parkBody({ aspMode: true, duration: 90, serviceType: 'park-and-hold', totalAmount: 1 })
        );
        expect(asp.body.order.totalAmount).toBe(1500);

        const plain = await createOrderVia(await makeCustomer(), parkBody({ totalAmount: 1 }));
        expect(plain.body.order.totalAmount).toBe(1000);
    });

    it('adds Car Watch at the hourly rate and records the add-on server-side', async () => {
        // ASP is a fixed 90-minute move on every client, so Car Watch on an ASP
        // order is 1.5h = $1.50. $15 + $1.50 = $16.50 — the real August 18
        // charge.
        const user = await makeCustomer();
        const res = await createOrderVia(
            user,
            parkBody({
                aspMode: true,
                duration: 90,
                serviceType: 'park-and-hold',
                carWatch: true,
                carWatchAmount: 999999,
                totalAmount: 1,
            })
        );

        expect(res.body.order.totalAmount).toBe(1650);
        expect(res.body.order.carWatchAmount).toBe(150);
    });

    it('bills Car Watch off the booked duration for a non-ASP park', async () => {
        const user = await makeCustomer();
        const res = await createOrderVia(
            user,
            parkBody({ duration: 120, carWatch: true, totalAmount: 1 })
        );

        // 2h x $1/hr on top of the $10 park.
        expect(res.body.order.totalAmount).toBe(1200);
        expect(res.body.order.carWatchAmount).toBe(200);
    });

    it('follows PricingConfig rather than a hardcoded table', async () => {
        await PricingConfig.create({ key: 'default', aspCents: 2000 });

        const user = await makeCustomer();
        const res = await createOrderVia(
            user,
            parkBody({ aspMode: true, duration: 90, serviceType: 'park-and-hold', totalAmount: 1500 })
        );

        expect(res.body.order.totalAmount).toBe(2000);
    });

    it('refuses a client-declared free order', async () => {
        // `isFreeService: true` in the body used to zero the order and mark it
        // paid, with no event code and no authentication.
        const user = await makeCustomer();
        const res = await createOrderVia(
            user,
            parkBody({ isFreeService: true, totalAmount: 0 })
        );

        expect(res.statusCode).toBe(200);
        expect(res.body.order.isFreeService).toBe(false);
        expect(res.body.order.totalAmount).toBe(1000);
        expect(res.body.order.paymentStatus).toBe('pending');
    });
});

describe('orderPricing.priceOrderCents', () => {
    it('prices a retrieval leg', async () => {
        const q = await orderPricing.priceOrderCents({ orderType: 'retrieval' });
        expect(q.amountCents).toBe(500);
        expect(q.basis).toBe('retrieval');
    });

    it('takes the $1 deposit for an away booking with no schedule yet', async () => {
        const q = await orderPricing.priceOrderCents({
            awayMode: true,
            awayService: 'moves',
            awayDays: [],
            pickUpTime: new Date().toISOString(),
            awayEndTime: new Date(Date.now() + 7 * 86400000).toISOString(),
        });
        expect(q.amountCents).toBe(orderPricing.AWAY_DEPOSIT_CENTS);
        expect(q.basis).toBe('away_deposit');
    });

    it('prices an away hold per night', async () => {
        const start = new Date('2026-09-01T15:00:00-04:00');
        const end = new Date('2026-09-04T15:00:00-04:00');
        const q = await orderPricing.priceOrderCents({
            awayMode: true,
            awayService: 'hold',
            pickUpTime: start.toISOString(),
            awayEndTime: end.toISOString(),
        });
        expect(q.amountCents).toBe(3 * 1000);
    });

    it('survives PricingConfig being unreadable', async () => {
        const spy = jest
            .spyOn(PricingConfig, 'getSingleton')
            .mockRejectedValue(new Error('db down'));

        const q = await orderPricing.priceOrderCents({ aspMode: true });
        // Falls back to the schema defaults rather than failing checkout.
        expect(q.amountCents).toBe(1500);

        spy.mockRestore();
    });
});

describe('routes closed alongside the pricing fix', () => {
    const ADMIN_KEY = 'test-admin-key';
    const originalKey = process.env.ADMIN_API_KEY;

    beforeAll(() => {
        process.env.ADMIN_API_KEY = ADMIN_KEY;
    });
    afterAll(() => {
        if (originalKey === undefined) delete process.env.ADMIN_API_KEY;
        else process.env.ADMIN_API_KEY = originalKey;
    });

    const buildApp = (mount, router) => {
        const app = express();
        app.use(express.json());
        app.use(mount, router);
        return app;
    };

    it('rejects an unauthenticated price change', async () => {
        const app = buildApp('/api/pricing', require('../routes/pricing'));
        const res = await request(app).put('/api/pricing').send({ aspCents: 1 });

        expect(res.statusCode).toBe(401);
        // And nothing was written.
        expect(await PricingConfig.findOne({ key: 'default' })).toBeNull();
    });

    it('accepts a price change carrying the admin key', async () => {
        const app = buildApp('/api/pricing', require('../routes/pricing'));
        const res = await request(app)
            .put('/api/pricing')
            .set('x-admin-key', ADMIN_KEY)
            .send({ aspCents: 1700 });

        expect(res.statusCode).toBe(200);
        expect(res.body.pricing.aspCents).toBe(1700);
    });

    it('still serves the public price read', async () => {
        const app = buildApp('/api/pricing', require('../routes/pricing'));
        const res = await request(app).get('/api/pricing');

        expect(res.statusCode).toBe(200);
        expect(res.body.pricing.parkingCents).toBe(1000);
    });

    it('no longer exposes updatePaymentStatus', async () => {
        const app = buildApp('/api/payment', require('../routes/payment'));
        const res = await request(app)
            .post('/api/payment/updatePaymentStatus')
            .send({ orderId: 'x', paymentIntentId: 'pi_x', paymentStatus: 'paid' });

        expect(res.statusCode).toBe(404);
    });
});
