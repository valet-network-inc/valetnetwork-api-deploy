/**
 * Nov 5 2026, Rishi: "after someone's last street cleaning move, don't ask them
 * 'yes use this' or set it myself, auto set it for them. same for parking as well."
 *
 * With no calendar set, loading it sets it from the last finished move or
 * street park, and the payload never carries a "Look right?" suggestion.
 * Clearing it, or having waved the guess away, keeps it off.
 */
jest.setTimeout(30000);

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../models/Order');
const User = require('../models/User');
const { getSchedule, clearSchedule } = require('../controllers/cleaningScheduleController');

let mongo;
let seq = 9175553000;

const WYCKOFF = { lat: 40.6857, lng: -73.9905, streetAddress: '88 Wyckoff St, Brooklyn, NY 11201, USA' };
const WARREN = { lat: 40.68311, lng: -73.99192, streetAddress: '286 Warren St, Brooklyn, NY 11201, USA' };

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
const load = async (user) => {
    const r = res();
    await getSchedule({ params: { userId: String(user._id) } }, r);
    return r.body;
};

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
});

const move = (user, extra = {}) =>
    Order.create({
        customer: user._id,
        customerLocation: WYCKOFF,
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

describe('the calendar sets itself from the last trip', () => {
    test('after a street-cleaning move: set, no question', async () => {
        const user = await makeUser();
        await move(user);
        const body = await load(user);
        expect(body.hasSchedule).toBe(true);
        expect(body.suggestion).toBeNull();
        expect(body.schedule.days.length).toBeGreaterThan(0);
        expect(['from_trip', 'from_orders']).toContain(body.schedule.source);
        const saved = await User.findById(user._id).lean();
        expect(saved.cleaningSchedule.days.length).toBeGreaterThan(0);
    });

    test('after a street park whose sign the valet logged: set at that spot', async () => {
        const user = await makeUser();
        await Order.create({
            customer: user._id,
            customerLocation: WYCKOFF,
            orderType: 'parking',
            parkingType: 'street',
            duration: 180,
            totalAmount: 1000,
            paymentMethod: 'card',
            status: 'completed',
            paymentStatus: 'paid',
            pickUpTime: new Date('2026-11-04T15:00:00Z'),
            parkingLocation: {
                ...WARREN,
                streetCleaning: [
                    { day: 2, startTime: '08:30', endTime: '10:00' },
                    { day: 5, startTime: '08:30', endTime: '10:00' },
                ],
            },
        });
        const body = await load(user);
        expect(body.hasSchedule).toBe(true);
        expect(body.suggestion).toBeNull();
        expect(body.schedule.address.streetAddress).toBe(WARREN.streetAddress);
        expect(body.schedule.days.map((d) => d.weekday)).toEqual([2, 5]);
    });

    test('nothing to go on: no calendar, and no question either', async () => {
        const user = await makeUser();
        const body = await load(user);
        expect(body.hasSchedule).toBe(false);
        expect(body.suggestion).toBeNull();
    });

    test('a user who waved the guess away is left alone', async () => {
        const user = await makeUser({ cleaningScheduleSuggestionDismissedAt: new Date() });
        await move(user);
        const body = await load(user);
        expect(body.hasSchedule).toBe(false);
        expect(body.suggestion).toBeNull();
    });

    test('clearing it keeps it cleared', async () => {
        const user = await makeUser();
        await move(user);
        expect((await load(user)).hasSchedule).toBe(true);
        const r = res();
        await clearSchedule({ params: { userId: String(user._id) } }, r);
        expect(r.body.hasSchedule).toBe(false);
        expect((await load(user)).hasSchedule).toBe(false);
    });
});

// Nov 6, Louisa: her move's car stayed on Carlton Ave and the card kept the
// street it left. The return leg's spot decides now.
describe('after a move whose car stayed somewhere else', () => {
    const { adoptFromTrip } = require('../services/cleaningSchedule');
    const leg = (user, parent, parkingLocation) =>
        Order.create({
            customer: user._id,
            customerLocation: WYCKOFF,
            aspMode: true,
            orderType: 'retrieval',
            duration: 60,
            totalAmount: 0,
            paymentMethod: 'card',
            status: 'completed',
            paymentStatus: 'paid',
            pickUpTime: new Date('2026-11-05T17:00:00Z'),
            linkedOrderId: parent._id,
            parkingLocation,
        });

    test("the card follows the car, with that block's sign", async () => {
        const user = await makeUser();
        const parent = await move(user);
        const l = await leg(user, parent, {
            ...WARREN,
            streetCleaning: [
                { day: 2, startTime: '11:30', endTime: '13:00' },
                { day: 5, startTime: '11:30', endTime: '13:00' },
            ],
        });
        expect(await adoptFromTrip(l)).toBe(true);
        const saved = await User.findById(user._id).lean();
        expect(saved.cleaningSchedule.address.streetAddress).toBe(WARREN.streetAddress);
        expect(saved.cleaningSchedule.days.map((d) => [d.weekday, d.hour, d.minute])).toEqual([
            [2, 11, 30],
            [5, 11, 30],
        ]);
    });

    test('no sign known there: the card is left as it was', async () => {
        const user = await makeUser();
        const parent = await move(user);
        const l = await leg(user, parent, { ...WARREN });
        expect(await adoptFromTrip(l)).toBe(false);
        const saved = await User.findById(user._id).lean();
        expect(saved.cleaningSchedule && saved.cleaningSchedule.address && saved.cleaningSchedule.address.streetAddress).toBeFalsy();
    });

    test("the car came back to its block: the card is the user's own spot", async () => {
        const user = await makeUser();
        const parent = await move(user);
        const l = await leg(user, parent, { ...WYCKOFF });
        expect(await adoptFromTrip(l)).toBe(true);
        const saved = await User.findById(user._id).lean();
        expect(saved.cleaningSchedule.address.streetAddress).toBe(WYCKOFF.streetAddress);
    });
});
