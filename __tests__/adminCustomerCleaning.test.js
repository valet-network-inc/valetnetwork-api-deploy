/**
 * The cleaning day on the Customers tab — GET /api/admin/customers.
 *
 * Run: npx jest adminCustomerCleaning
 *
 * The schedule is free and belongs to the person, so it exists for customers
 * who have never bought a plan. The Customers tab is the only place those
 * people are listed, which is why the column has to live there too and not
 * only on Subscribers.
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const User = require('../models/User');
const Order = require('../models/Order');
const FCMToken = require('../models/FCMToken');
const AspSuspension = require('../models/AspSuspension');
const adminController = require('../controllers/adminController');

let mongod;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

afterEach(async () => {
    await Promise.all([
        User.deleteMany({}),
        Order.deleteMany({}),
        FCMToken.deleteMany({}),
        AspSuspension.deleteMany({}),
    ]);
});

const mockRes = () => {
    const res = { statusCode: 0, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
};

let seq = 7100000;
const makeCustomer = (overrides = {}) =>
    User.create({
        phone: `+1917${seq++}`,
        verified: true,
        firstName: 'Clean',
        lastName: 'Sweep',
        ...overrides,
    });

const load = async () => {
    const res = mockRes();
    await adminController.getCustomerList({ query: {} }, res);
    expect(res.statusCode).toBe(200);
    return res.body;
};

describe('customer list — cleaning day', () => {
    it('carries the schedule of a customer who has one but no plan', async () => {
        await makeCustomer({
            cleaningSchedule: {
                days: [{ weekday: 2, hour: 11, minute: 30 }],
                status: 'active',
                address: { streetAddress: '264 President St, Brooklyn, NY 11231' },
            },
        });

        const body = await load();
        const [row] = body.data;
        expect(row.cleaning.hasSchedule).toBe(true);
        expect(row.cleaning.shortLabel).toBe('Tue 11:30 AM');
        expect(row.cleaning.active).toBe(true);
        expect(row.cleaning.next.dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(body.todayKey).toBe(require('../services/nyTime').nyDateKey(new Date()));
    });

    it('leaves a customer without one plainly empty rather than absent', async () => {
        await makeCustomer();
        const [row] = (await load()).data;
        expect(row.cleaning).toEqual(expect.objectContaining({ hasSchedule: false }));
    });

    it('costs one suspension query however many customers there are', async () => {
        const spy = jest.spyOn(AspSuspension, 'find');
        await Promise.all([
            makeCustomer({ cleaningSchedule: { days: [{ weekday: 1, hour: 8, minute: 0 }] } }),
            makeCustomer({ cleaningSchedule: { days: [{ weekday: 3, hour: 9, minute: 30 }] } }),
            makeCustomer(),
        ]);

        const rows = (await load()).data;
        expect(rows).toHaveLength(3);
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });
});
