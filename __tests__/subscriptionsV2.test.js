/**
 * Subscriptions v2 — entitlements, auto-ASP scheduler, webhook lifecycle,
 * and the createOrder coverage decision.
 *
 * Run: npx jest subscriptionsV2
 *
 * Style matches cancelRetrieval.test.js: mongodb-memory-server, controllers
 * called directly with hand-rolled req/res/io doubles, no Stripe key in env
 * so every Stripe client in the codebase is null (the no-Stripe branches are
 * the ones under test — billing state transitions are driven through the
 * exported webhook appliers with fake events).
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
delete process.env.STRIPE_API_KEY;

const Order = require('../models/Order');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const PricingConfig = require('../models/PricingConfig');

const orderController = require('../controllers/orderController');
const subscriptionController = require('../controllers/subscriptionController');
const subscriptionService = require('../services/subscriptionService');
const scheduler = require('../services/subscriptionScheduler');
const nyTime = require('../services/nyTime');

let mongod;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    // The scheduler's idempotency rests on the unique sparse autoBookKey
    // index — make sure it exists before any race tests run.
    await Order.init();
    await Subscription.init();
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

afterEach(async () => {
    await Promise.all([
        Order.deleteMany({}),
        Subscription.deleteMany({}),
        User.deleteMany({}),
        PricingConfig.deleteMany({}),
    ]);
});

// ---------------------------------------------------------------------------
// Doubles + factories
// ---------------------------------------------------------------------------

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
    io.emit = (event, payload) => io.emits.push({ room: null, event, payload });
    io.to = (room) => ({
        emit: (event, payload) => io.emits.push({ room, event, payload }),
    });
    return io;
};

let phoneSeq = 5550000;
const makeCustomer = async (overrides = {}) =>
    User.create({
        phone: `+1917${phoneSeq++}`,
        verified: true,
        firstName: 'Sub',
        lastName: 'Tester',
        ...overrides,
    });

const HOME = { lat: 40.679, lng: -73.995, streetAddress: '123 Court St, Brooklyn' };
const AWAY = { lat: 40.72, lng: -73.957, streetAddress: '99 Elsewhere Ave, Brooklyn' };

const makeSub = async (user, overrides = {}) =>
    Subscription.create({
        user: user._id,
        tier: 'home_garage',
        interval: 'week',
        status: 'active',
        amountCents: 7500,
        stripeSubscriptionId: `sub_test_${phoneSeq++}`,
        currentPeriodEnd: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        aspSchedule: {
            address: HOME,
            days: [
                { weekday: 2, hour: 9, minute: 0 },
                { weekday: 5, hour: 9, minute: 0 },
            ],
            source: 'onboarding',
        },
        homeAddress: HOME,
        ...overrides,
    });

// createOrder needs the middleware's work done: req.subscription + req.user.
const createOrderVia = async (user, body, subscription = null) => {
    const req = {
        body: { customer: user._id.toString(), ...body },
        io: mockIo(),
        subscription,
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
    totalAmount: 1000,
    orderType: 'parking',
    serviceType: 'standard',
    ...overrides,
});

// A Tuesday 9:00 AM NY occurrence with `now` inside the firing window.
const TUE_9AM = { weekday: 2, hour: 9, minute: 0 };
const nextTue9 = nyTime.nextNyOccurrence(TUE_9AM, new Date(Date.now() + 24 * 60 * 60 * 1000));
const inWindowNow = new Date(nextTue9.getTime() - 20 * 60 * 1000); // 20 min before sweep

const runTick = (now, io = mockIo()) =>
    scheduler.tick({ io, now, notify: async () => {} });

// ---------------------------------------------------------------------------
// NY time helpers
// ---------------------------------------------------------------------------

describe('nyTime', () => {
    it('converts NY wall time to the right UTC instant in summer (EDT, UTC-4)', () => {
        const instant = nyTime.nyWallTimeToInstant(2026, 8, 14, 9, 0);
        expect(instant.toISOString()).toBe('2026-08-14T13:00:00.000Z');
    });

    it('converts NY wall time to the right UTC instant in winter (EST, UTC-5)', () => {
        const instant = nyTime.nyWallTimeToInstant(2026, 1, 15, 9, 0);
        expect(instant.toISOString()).toBe('2026-01-15T14:00:00.000Z');
    });

    it('nextNyOccurrence lands on the requested weekday at the requested time', () => {
        const from = new Date('2026-08-14T00:00:00Z'); // a Friday
        const occ = nyTime.nextNyOccurrence({ weekday: 2, hour: 9, minute: 30 }, from);
        expect(nyTime.nyClock(occ).weekday).toBe(2);
        expect(nyTime.nyClock(occ).hour).toBe(9);
        expect(nyTime.nyClock(occ).minute).toBe(30);
        expect(occ.getTime()).toBeGreaterThanOrEqual(from.getTime());
        expect(occ.getTime() - from.getTime()).toBeLessThan(8 * 24 * 60 * 60 * 1000);
    });

    it('nextNyOccurrence returns `from` itself when it matches exactly', () => {
        const exact = nyTime.nyWallTimeToInstant(2026, 8, 18, 9, 0); // Tue Aug 18 2026
        const occ = nyTime.nextNyOccurrence({ weekday: 2, hour: 9, minute: 0 }, exact);
        expect(occ.getTime()).toBe(exact.getTime());
    });
});

// ---------------------------------------------------------------------------
// Auto-ASP scheduler
// ---------------------------------------------------------------------------

describe('auto-ASP scheduler', () => {
    it('books a $0 covered order inside the firing window with the right shape', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user, { tier: 'street_cleaning', amountCents: 3000 });

        const results = await runTick(inWindowNow);
        const booked = results.filter((r) => r.outcome === 'booked');
        expect(booked).toHaveLength(1);

        const order = await Order.findOne({ coveredBySubscription: sub._id });
        expect(order).toBeTruthy();
        expect(order.totalAmount).toBe(0);
        expect(order.paymentStatus).toBe('paid');
        expect(order.status).toBe('pending');
        expect(order.aspMode).toBe(true);
        expect(order.orderType).toBe('parking');
        expect(order.serviceType).toBe('park-and-hold');
        expect(order.listPriceCents).toBe(1500); // PricingConfig default aspCents
        expect(order.autoBookKey).toMatch(/^asp:/);
        // pickup 15 min before the sweep, auto-return 1.5h after pickup
        expect(order.pickUpTime.getTime()).toBe(nextTue9.getTime() - 15 * 60 * 1000);
        expect(order.asp_time.getTime()).toBe(order.pickUpTime.getTime() + 90 * 60 * 1000);
        expect(order.paymentIntentId).toBeFalsy(); // nothing was ever charged
    });

    it('is idempotent: a second tick books nothing', async () => {
        const user = await makeCustomer();
        await makeSub(user);

        await runTick(inWindowNow);
        const again = await runTick(new Date(inWindowNow.getTime() + 60 * 1000));

        expect(await Order.countDocuments({})).toBe(1);
        expect(again.every((r) => r.outcome !== 'booked')).toBe(true);
    });

    it('survives a concurrent race: unique index allows exactly one order', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        const day = sub.aspSchedule.days[0];

        const results = await Promise.all(
            Array.from({ length: 5 }, () =>
                scheduler
                    .bookOccurrence(sub, day, nextTue9, {
                        io: null,
                        notify: async () => {},
                        now: inWindowNow,
                    })
                    .catch((e) => ({ outcome: 'threw', error: e.message }))
            )
        );

        expect(await Order.countDocuments({})).toBe(1);
        expect(results.filter((r) => r.outcome === 'booked')).toHaveLength(1);
        expect(results.filter((r) => r.outcome === 'threw')).toHaveLength(0);
    });

    it('never fires for past_due, cancelled, or incomplete subscriptions', async () => {
        for (const status of ['past_due', 'cancelled', 'incomplete']) {
            const user = await makeCustomer();
            await makeSub(user, { status });
        }
        const results = await runTick(inWindowNow);
        expect(results.filter((r) => r.outcome === 'booked')).toHaveLength(0);
        expect(await Order.countDocuments({})).toBe(0);
    });

    it('never fires for an active subscription whose paid period lapsed beyond grace', async () => {
        const user = await makeCustomer();
        await makeSub(user, {
            currentPeriodEnd: new Date(inWindowNow.getTime() - 2 * 24 * 60 * 60 * 1000),
        });
        const results = await runTick(inWindowNow);
        expect(results.filter((r) => r.outcome === 'booked')).toHaveLength(0);
    });

    it('does nothing outside the firing window', async () => {
        const user = await makeCustomer();
        await makeSub(user);
        const wayBefore = new Date(nextTue9.getTime() - 3 * 60 * 60 * 1000);
        const results = await runTick(wayBefore);
        expect(results).toHaveLength(0);
        expect(await Order.countDocuments({})).toBe(0);
    });

    it('skips while the customer has a live order, and retries next tick', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        const live = await Order.create({
            customer: user._id,
            customerLocation: HOME,
            paymentMethod: 'card',
            duration: 60,
            pickUpTime: new Date(),
            totalAmount: 1000,
            status: 'parked',
            paymentStatus: 'paid',
        });

        const first = await runTick(inWindowNow);
        expect(first.filter((r) => r.outcome === 'skipped_active_order')).toHaveLength(1);
        expect(await Order.countDocuments({ coveredBySubscription: sub._id })).toBe(0);

        // Car comes back → next tick books while the window is still open.
        live.status = 'completed';
        await live.save();
        const second = await runTick(new Date(inWindowNow.getTime() + 5 * 60 * 1000));
        expect(second.filter((r) => r.outcome === 'booked')).toHaveLength(1);
    });

    it('respects the 2-covered-moves-per-week cap', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        // Two covered ASP moves already this week (manual or auto — both count).
        for (let i = 0; i < 2; i++) {
            await Order.create({
                customer: user._id,
                customerLocation: HOME,
                paymentMethod: 'card',
                duration: 90,
                pickUpTime: new Date(inWindowNow.getTime() - (i + 1) * 60 * 60 * 1000),
                totalAmount: 0,
                status: 'completed',
                paymentStatus: 'paid',
                orderType: 'parking',
                aspMode: true,
                coveredBySubscription: sub._id,
                listPriceCents: 1500,
                createdAt: inWindowNow,
            });
        }
        const results = await runTick(inWindowNow);
        expect(results.filter((r) => r.outcome === 'weekly_cap_reached')).toHaveLength(1);
        expect(results.filter((r) => r.outcome === 'booked')).toHaveLength(0);
    });

    it('still books exactly one $0 order when valet dispatch fails', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        const results = await scheduler.tick({
            io: mockIo(),
            now: inWindowNow,
            notify: async () => {
                throw new Error('dispatch down');
            },
        });
        expect(results.filter((r) => r.outcome === 'booked')).toHaveLength(1);
        const order = await Order.findOne({ coveredBySubscription: sub._id });
        expect(order.totalAmount).toBe(0);
        expect(order.paymentStatus).toBe('paid');
    });
});

// ---------------------------------------------------------------------------
// createOrder coverage decision
// ---------------------------------------------------------------------------

describe('createOrder subscription coverage', () => {
    it('non-subscriber flow is unchanged: pending, client amount kept', async () => {
        const user = await makeCustomer();
        const res = await createOrderVia(user, parkBody());
        expect(res.statusCode).toBe(200);
        expect(res.body.order.paymentStatus).toBe('pending');
        expect(res.body.order.totalAmount).toBe(1000);
        expect(res.body.order.coveredBySubscription).toBeFalsy();
    });

    it('home_garage: first park of the day at home is free; second is charged', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);

        const first = await createOrderVia(user, parkBody(), sub);
        expect(first.statusCode).toBe(201);
        expect(first.body.coveredBySubscription).toBe(true);
        expect(first.body.order.totalAmount).toBe(0);
        expect(first.body.order.paymentStatus).toBe('paid');
        expect(first.body.order.listPriceCents).toBe(1000);

        // Complete it so the active-order guard doesn't block the second.
        await Order.findByIdAndUpdate(first.body.order._id, { status: 'completed' });

        const second = await createOrderVia(user, parkBody(), sub);
        expect(second.statusCode).toBe(200);
        expect(second.body.order.paymentStatus).toBe('pending');
        expect(second.body.order.totalAmount).toBe(1000);
        expect(second.body.order.coveredBySubscription).toBeFalsy();
    });

    it('home_garage: a park away from home is not covered', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        const res = await createOrderVia(user, parkBody({ customerLocation: AWAY }), sub);
        expect(res.statusCode).toBe(200);
        expect(res.body.order.paymentStatus).toBe('pending');
        expect(res.body.order.coveredBySubscription).toBeFalsy();
    });

    it('valet_anywhere: first park of the day is free anywhere', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user, { tier: 'valet_anywhere', amountCents: 9000 });
        const res = await createOrderVia(user, parkBody({ customerLocation: AWAY }), sub);
        expect(res.statusCode).toBe(201);
        expect(res.body.order.totalAmount).toBe(0);
        expect(res.body.order.coveredBySubscription).toBeTruthy();
    });

    it('street_cleaning: regular parks are never free, ASP moves are (up to 2/week)', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user, { tier: 'street_cleaning', amountCents: 3000 });

        const regular = await createOrderVia(user, parkBody(), sub);
        expect(regular.statusCode).toBe(200);
        expect(regular.body.order.paymentStatus).toBe('pending');

        await Order.deleteMany({}); // clear the active-order guard

        // Manual ASP bookings 1 and 2 → covered; 3rd → charged.
        for (let i = 0; i < 2; i++) {
            const asp = await createOrderVia(
                user,
                parkBody({ aspMode: true, serviceType: 'park-and-hold', totalAmount: 1500 }),
                sub
            );
            expect(asp.statusCode).toBe(201);
            expect(asp.body.order.totalAmount).toBe(0);
            await Order.findByIdAndUpdate(asp.body.order._id, { status: 'completed' });
        }
        const third = await createOrderVia(
            user,
            parkBody({ aspMode: true, serviceType: 'park-and-hold', totalAmount: 1500 }),
            sub
        );
        expect(third.statusCode).toBe(200);
        expect(third.body.order.paymentStatus).toBe('pending');
        expect(third.body.order.totalAmount).toBe(1500);
    });

    it('a covered order never stores a client-sent PaymentIntent id', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        const res = await createOrderVia(
            user,
            parkBody({ paymentIntentId: 'pi_attacker_supplied' }),
            sub
        );
        expect(res.statusCode).toBe(201);
        expect(res.body.order.totalAmount).toBe(0);
        expect(res.body.order.paymentIntentId).toBeFalsy();
    });

    it('an order with Car Watch is never covered — the add-on charges normally', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        const res = await createOrderVia(
            user,
            parkBody({ carWatch: true, carWatchAmount: 200, totalAmount: 1200 }),
            sub
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.order.paymentStatus).toBe('pending');
        expect(res.body.order.totalAmount).toBe(1200);
        expect(res.body.order.coveredBySubscription).toBeFalsy();
        // The free park is still available afterwards.
        expect((await subscriptionService.buildStatusPayload(sub)).freeParkAvailableToday).toBe(true);
    });

    it('covered listPriceCents is server-priced, not the client totalAmount', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        const res = await createOrderVia(user, parkBody({ totalAmount: 999999 }), sub);
        expect(res.statusCode).toBe(201);
        expect(res.body.order.totalAmount).toBe(0);
        expect(res.body.order.listPriceCents).toBe(1000); // PricingConfig parkingCents, standard park
    });

    it('an event code wins over subscription coverage (no double stamp)', async () => {
        const Event = require('../models/Event');
        await Event.create({
            code: 'SUBTESTFREE',
            name: 'test',
            type: 'temporary',
            isActive: true,
            serviceType: 'standard',
            validFrom: new Date(Date.now() - 1000),
            validUntil: new Date(Date.now() + 86400000),
        });
        const user = await makeCustomer();
        const sub = await makeSub(user);
        const res = await createOrderVia(user, parkBody({ eventCode: 'SUBTESTFREE' }), sub);
        expect([200, 201]).toContain(res.statusCode);
        expect(res.body.order.isFreeService).toBe(true);
        expect(res.body.order.coveredBySubscription).toBeFalsy();
    });

    it('getActiveSubscription ignores cancelled and lapsed subscriptions', async () => {
        const user = await makeCustomer();
        await makeSub(user, { status: 'cancelled' });
        expect(await subscriptionService.getActiveSubscription(user._id)).toBeNull();

        const user2 = await makeCustomer();
        await makeSub(user2, {
            currentPeriodEnd: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        });
        expect(await subscriptionService.getActiveSubscription(user2._id)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Webhook lifecycle appliers
// ---------------------------------------------------------------------------

describe('webhook appliers', () => {
    const invoiceFor = (sub, overrides = {}) => ({
        id: `in_${Math.random().toString(36).slice(2, 10)}`,
        subscription: sub.stripeSubscriptionId,
        amount_paid: sub.amountCents,
        ...overrides,
    });

    it('invoice.paid activates an incomplete subscription and links the user', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user, { status: 'incomplete' });

        const result = await subscriptionController.applyInvoicePaid(invoiceFor(sub));
        expect(result.handled).toBe(true);

        const fresh = await Subscription.findById(sub._id);
        expect(fresh.status).toBe('active');
        expect(fresh.payments).toHaveLength(1);
        expect(fresh.payments[0].amountCents).toBe(7500);

        const freshUser = await User.findById(user._id);
        expect(String(freshUser.activeSubscription)).toBe(String(sub._id));
    });

    it('replaying the same invoice does not duplicate the payment record', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user, { status: 'incomplete' });
        const invoice = invoiceFor(sub);

        await subscriptionController.applyInvoicePaid(invoice);
        await subscriptionController.applyInvoicePaid(invoice);

        const fresh = await Subscription.findById(sub._id);
        expect(fresh.payments).toHaveLength(1);
    });

    it('invoice.payment_failed on an active subscription pauses entitlements', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);

        await subscriptionController.applyInvoicePaymentFailed(invoiceFor(sub));

        const fresh = await Subscription.findById(sub._id);
        expect(fresh.status).toBe('past_due');
        expect(await subscriptionService.getActiveSubscription(user._id)).toBeNull();
    });

    it('customer.subscription.deleted cancels and unlinks the user', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        await User.findByIdAndUpdate(user._id, { activeSubscription: sub._id });

        await subscriptionController.applySubscriptionUpdated(
            { id: sub.stripeSubscriptionId, status: 'canceled' },
            true
        );

        const fresh = await Subscription.findById(sub._id);
        expect(fresh.status).toBe('cancelled');
        expect(fresh.cancelledAt).toBeTruthy();
        const freshUser = await User.findById(user._id);
        expect(freshUser.activeSubscription).toBeFalsy();
    });

    it('a late invoice.paid cannot resurrect a cancelled subscription', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user, { status: 'cancelled' });

        const result = await subscriptionController.applyInvoicePaid(invoiceFor(sub));
        expect(result.ignored).toBe('terminal');

        const fresh = await Subscription.findById(sub._id);
        expect(fresh.status).toBe('cancelled');
        const freshUser = await User.findById(user._id);
        expect(freshUser.activeSubscription).toBeFalsy();
    });

    it('the DB rejects a second live subscription for the same user', async () => {
        const user = await makeCustomer();
        await makeSub(user, { status: 'active' });
        await expect(makeSub(user, { status: 'active' })).rejects.toMatchObject({ code: 11000 });
        // A cancelled doc is fine alongside an active one.
        await makeSub(user, { status: 'cancelled' });
    });

    it('reads the subscription id from basil/clover-shaped invoice payloads', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user, { status: 'incomplete' });
        const result = await subscriptionController.applyInvoicePaid({
            id: 'in_newshape',
            amount_paid: 7500,
            parent: { subscription_details: { subscription: sub.stripeSubscriptionId } },
        });
        expect(result.handled).toBe(true);
        expect((await Subscription.findById(sub._id)).status).toBe('active');
    });

    it('a cancelled subscription is terminal — later updates cannot resurrect it', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user, { status: 'cancelled' });

        const result = await subscriptionController.applySubscriptionUpdated(
            { id: sub.stripeSubscriptionId, status: 'active' },
            false
        );
        expect(result.ignored).toBe('terminal');
        expect((await Subscription.findById(sub._id)).status).toBe('cancelled');
    });

    it('unknown subscription ids are reported unhandled, not crashed', async () => {
        const result = await subscriptionController.applyStripeSubscriptionEvent({
            type: 'invoice.paid',
            data: { object: { id: 'in_x', subscription: 'sub_does_not_exist' } },
        });
        expect(result.handled).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Auto-cancel: scheduled orders survive until their pickup passes
// ---------------------------------------------------------------------------

describe('autoCancelStaleOrders with future pickups', () => {
    const staleBase = (user, overrides = {}) => ({
        customer: user._id,
        customerLocation: HOME,
        paymentMethod: 'card',
        duration: 90,
        totalAmount: 0,
        status: 'pending',
        paymentStatus: 'paid',
        ...overrides,
    });

    it('does NOT cancel a pending order whose pickup time is still ahead', async () => {
        const user = await makeCustomer();
        const order = await Order.create(
            staleBase(user, { pickUpTime: new Date(Date.now() + 30 * 60 * 1000) })
        );
        // Backdate creation past the 30-minute threshold.
        await Order.collection.updateOne(
            { _id: order._id },
            { $set: { createdAt: new Date(Date.now() - 45 * 60 * 1000) } }
        );

        await orderController.autoCancelStaleOrders(mockIo());
        expect((await Order.findById(order._id)).status).toBe('pending');
    });

    it('cancels an UNPAID future-dated order — an abandoned checkout is stale whatever its pickup', async () => {
        const user = await makeCustomer();
        const order = await Order.create(
            staleBase(user, {
                pickUpTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
                paymentStatus: 'pending',
                totalAmount: 100,
            })
        );
        await Order.collection.updateOne(
            { _id: order._id },
            { $set: { createdAt: new Date(Date.now() - 45 * 60 * 1000) } }
        );

        await orderController.autoCancelStaleOrders(mockIo());
        expect((await Order.findById(order._id)).status).toBe('cancelled');
    });

    it('still cancels a pending order whose pickup passed 30+ minutes ago', async () => {
        const user = await makeCustomer();
        const order = await Order.create(
            staleBase(user, { pickUpTime: new Date(Date.now() - 45 * 60 * 1000) })
        );
        await Order.collection.updateOne(
            { _id: order._id },
            { $set: { createdAt: new Date(Date.now() - 45 * 60 * 1000) } }
        );

        await orderController.autoCancelStaleOrders(mockIo());
        expect((await Order.findById(order._id)).status).toBe('cancelled');
    });
});

// ---------------------------------------------------------------------------
// ASP sweep: return leg dedup under concurrency
// ---------------------------------------------------------------------------

describe('valet pay on covered orders', () => {
    it('pays the valet from listPriceCents when the customer paid $0', () => {
        expect(
            orderController.valetPayBaseCents({ totalAmount: 1500, coveredBySubscription: null })
        ).toBe(1500);
        expect(
            orderController.valetPayBaseCents({
                totalAmount: 0,
                coveredBySubscription: new mongoose.Types.ObjectId(),
                listPriceCents: 1500,
            })
        ).toBe(1500);
        // Event-code free orders stay unpaid — unchanged behavior.
        expect(
            orderController.valetPayBaseCents({ totalAmount: 0, isFreeService: true })
        ).toBe(0);
    });
});

describe('runAspSweep return-leg dedup', () => {
    it('does not adopt a cancelled return leg — mints a fresh one', async () => {
        const user = await makeCustomer();
        const valet = await makeCustomer({ isValet: true, isActive: true });
        const parent = await Order.create({
            customer: user._id,
            customerLocation: HOME,
            paymentMethod: 'card',
            duration: 90,
            pickUpTime: new Date(Date.now() - 2 * 60 * 60 * 1000),
            totalAmount: 0,
            status: 'parked',
            paymentStatus: 'paid',
            orderType: 'parking',
            serviceType: 'park-and-hold',
            aspMode: true,
            asp_time: new Date(Date.now() - 5 * 60 * 1000),
            valet: valet._id,
            aspNotificationSent: true,
        });
        // A dead child from an earlier attempt still holds the dedup key.
        await Order.create({
            customer: user._id,
            customerLocation: HOME,
            paymentMethod: 'card',
            duration: 30,
            pickUpTime: new Date(),
            totalAmount: 0,
            status: 'cancelled',
            paymentStatus: 'paid',
            orderType: 'retrieval',
            parkingType: 'retrieval',
            autoBookKey: `aspreturn:${parent._id}`,
        });

        await orderController.runAspSweep(mockIo());

        const liveChildren = await Order.find({
            linkedOrderId: parent._id,
            status: { $ne: 'cancelled' },
        });
        expect(liveChildren).toHaveLength(1);
        expect(liveChildren[0].status).toBe('accepted');
        expect(String((await Order.findById(parent._id)).linkedOrderId)).toBe(
            String(liveChildren[0]._id)
        );
    });

    it('creates exactly one return order even when sweeps race', async () => {
        const user = await makeCustomer();
        const valet = await makeCustomer({ isValet: true, isActive: true });
        const parent = await Order.create({
            customer: user._id,
            customerLocation: HOME,
            paymentMethod: 'card',
            duration: 90,
            pickUpTime: new Date(Date.now() - 2 * 60 * 60 * 1000),
            totalAmount: 0,
            status: 'parked',
            paymentStatus: 'paid',
            orderType: 'parking',
            serviceType: 'park-and-hold',
            aspMode: true,
            asp_time: new Date(Date.now() - 5 * 60 * 1000),
            valet: valet._id,
            aspNotificationSent: true,
        });

        await Promise.all([
            orderController.runAspSweep(mockIo()),
            orderController.runAspSweep(mockIo()),
            orderController.runAspSweep(mockIo()),
        ]);

        const children = await Order.find({ linkedOrderId: parent._id });
        expect(children).toHaveLength(1);
        expect(children[0].status).toBe('accepted');
        expect(children[0].totalAmount).toBe(0);
        expect(children[0].aspMode).toBe(true);
        expect(String(children[0].valet)).toBe(String(valet._id));

        const freshParent = await Order.findById(parent._id);
        expect(String(freshParent.linkedOrderId)).toBe(String(children[0]._id));
        expect(freshParent.parkClosedAt).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// Away mode + advance scheduling (2026-08-14 follow-up)
// ---------------------------------------------------------------------------

describe('away mode + advance scheduling', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    const awayBody = (overrides = {}) => ({
        customerLocation: HOME,
        duration: 7 * 24 * 60,
        pickUpTime: new Date(Date.now() + 2 * DAY_MS).toISOString(),
        awayEndTime: new Date(Date.now() + 9 * DAY_MS).toISOString(),
        totalAmount: 3000,
        orderType: 'parking',
        serviceType: 'park-and-hold',
        awayMode: true,
        awayDays: [{ weekday: 2, hour: 9, minute: 0 }],
        ...overrides,
    });

    it('creates an away order: asp_time = return date, aspMode forced on', async () => {
        const user = await makeCustomer();
        const res = await createOrderVia(user, awayBody());
        expect(res.statusCode).toBe(200);
        const o = res.body.order;
        expect(o.awayMode).toBe(true);
        expect(o.aspMode).toBe(true);
        expect(o.awayDays).toHaveLength(1);
        expect(new Date(o.asp_time).getTime()).toBe(new Date(o.pickUpTime).getTime() + 7 * DAY_MS);
        expect(o.paymentStatus).toBe('pending');
        // Server-priced, not the 3000 the fixture posts. The window is 7 days
        // and the schedule has one weekly slot, so it is ONE move at aspCents.
        // The old code billed the client's number here while setAwaySchedule
        // reconciled against countAwayMoves — booking $30, refunding $15.
        expect(o.totalAmount).toBe(1500);
    });

    it('rejects an away order whose return is before/too close to pickup, or beyond 30 days', async () => {
        const user = await makeCustomer();
        const tooShort = await createOrderVia(
            user,
            awayBody({ awayEndTime: new Date(Date.now() + 2 * DAY_MS + 60 * 60 * 1000).toISOString() })
        );
        expect(tooShort.statusCode).toBe(400);
        const tooLong = await createOrderVia(
            user,
            awayBody({ awayEndTime: new Date(Date.now() + 40 * DAY_MS).toISOString() })
        );
        expect(tooLong.statusCode).toBe(400);
    });

    it('away orders are never subscription-covered', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);
        const res = await createOrderVia(user, awayBody(), sub);
        expect(res.statusCode).toBe(200);
        expect(res.body.order.paymentStatus).toBe('pending');
        expect(res.body.order.coveredBySubscription).toBeFalsy();
    });

    it('a far-future scheduled order does not block a new booking; a near one does', async () => {
        const user = await makeCustomer();
        await Order.create({
            customer: user._id,
            customerLocation: HOME,
            paymentMethod: 'card',
            duration: 90,
            pickUpTime: new Date(Date.now() + 3 * DAY_MS),
            totalAmount: 0,
            status: 'pending',
            paymentStatus: 'paid',
            orderType: 'parking',
            aspMode: true,
        });
        const ok = await createOrderVia(user, parkBody());
        expect(ok.statusCode).toBe(200);

        // The new order (starting now) DOES block a follow-up.
        await Order.findByIdAndUpdate(ok.body.order._id, { paymentStatus: 'paid' });
        const blocked = await createOrderVia(user, parkBody());
        expect(blocked.statusCode).toBe(400);
    });

    it('an away moves booking with no schedule takes a $1 deposit, not the client amount', async () => {
        const user = await makeCustomer();
        const res = await createOrderVia(
            user,
            awayBody({ awayDays: [], awayService: 'moves', totalAmount: 4500 })
        );
        expect(res.statusCode).toBe(200);
        const o = res.body.order;
        expect(o.totalAmount).toBe(100); // client-sent amount discarded, $1 deposit
        expect(o.paymentStatus).toBe('pending'); // normal PaymentIntent flow charges it
        expect(o.awayBilling.status).toBe('pending_schedule');
        expect(o.awayPaidCents).toBe(100); // credited against the final price
    });

    it('a free-code away booking still skips the deposit entirely', async () => {
        const Event = require('../models/Event');
        await Event.create({
            code: 'AWAYFREE',
            name: 'test',
            type: 'temporary',
            isActive: true,
            serviceType: 'standard',
            validFrom: new Date(Date.now() - 1000),
            validUntil: new Date(Date.now() + 86400000),
        });
        const user = await makeCustomer();
        const res = await createOrderVia(
            user,
            awayBody({ awayDays: [], awayService: 'moves', eventCode: 'AWAYFREE' })
        );
        expect(res.body.order.totalAmount).toBe(0);
        expect(res.body.order.paymentStatus).toBe('paid');
    });

    it('the deposit is credited: 1 move ($15) bills the $14 balance, not $15 again', async () => {
        const user = await makeCustomer();
        const order = await Order.create({
            customer: user._id,
            customerLocation: HOME,
            paymentMethod: 'card',
            duration: 7 * 24 * 60,
            pickUpTime: new Date(Date.now() + DAY_MS),
            totalAmount: 100,
            awayPaidCents: 100, // the $1 deposit already charged
            status: 'accepted',
            paymentStatus: 'paid',
            orderType: 'parking',
            serviceType: 'park-and-hold',
            aspMode: true,
            awayMode: true,
            awayService: 'moves',
            awayDays: [],
            awayBilling: { status: 'pending_schedule', at: new Date() },
            asp_time: new Date(Date.now() + 8 * DAY_MS),
        });

        const res = mockRes();
        await orderController.setAwaySchedule(
            { body: { orderId: order._id.toString(), awayDays: [{ weekday: 2, hour: 9, minute: 0 }] }, io: mockIo() },
            res
        );
        // One Tuesday in the window = $15 owed, $1 already paid -> $14 balance.
        expect(res.body.billing.lastDeltaCents).toBe(1400);
    });

    it('countAwayMoves counts occurrences strictly inside the window', () => {
        const { nyWallTimeToInstant } = require('../services/nyTime');
        const start = nyWallTimeToInstant(2026, 8, 15, 9, 0); // Sat Aug 15
        const end = nyWallTimeToInstant(2026, 8, 24, 9, 0); // Mon Aug 24
        expect(orderController.countAwayMoves(start, end, [{ weekday: 2, hour: 9, minute: 0 }])).toBe(1); // Tue Aug 18
        expect(
            orderController.countAwayMoves(start, end, [
                { weekday: 2, hour: 9, minute: 0 },
                { weekday: 5, hour: 9, minute: 0 },
            ])
        ).toBe(2); // + Fri Aug 21
        expect(orderController.countAwayMoves(start, end, [])).toBe(0);
    });

    it('reconciler: schedule cheaper than what was charged refunds down (no-PI path adjusts totals)', async () => {
        const user = await makeCustomer();
        const order = await Order.create({
            customer: user._id,
            customerLocation: HOME,
            paymentMethod: 'card',
            duration: 7 * 24 * 60,
            pickUpTime: new Date(Date.now() + DAY_MS),
            totalAmount: 3000,
            awayPaidCents: 3000,
            status: 'accepted',
            paymentStatus: 'paid',
            orderType: 'parking',
            serviceType: 'park-and-hold',
            aspMode: true,
            awayMode: true,
            awayService: 'moves',
            awayDays: [],
            asp_time: new Date(Date.now() + 8 * DAY_MS),
        });

        const res = mockRes();
        await orderController.setAwaySchedule(
            { body: { orderId: order._id.toString(), awayDays: [{ weekday: 2, hour: 9, minute: 0 }] }, io: mockIo() },
            res
        );
        expect(res.statusCode).toBe(200);
        const fresh = await Order.findById(order._id);
        // one Tuesday in the window → $15; $30 was charged → settled down
        expect(fresh.totalAmount).toBe(1500);
        expect(fresh.awayPaidCents).toBe(1500);
        expect(fresh.awayBilling.status).toBe('settled');
        expect(fresh.awayBilling.lastDeltaCents).toBe(-1500);
    });

    it('reconciler: schedule dearer than what was charged records charge_failed when no card rail exists', async () => {
        const user = await makeCustomer();
        const order = await Order.create({
            customer: user._id,
            customerLocation: HOME,
            paymentMethod: 'card',
            duration: 7 * 24 * 60,
            pickUpTime: new Date(Date.now() + DAY_MS),
            totalAmount: 0,
            awayPaidCents: 0,
            status: 'accepted',
            paymentStatus: 'paid',
            orderType: 'parking',
            serviceType: 'park-and-hold',
            aspMode: true,
            awayMode: true,
            awayService: 'moves',
            awayDays: [],
            awayBilling: { status: 'pending_schedule', at: new Date() },
            asp_time: new Date(Date.now() + 8 * DAY_MS),
        });

        const res = mockRes();
        await orderController.setAwaySchedule(
            { body: { orderId: order._id.toString(), awayDays: [{ weekday: 2, hour: 9, minute: 0 }] }, io: mockIo() },
            res
        );
        expect(res.statusCode).toBe(200);
        const fresh = await Order.findById(order._id);
        expect(fresh.awayDays).toHaveLength(1); // schedule saved regardless
        expect(fresh.awayBilling.status).toBe('charge_failed'); // stripe absent in tests
        expect(fresh.totalAmount).toBe(0); // nothing charged
    });

    it('setAwaySchedule rejects flat-hold away orders', async () => {
        const user = await makeCustomer();
        const order = await Order.create({
            customer: user._id,
            customerLocation: HOME,
            paymentMethod: 'card',
            duration: 7 * 24 * 60,
            pickUpTime: new Date(Date.now() + DAY_MS),
            totalAmount: 7000,
            status: 'pending',
            paymentStatus: 'paid',
            orderType: 'parking',
            serviceType: 'park-and-hold',
            aspMode: true,
            awayMode: true,
            awayService: 'hold',
            asp_time: new Date(Date.now() + 8 * DAY_MS),
        });
        const res = mockRes();
        await orderController.setAwaySchedule(
            { body: { orderId: order._id.toString(), awayDays: [{ weekday: 2, hour: 9, minute: 0 }] }, io: mockIo() },
            res
        );
        expect(res.statusCode).toBe(400);
    });

    it('setAwaySchedule lets the valet fill in the days later and resets the reminder dedup', async () => {
        const user = await makeCustomer();
        const order = await Order.create({
            customer: user._id,
            customerLocation: HOME,
            paymentMethod: 'card',
            duration: 7 * 24 * 60,
            pickUpTime: new Date(Date.now() + DAY_MS),
            totalAmount: 3000,
            status: 'pending',
            paymentStatus: 'paid',
            orderType: 'parking',
            serviceType: 'park-and-hold',
            aspMode: true,
            awayMode: true,
            awayDays: [],
            awayReminderLastKey: 'stale',
            asp_time: new Date(Date.now() + 8 * DAY_MS),
        });

        const res = mockRes();
        await orderController.setAwaySchedule(
            { body: { orderId: order._id.toString(), awayDays: [{ weekday: 2, hour: 9, minute: 0 }] }, io: mockIo() },
            res
        );
        expect(res.statusCode).toBe(200);
        const fresh = await Order.findById(order._id);
        expect(fresh.awayDays).toHaveLength(1);
        expect(fresh.awayReminderLastKey).toBeFalsy();

        // Guards: non-away and bad days are rejected.
        const plain = await Order.create({
            customer: user._id, customerLocation: HOME, paymentMethod: 'card',
            duration: 60, pickUpTime: new Date(), totalAmount: 1000,
            status: 'pending', paymentStatus: 'paid',
        });
        const bad = mockRes();
        await orderController.setAwaySchedule(
            { body: { orderId: plain._id.toString(), awayDays: [] }, io: mockIo() }, bad
        );
        expect(bad.statusCode).toBe(400);
    });

    it('sweep sends one deduped move reminder per occurrence for parked away orders, and no return leg before the end', async () => {
        const user = await makeCustomer();
        const valet = await makeCustomer({ isValet: true, isActive: true });
        const now = new Date();
        const { nyClock } = require('../services/nyTime');
        const c = nyClock(new Date(now.getTime() + 5 * 60 * 1000)); // occurrence ~5 min out
        await Order.create({
            customer: user._id,
            customerLocation: HOME,
            paymentMethod: 'card',
            duration: 7 * 24 * 60,
            pickUpTime: new Date(now.getTime() - 2 * DAY_MS),
            totalAmount: 3000,
            status: 'parked',
            paymentStatus: 'paid',
            orderType: 'parking',
            serviceType: 'park-and-hold',
            aspMode: true,
            awayMode: true,
            awayDays: [{ weekday: c.weekday, hour: c.hour, minute: c.minute }],
            asp_time: new Date(now.getTime() + 5 * DAY_MS),
            valet: valet._id,
            aspNotificationSent: true,
        });

        const first = await orderController.runAspSweep(mockIo(), now);
        expect(first.notificationsSent.filter((n) => String(n.message).includes('Away move'))).toHaveLength(1);

        const second = await orderController.runAspSweep(mockIo(), new Date(now.getTime() + 60 * 1000));
        expect(second.notificationsSent.filter((n) => String(n.message).includes('Away move'))).toHaveLength(0);

        // No return leg minted — the away window is still open.
        expect(await Order.countDocuments({ orderType: 'retrieval' })).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Status payload
// ---------------------------------------------------------------------------

describe('status payload', () => {
    it('value indicator sums covered usage against payments', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user, {
            payments: [{ invoiceId: 'in_1', amountCents: 7500, paidAt: new Date() }],
        });
        await Order.create({
            customer: user._id,
            customerLocation: HOME,
            paymentMethod: 'card',
            duration: 90,
            pickUpTime: new Date(),
            totalAmount: 0,
            status: 'completed',
            paymentStatus: 'paid',
            orderType: 'parking',
            aspMode: true,
            coveredBySubscription: sub._id,
            listPriceCents: 1500,
        });
        await Order.create({
            customer: user._id,
            customerLocation: HOME,
            paymentMethod: 'card',
            duration: 120,
            pickUpTime: new Date(),
            totalAmount: 0,
            status: 'completed',
            paymentStatus: 'paid',
            orderType: 'parking',
            coveredBySubscription: sub._id,
            listPriceCents: 1300,
        });

        const payload = await subscriptionService.buildStatusPayload(sub);
        expect(payload.valueIndicator.usageCents).toBe(2800);
        expect(payload.valueIndicator.paidCents).toBe(7500);
        expect(payload.valueIndicator.usageCount).toBe(2);
        expect(payload.tierName).toBe('Fixed garage');
        expect(payload.nextAspMove).toBeTruthy();
        expect(payload.aspMovesPerWeek).toBe(2);
    });

    it('freeParkAvailableToday flips off after the covered park', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user);

        let payload = await subscriptionService.buildStatusPayload(sub);
        expect(payload.freeParkAvailableToday).toBe(true);

        await Order.create({
            customer: user._id,
            customerLocation: HOME,
            paymentMethod: 'card',
            duration: 60,
            pickUpTime: new Date(),
            totalAmount: 0,
            status: 'parked',
            paymentStatus: 'paid',
            orderType: 'parking',
            coveredBySubscription: sub._id,
            listPriceCents: 1000,
        });

        payload = await subscriptionService.buildStatusPayload(sub);
        expect(payload.freeParkAvailableToday).toBe(false);
    });

    it('a 1-move/week plan caps covered ASP moves at 1', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user, {
            tier: 'street_cleaning',
            amountCents: 1500,
            movesPerWeek: 1,
        });
        const first = await createOrderVia(
            user,
            parkBody({ aspMode: true, serviceType: 'park-and-hold', totalAmount: 1500 }),
            sub
        );
        expect(first.body.order.totalAmount).toBe(0);
        await Order.findByIdAndUpdate(first.body.order._id, { status: 'completed' });
        const second = await createOrderVia(
            user,
            parkBody({ aspMode: true, serviceType: 'park-and-hold', totalAmount: 1500 }),
            sub
        );
        expect(second.body.order.paymentStatus).toBe('pending'); // over the 1/week cap
    });

    it('cancel is immediate and reports usage-based refund math (no Stripe in tests)', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user, {
            tier: 'valet_anywhere',
            amountCents: 30000,
            currentPeriodStart: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        });
        await User.findByIdAndUpdate(user._id, { activeSubscription: sub._id });
        // 5 covered daily park-and-retrievals at $13 list = $65 used.
        for (let i = 0; i < 5; i++) {
            await Order.create({
                customer: user._id,
                customerLocation: HOME,
                paymentMethod: 'card',
                duration: 120,
                pickUpTime: new Date(Date.now() - i * 24 * 60 * 60 * 1000),
                totalAmount: 0,
                status: 'completed',
                paymentStatus: 'paid',
                orderType: 'parking',
                serviceType: 'park-and-hold',
                coveredBySubscription: sub._id,
                listPriceCents: 1300,
            });
        }

        const res = mockRes();
        await subscriptionController.cancelSubscription(
            { body: { userId: user._id.toString() } },
            res
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.usedCents).toBe(6500); // $65 kept
        expect(res.body.refund.requestedCents).toBe(23500); // $235 back

        const fresh = await Subscription.findById(sub._id);
        expect(fresh.status).toBe('cancelled');
        expect((await User.findById(user._id)).activeSubscription).toBeFalsy();
    });

    it('the fixed spot can only change once every 30 days', async () => {
        const user = await makeCustomer();
        await makeSub(user, {
            homeAddress: { streetAddress: 'A St', lat: 40.6, lng: -73.9 },
            homeAddressChangedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        });
        const res = mockRes();
        await subscriptionController.updateSchedule(
            {
                body: {
                    userId: user._id.toString(),
                    homeAddress: { streetAddress: 'B St', lat: 40.7, lng: -73.8 },
                },
            },
            res
        );
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/once a month/);
    });

    it('street_cleaning tier never advertises a free park', async () => {
        const user = await makeCustomer();
        const sub = await makeSub(user, { tier: 'street_cleaning', amountCents: 3000 });
        const payload = await subscriptionService.buildStatusPayload(sub);
        expect(payload.freeParkAvailableToday).toBe(false);
    });
});
