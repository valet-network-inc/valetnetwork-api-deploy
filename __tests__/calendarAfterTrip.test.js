/**
 * The street-cleaning calendar turns on when a trip ends (Nov 4 2026).
 * Run: npx jest calendarAfterTrip
 *
 * Rishi: "after a regular parking or a street cleaning move is done, turn on
 * the calendar for them, and set it to whatever the last parked spot was".
 *
 *  1. A parking on the street sets it to the curb we left the car on, with
 *     that sign's days.
 *  2. A move's automatic return sets it to the user's own spot, with the sign
 *     there when we have parked on that block before, else the move's day.
 *  3. A plan, an away trip, a retrieval and a garage park leave it alone.
 */
jest.setTimeout(30000);

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../models/Order');
const User = require('../models/User');
const { adoptFromTrip } = require('../services/cleaningSchedule');

jest.mock('../services/subscriptionService', () => ({
    getActiveSubscription: jest.fn(async () => null),
}));
const subscriptionService = require('../services/subscriptionService');

let mongo;
let seq = 9175551000;

const WARREN = { lat: 40.68628, lng: -73.99296, streetAddress: '286 Warren St, Brooklyn, NY 11201, USA' };
const BALTIC = { lat: 40.68437, lng: -73.99419, streetAddress: '331 Baltic St, Brooklyn, NY 11201, USA' };

const makeUser = () =>
    User.create({
        firstName: 'Rishi',
        lastName: 'Test',
        email: `u${new mongoose.Types.ObjectId()}@example.com`,
        phone: String(++seq),
        firebaseUid: `uid_${seq}`,
        verified: true,
    });

const order = (customer, extra) =>
    Order.create({
        customer: customer._id,
        customerLocation: WARREN,
        parkingType: 'street',
        duration: 180,
        pickUpTime: new Date('2026-11-05T14:00:00Z'),
        totalAmount: 1000,
        status: 'completed',
        orderType: 'parking',
        paymentMethod: 'card',
        ...extra,
    });

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
});

beforeEach(() => subscriptionService.getActiveSubscription.mockResolvedValue(null));

describe('the calendar after a trip', () => {
    it('a street parking sets it to the curb we left the car on, with its sign', async () => {
        const u = await makeUser();
        const park = await order(u, {
            parkingLocation: { ...WARREN, streetCleaning: [{ day: 4, startTime: '09:00', endTime: '10:30' }, { day: 1, startTime: '09:00', endTime: '10:30' }] },
        });
        expect(await adoptFromTrip(park)).toBe(true);
        const s = (await User.findById(u._id).lean()).cleaningSchedule;
        expect(s.address.streetAddress).toBe(WARREN.streetAddress);
        expect(s.days).toEqual([
            { weekday: 1, hour: 9, minute: 0 },
            { weekday: 4, hour: 9, minute: 0 },
        ]);
        expect(s.status).toBe('active');
        expect(s.source).toBe('from_trip');
    });

    it("a move's return sets it to the user's own spot, with the sign we read there before", async () => {
        const u = await makeUser();
        // An earlier park on the same block left its sign on the order.
        await order(u, { parkingLocation: { ...WARREN, streetCleaning: [{ day: 4, startTime: '09:00', endTime: '10:30' }] } });
        const move = await order(u, {
            aspMode: true,
            serviceType: 'park-and-hold',
            totalAmount: 1500,
            duration: 90,
            parkingLocation: { ...BALTIC, streetCleaning: [{ day: 2, startTime: '11:30', endTime: '13:00' }] },
        });
        const leg = await order(u, {
            orderType: 'retrieval',
            parkingType: 'retrieval',
            aspMode: true,
            linkedOrderId: move._id,
            totalAmount: 0,
            parkingLocation: BALTIC,
        });
        expect(await adoptFromTrip(leg)).toBe(true);
        const s = (await User.findById(u._id).lean()).cleaningSchedule;
        // Where the car came back to, not the block it waited out the sweep on.
        expect(s.address.streetAddress).toBe(WARREN.streetAddress);
        expect(s.days).toEqual([{ weekday: 4, hour: 9, minute: 0 }]);
    });

    it("with no sign on file, a move's own day stands in", async () => {
        const u = await makeUser();
        const move = await order(u, { aspMode: true, duration: 90, totalAmount: 1500 });
        expect(await adoptFromTrip(move)).toBe(true);
        const s = (await User.findById(u._id).lean()).cleaningSchedule;
        // Nov 5 2026 14:00Z is Thursday 9 AM in New York.
        expect(s.days).toEqual([{ weekday: 4, hour: 9, minute: 0 }]);
    });

    it('leaves a plan, an away trip, a retrieval and a garage park alone', async () => {
        const u = await makeUser();
        const withSign = { ...WARREN, streetCleaning: [{ day: 4, startTime: '09:00', endTime: '10:30' }] };
        expect(await adoptFromTrip(await order(u, { parkingType: 'garage', parkingLocation: withSign }))).toBe(false);
        expect(await adoptFromTrip(await order(u, { aspMode: true, awayMode: true }))).toBe(false);
        expect(
            await adoptFromTrip(await order(u, { orderType: 'retrieval', parkingType: 'retrieval', parkingLocation: withSign }))
        ).toBe(false);
        subscriptionService.getActiveSubscription.mockResolvedValue({ _id: 'sub', tier: 'street_cleaning' });
        expect(await adoptFromTrip(await order(u, { parkingLocation: withSign }))).toBe(false);
        expect((await User.findById(u._id).lean()).cleaningSchedule?.days || []).toEqual([]);
    });
});
