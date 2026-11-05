/**
 * The app's "Pay with" row (Nov 5 2026), and two guesses that must only learn
 * from moves that went ahead.
 * Run: npx jest payWith
 *
 * Rishi: "a small box ... where people can choose / change their payment
 * preference ... default it to whatever payment option they've already saved".
 *
 *  1. GET /methods lists the cards on the user's Stripe customer: one row per
 *     card, the default first, an Apple Pay card marked as such, and any
 *     gift credit (a negative Stripe balance) as balanceCents.
 *  2. Choosing a card makes it the default, and only the user's own card.
 *  3. A cancelled or never-paid street-cleaning move is not "your last
 *     street-cleaning move": neither the home screen's suggestion nor the
 *     plan's prefill reads it.
 */
jest.setTimeout(30000);

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../models/Order');
const User = require('../models/User');
const stripeClient = require('../services/stripeClient');
const paymentMethods = require('../services/paymentMethods');
const { suggestFromOrders } = require('../services/cleaningSchedule');
const { getPrefill } = require('../controllers/subscriptionController');

let mongo;
let seq = 9175552000;

const WYCKOFF = { lat: 40.6857, lng: -73.9905, streetAddress: '88 Wyckoff St, Brooklyn, NY 11201, USA' };

const makeUser = (extra = {}) =>
    User.create({
        firstName: 'Rishi',
        lastName: 'Test',
        email: `u${new mongoose.Types.ObjectId()}@example.com`,
        phone: String(++seq),
        firebaseUid: `uid_${seq}`,
        verified: true,
        ...extra,
    });

const card = (id, { fingerprint = id, wallet = null, created = 1, customer = 'cus_me', brand = 'visa', last4 = '4242' } = {}) => ({
    id,
    customer,
    created,
    card: { brand, last4, exp_month: 12, exp_year: 2030, fingerprint, wallet: wallet ? { type: wallet } : null },
});

// A Stripe with one customer and the cards given; records default changes.
function fakeStripe({ cards = [], defaultId = null, balance = 0 } = {}) {
    const state = { defaultId, updates: [] };
    return {
        state,
        customers: {
            retrieve: async (id) => ({ id, balance, invoice_settings: { default_payment_method: state.defaultId } }),
            update: async (id, p) => {
                state.updates.push({ id, p });
                state.defaultId = p.invoice_settings.default_payment_method;
                return { id };
            },
        },
        paymentMethods: {
            list: async ({ customer }) => ({ data: cards.filter((c) => c.customer === customer) }),
            retrieve: async (id) => cards.find((c) => c.id === id) || null,
        },
    };
}

const res = () => {
    const r = { statusCode: 200, body: null };
    r.status = (c) => {
        r.statusCode = c;
        return r;
    };
    r.json = (b) => {
        r.body = b;
        return r;
    };
    return r;
};

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
    stripeClient.reset();
    await mongoose.disconnect();
    await mongo.stop();
});

afterEach(() => stripeClient.reset());

describe('GET /methods: the cards on the account', () => {
    test('one row per card, the default first, Apple Pay marked, credit as balance', async () => {
        const user = await makeUser({ stripeCustomerId: 'cus_me' });
        stripeClient.set(
            fakeStripe({
                defaultId: 'pm_mc',
                balance: -2500,
                cards: [
                    card('pm_visa_old', { fingerprint: 'fp_visa', created: 1 }),
                    card('pm_visa_new', { fingerprint: 'fp_visa', created: 5 }),
                    card('pm_mc', { fingerprint: 'fp_mc', brand: 'mastercard', last4: '4444', created: 2 }),
                    card('pm_ap', { fingerprint: 'fp_visa', wallet: 'apple_pay', created: 3 }),
                    card('pm_theirs', { customer: 'cus_other' }),
                ],
            })
        );
        const out = await paymentMethods.list(user._id);
        expect(out.methods.map((m) => m.id)).toEqual(['pm_mc', 'pm_visa_new', 'pm_ap']);
        expect(out.methods[0]).toMatchObject({ brand: 'mastercard', last4: '4444', isDefault: true, wallet: null });
        expect(out.methods[2].wallet).toBe('apple_pay');
        expect(out.defaultId).toBe('pm_mc');
        expect(out.balanceCents).toBe(2500);
    });

    test('nothing to list without a Stripe customer, or without Stripe', async () => {
        const user = await makeUser();
        stripeClient.set(fakeStripe({ cards: [card('pm_x')] }));
        expect(await paymentMethods.list(user._id)).toEqual({ methods: [], defaultId: null, balanceCents: 0 });
        stripeClient.set(null);
        expect(await paymentMethods.list(user._id)).toEqual({ methods: [], defaultId: null, balanceCents: 0 });
    });
});

describe('POST /methods/default: the card picked on the row', () => {
    test('makes the user\'s own card the default', async () => {
        const user = await makeUser({ stripeCustomerId: 'cus_me' });
        const stripe = fakeStripe({ cards: [card('pm_mine')] });
        stripeClient.set(stripe);
        expect(await paymentMethods.setDefault(user._id, 'pm_mine')).toEqual({ defaultId: 'pm_mine' });
        expect(stripe.state.updates).toEqual([{ id: 'cus_me', p: { invoice_settings: { default_payment_method: 'pm_mine' } } }]);
    });

    test('refuses a card on someone else\'s account', async () => {
        const user = await makeUser({ stripeCustomerId: 'cus_me' });
        const stripe = fakeStripe({ cards: [card('pm_theirs', { customer: 'cus_other' })] });
        stripeClient.set(stripe);
        const out = await paymentMethods.setDefault(user._id, 'pm_theirs');
        expect(out.status).toBe(404);
        expect(stripe.state.updates).toEqual([]);
    });
});

describe('"From your last street-cleaning move" reads only moves that went ahead', () => {
    const move = (user, extra) =>
        Order.create({
            customer: user._id,
            customerLocation: WYCKOFF,
            carLocation: WYCKOFF,
            aspMode: true,
            orderType: 'parking',
            duration: 120,
            totalAmount: 1500,
            paymentMethod: 'card',
            status: 'completed',
            paymentStatus: 'paid',
            // Thursday 10 AM in New York.
            pickUpTime: new Date('2026-11-05T15:00:00Z'),
            ...extra,
        });

    test('a cancelled move and an unpaid one teach nothing', async () => {
        const user = await makeUser();
        await move(user, { status: 'cancelled' });
        await move(user, { status: 'pending', paymentStatus: 'pending' });
        expect(await suggestFromOrders(user._id)).toBeNull();
        const r = res();
        await getPrefill({ params: { userId: String(user._id) } }, r);
        expect(r.body).toEqual({ success: true, prefill: null });
    });

    test('a paid move still does', async () => {
        const user = await makeUser();
        await move(user, { status: 'cancelled', pickUpTime: new Date('2026-11-03T15:00:00Z') });
        await move(user, {});
        const s = await suggestFromOrders(user._id);
        expect(s && s.days.map((d) => d.weekday)).toEqual([4]);
        const r = res();
        await getPrefill({ params: { userId: String(user._id) } }, r);
        expect(r.body.success).toBe(true);
        expect(r.body.prefill).toBeTruthy();
    });
});
