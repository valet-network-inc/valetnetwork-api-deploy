/**
 * An away "moves" trip whose sweep day falls OUTSIDE the trip.
 *
 * Leave Friday, come back Sunday, street cleaning is Tuesday 11:00: zero
 * sweeps land in the window. The server counted that honestly, got 0, and
 * dropped into the no-schedule deposit branch — $1 for parking, holding and
 * returning a car across a whole trip, with nothing to true it up, because
 * createOrder only stamps awayBilling 'pending_schedule' when the customer
 * gave NO days at all. The valet's cut of that is 70 cents.
 *
 * The customer never saw a dollar: the shipped iOS screen floors the billed
 * moves at one (Math.max(1, awayMovesCount)), so the pay button reads $15.00.
 * No app release is possible, so the server has to charge the number on that
 * button.
 *
 * Run: npx jest awayScheduleWithNoSweepUndercharged
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
delete process.env.STRIPE_API_KEY;

const Order = require('../models/Order');
const User = require('../models/User');
const PricingConfig = require('../models/PricingConfig');
const orderController = require('../controllers/orderController');
const orderPricing = require('../services/orderPricing');
const { nyWallTimeToInstant } = require('../services/nyTime');

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

let phoneSeq = 8600000;
const makeCustomer = async () =>
    User.create({
        phone: `+1917${phoneSeq++}`,
        verified: true,
        firstName: 'Away',
        lastName: 'Tester',
    });

const HOME = { lat: 40.679, lng: -73.995, streetAddress: '123 Court St, Brooklyn' };

// A real weekend away trip, far enough ahead that it never drifts into the past.
const LEAVE = nyWallTimeToInstant(2027, 9, 3, 9, 0); // Friday 9:00 NY
const BACK = nyWallTimeToInstant(2027, 9, 5, 9, 0); // Sunday 9:00 NY
const TUESDAY_SWEEP = [{ weekday: 2, hour: 11, minute: 0 }]; // never inside the trip
const SATURDAY_SWEEP = [{ weekday: 6, hour: 11, minute: 0 }]; // once inside the trip

describe('away moves booking whose sweep day misses the trip', () => {
    it('the window really does contain no sweep (the premise)', () => {
        expect(orderController.countAwayMoves(LEAVE, BACK, TUESDAY_SWEEP)).toBe(0);
        expect(orderController.countAwayMoves(LEAVE, BACK, SATURDAY_SWEEP)).toBe(1);
    });

    it('prices the one move the app quoted, not the $1 deposit', async () => {
        const q = await orderPricing.priceOrderCents({
            awayMode: true,
            awayService: 'moves',
            awayDays: TUESDAY_SWEEP,
            pickUpTime: LEAVE.toISOString(),
            awayEndTime: BACK.toISOString(),
        });

        expect(q.amountCents).toBe(1500);
        expect(q.basis).toBe('away_moves:1');
    });

    it('charges $15 on the order itself, so the valet is paid for the job', async () => {
        const user = await makeCustomer();
        const req = {
            body: {
                customer: user._id.toString(),
                customerLocation: HOME,
                orderType: 'parking',
                serviceType: 'standard',
                duration: 120,
                pickUpTime: LEAVE.toISOString(),
                awayMode: true,
                awayService: 'moves',
                awayDays: TUESDAY_SWEEP,
                awayEndTime: BACK.toISOString(),
                // What the shipped iOS pay button showed the customer.
                totalAmount: 1500,
            },
            io: mockIo(),
            subscription: null,
            user,
        };
        const res = mockRes();
        await orderController.createOrder(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.order.totalAmount).toBe(1500);
        expect(res.body.order.awayPaidCents).toBe(1500);
        // Not a bill-later order: no schedule is pending, nothing will ever
        // come back to true this up.
        expect(res.body.order.awayBilling?.status).toBeUndefined();
    });

    it('still takes the $1 deposit when the customer gave no days at all', async () => {
        // The genuine bill-later case, which createOrder stamps
        // 'pending_schedule' and setAwaySchedule collects on. Unchanged.
        const q = await orderPricing.priceOrderCents({
            awayMode: true,
            awayService: 'moves',
            awayDays: [],
            pickUpTime: LEAVE.toISOString(),
            awayEndTime: BACK.toISOString(),
        });

        expect(q.amountCents).toBe(orderPricing.AWAY_DEPOSIT_CENTS);
        expect(q.basis).toBe('away_deposit');
    });

    it('still bills a schedule that does land in the trip per move', async () => {
        const q = await orderPricing.priceOrderCents({
            awayMode: true,
            awayService: 'moves',
            awayDays: SATURDAY_SWEEP,
            pickUpTime: LEAVE.toISOString(),
            awayEndTime: BACK.toISOString(),
        });

        expect(q.amountCents).toBe(1500);
        expect(q.basis).toBe('away_moves:1');
    });

    it('follows PricingConfig for the floored move', async () => {
        await PricingConfig.create({ key: 'default', aspCents: 1800 });

        const q = await orderPricing.priceOrderCents({
            awayMode: true,
            awayService: 'moves',
            awayDays: TUESDAY_SWEEP,
            pickUpTime: LEAVE.toISOString(),
            awayEndTime: BACK.toISOString(),
        });

        expect(q.amountCents).toBe(1800);
    });
});
