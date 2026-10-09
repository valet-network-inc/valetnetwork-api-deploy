/**
 * The admin-key mirrors for prices and codes (spec v2, 19).
 *
 * Run: npx jest adminSales
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
delete process.env.STRIPE_API_KEY;

const PromoCode = require('../models/PromoCode');
const NeighborhoodPricing = require('../models/NeighborhoodPricing');
const pricing = require('../services/neighborhoodPricing');
const adminSales = require('../controllers/adminSalesController');

let mongod;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await PromoCode.init();
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

afterEach(async () => {
    pricing.invalidate();
    await Promise.all([PromoCode.deleteMany({}), NeighborhoodPricing.deleteMany({})]);
});

const call = async (handler, req = {}) => {
    const res = { statusCode: 200, body: null };
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (payload) => {
        res.body = payload;
        return res;
    };
    await handler({ body: {}, params: {}, get: () => undefined, ...req }, res);
    return res;
};

describe('prices', () => {
    it('reads the live table and every neighborhood', async () => {
        const res = await call(adminSales.getPricing);
        expect(res.body.table.manhattan).toHaveLength(18);
        expect(res.body.neighborhoods).toHaveLength(113);
    });

    it('edits a Manhattan price and the Contact sales message, and refuses a bad phone', async () => {
        const { table } = (await call(adminSales.getPricing)).body;
        const manhattan = table.manhattan.map((r) =>
            r.neighborhood === 'Chelsea' ? { ...r, monthlyCents: 55000 } : r
        );
        const ok = await call(adminSales.putPricing, {
            body: { manhattan, contactSales: { message: 'Hi Rishi, this is {name}.' } },
        });
        expect(ok.statusCode).toBe(200);
        expect(ok.body.table.manhattan.find((r) => r.neighborhood === 'Chelsea').monthlyCents).toBe(55000);
        expect(ok.body.table.contactSales.message).toBe('Hi Rishi, this is {name}.');
        expect(ok.body.table.contactSales.phone).toBe('+19796616772');

        const bad = await call(adminSales.putPricing, { body: { contactSales: { phone: '979 661 6772' } } });
        expect(bad.statusCode).toBe(400);
    });
});

describe('codes', () => {
    it('creates a percent code that customers can then type', async () => {
        const res = await call(adminSales.postCode, {
            body: { code: 'save 20', kind: 'percent_off', percentOff: 20 },
        });
        expect(res.statusCode).toBe(201);
        expect(res.body.code.code).toBe('SAVE20');
        const { findPromo } = require('../services/subscriptionPromos');
        expect((await findPromo('SAVE20')).percentOff).toBe(20);
    });

    it('refuses 100% off, a built-in name, and a duplicate', async () => {
        expect((await call(adminSales.postCode, { body: { code: 'ALL', kind: 'percent_off', percentOff: 100 } })).statusCode).toBe(400);
        expect((await call(adminSales.postCode, { body: { code: 'LOLGARAGE', kind: 'percent_off', percentOff: 10 } })).statusCode).toBe(400);
        await call(adminSales.postCode, { body: { code: 'TWICE', kind: 'amount_off', amountOffCents: 2500 } });
        expect((await call(adminSales.postCode, { body: { code: 'TWICE', kind: 'amount_off', amountOffCents: 2500 } })).statusCode).toBe(400);
    });

    it('switches a code off, and lists it with the built-in ones', async () => {
        await call(adminSales.postCode, { body: { code: 'OFFSOON', kind: 'free_trial', trialDays: 14 } });
        const off = await call(adminSales.patchCode, { params: { code: 'offsoon' }, body: { active: false } });
        expect(off.body.code.active).toBe(false);
        const { findPromo } = require('../services/subscriptionPromos');
        expect(await findPromo('OFFSOON')).toBeNull();

        const list = await call(adminSales.getCodes);
        expect(list.body.codes.map((c) => c.code)).toEqual(['OFFSOON']);
        expect(list.body.builtIn.map((c) => c.code)).toContain('LOLGARAGE');
    });
});
