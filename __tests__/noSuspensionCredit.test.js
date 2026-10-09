/**
 * No credit for a day the city suspends street cleaning.
 *
 * Rishi, 2026-10-09: "there aren't any refunds for if the city suspends a
 * street cleaning day. no credit back either" — on every plan, for
 * subscribers who signed up under the old promise too. The scheduler still
 * skips the move on a suspended day; it just no longer posts a Stripe
 * balance credit for it.
 *
 * Run: npx jest noSuspensionCredit
 */

const fs = require('fs');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
delete process.env.STRIPE_API_KEY;

const AspCredit = require('../models/AspCredit');
const { creditSuspendedDay } = require('../services/subscriptionCredits');

let mongod;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

test('creditSuspendedDay posts nothing and writes no ledger row', async () => {
    const sub = {
        _id: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        amountCents: 5000,
        stripeCustomerId: 'cus_test',
        currentPeriodStart: new Date('2026-10-01T04:00:00Z'),
        currentPeriodEnd: new Date('2026-11-01T04:00:00Z'),
        aspSchedule: { days: [{ weekday: 1, hour: 9, minute: 0 }] },
    };
    const result = await creditSuspendedDay(sub, new Date('2026-10-12T13:00:00Z'), {
        reason: 'Columbus Day',
    });
    expect(result).toEqual({ credited: false, reason: 'discontinued' });
    expect(await AspCredit.countDocuments()).toBe(0);
});

test('the scheduler no longer calls the credit at all', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/subscriptionScheduler.js'), 'utf8');
    expect(src).not.toMatch(/creditSuspendedDay/);
    // The suspended-day skip itself is still there.
    expect(src).toMatch(/outcome: 'suspended'/);
});

test('no plan, and nothing /plans returns, promises a credit for a suspended day', () => {
    const { PLANS } = require('../services/subscriptionPlans');
    const catalog = require('../services/subscriptionPlans');
    for (const plan of Object.values(PLANS)) {
        for (const line of [plan.blurb, ...plan.features]) {
            expect(line).not.toMatch(/credited back|credit back|refund/i);
        }
    }
    expect(catalog.SUSPENSION_GUARANTEE).toBeUndefined();
    const controller = fs.readFileSync(path.join(__dirname, '../controllers/subscriptionController.js'), 'utf8');
    expect(controller).not.toMatch(/suspensionGuarantee|SUSPENSION_GUARANTEE/);
});
