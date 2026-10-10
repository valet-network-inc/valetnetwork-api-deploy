/**
 * Neighborhood unlocks: the one place a waiting customer is charged
 * (spec v2, 9-10).
 *
 * Run: npx jest neighborhoodUnlocks
 *
 *   - 10 with a card saved unlock it; the 9th doesn't
 *   - plans start 3 days later at 8 AM New York
 *   - nothing is charged before then, and each member exactly once after,
 *     however many ticks run
 *   - someone joining after the unlock waits for the same start date
 *
 * Stripe is a stub that records every subscription it is asked to create.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
jest.mock('../services/operatorAlert', () => ({ raise: jest.fn(async () => ({})), SEVERITY: { WARN: 'warn' } }));
jest.mock('firebase-admin', () => ({
    messaging: () => ({ send: async () => 'x', sendEachForMulticast: async () => ({ responses: [] }) }),
    auth: () => ({ verifyIdToken: async () => ({ uid: 'x' }) }),
}));

const stripeClient = require('../services/stripeClient');
const User = require('../models/User');
const UnlockMember = require('../models/UnlockMember');
const NeighborhoodUnlock = require('../models/NeighborhoodUnlock');
const Subscription = require('../models/Subscription');
const unlocks = require('../services/neighborhoodUnlocks');
const operatorAlert = require('../services/operatorAlert');

const CHELSEA = 'manhattan-chelsea';
let created;
let mongo;

function stubStripe() {
    created = [];
    stripeClient.set({
        prices: {
            // The catalog's anchor price names the product new amounts are minted on.
            list: async ({ lookup_keys: keys }) =>
                keys && keys[0] === 'vn_home_garage_monthly'
                    ? { data: [{ id: 'price_anchor', active: true, product: 'prod_garage' }] }
                    : { data: [] },
            search: async () => ({ data: [] }),
            create: async (p) => ({ id: `price_${p.unit_amount}`, ...p }),
        },
        subscriptions: {
            create: async (params, opts) => {
                created.push({ params, opts });
                return {
                    id: `sub_${created.length}`,
                    status: 'active',
                    current_period_start: 1,
                    current_period_end: 2,
                    latest_invoice: { id: `in_${created.length}`, amount_paid: 52500, status: 'paid' },
                };
            },
        },
        paymentMethods: { retrieve: async () => ({ card: { brand: 'visa', last4: '4242' } }) },
        customers: { update: async () => ({}) },
    });
}

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
    stripeClient.reset();
    await mongoose.disconnect();
    await mongo.stop();
});
beforeEach(async () => {
    await mongoose.connection.db.dropDatabase();
    stubStripe();
    operatorAlert.raise.mockClear();
});

async function waitingMember(i, status = 'pending_card') {
    const user = await User.create({ verified: true, phone: `+1917555${String(1000 + i)}` });
    return UnlockMember.create({
        neighborhood: CHELSEA,
        borough: 'Manhattan',
        neighborhoodName: 'Chelsea',
        source: 'self',
        status,
        user: user._id,
        liveUser: user._id,
        plan: { tier: 'home_garage', interval: 'month', amountCents: 52500, commissionCents: 10000 },
        homeAddress: { streetAddress: `${200 + i} W 20th St`, lat: 40.7425, lng: -73.997 },
        stripeCustomerId: `cus_${i}`,
    });
}

test('ten cards unlock Chelsea; plans start three days later at 8 AM ET; one charge each', async () => {
    // Fri Oct 9 2026, 2 PM ET.
    const unlockAt = new Date('2026-10-09T18:00:00Z');
    for (let i = 0; i < 9; i++) await unlocks.markCardSaved(await waitingMember(i), `pm_${i}`, unlockAt);
    expect(await NeighborhoodUnlock.findOne({ key: CHELSEA, unlockedAt: { $exists: true } })).toBeNull();
    expect(await UnlockMember.countDocuments({ status: 'waiting' })).toBe(9);

    await unlocks.markCardSaved(await waitingMember(9), 'pm_9', unlockAt);
    const hood = await NeighborhoodUnlock.findOne({ key: CHELSEA });
    // Mon Oct 12, 8 AM EDT.
    expect(hood.startsAt.toISOString()).toBe('2026-10-12T12:00:00.000Z');
    expect(operatorAlert.raise).toHaveBeenCalledTimes(1);
    expect(await UnlockMember.countDocuments({ status: 'scheduled' })).toBe(10);
    expect(created).toHaveLength(0);

    // Someone saves a card after the unlock, before the start: same day.
    await unlocks.markCardSaved(await waitingMember(10), 'pm_10', new Date('2026-10-10T15:00:00Z'));
    const late = await UnlockMember.findOne({ 'homeAddress.streetAddress': '210 W 20th St' });
    expect(late.status).toBe('scheduled');
    expect(late.startsAt.toISOString()).toBe('2026-10-12T12:00:00.000Z');

    // A minute before 8 AM: nothing.
    await unlocks.tick({ now: new Date('2026-10-12T11:59:00Z') });
    expect(created).toHaveLength(0);

    // 8 AM, twice at once, then again: eleven charges, never more.
    const at8 = new Date('2026-10-12T12:00:30Z');
    await Promise.all([unlocks.tick({ now: at8 }), unlocks.tick({ now: at8 })]);
    await unlocks.tick({ now: new Date('2026-10-12T12:30:00Z') });
    expect(created).toHaveLength(11);
    expect(new Set(created.map((c) => c.opts.idempotencyKey)).size).toBe(11);
    expect(created.every((c) => c.params.off_session && c.params.payment_behavior === 'error_if_incomplete')).toBe(true);
    expect(await UnlockMember.countDocuments({ status: 'active' })).toBe(11);
    expect(await Subscription.countDocuments({ status: 'active' })).toBe(11);
});

test('a member without a saved card is never charged, and nothing re-locks', async () => {
    const unlockAt = new Date('2026-10-09T18:00:00Z');
    for (let i = 0; i < 10; i++) await unlocks.markCardSaved(await waitingMember(i), `pm_${i}`, unlockAt);
    const noCard = await waitingMember(20);
    await unlocks.tick({ now: new Date('2026-10-13T12:00:00Z') });
    expect(created).toHaveLength(10);
    expect((await UnlockMember.findById(noCard._id)).status).toBe('pending_card');
    await UnlockMember.updateMany({ status: 'active' }, { $set: { status: 'cancelled' } });
    expect((await unlocks.stateFor(CHELSEA)).unlocked).toBe(true);
});
