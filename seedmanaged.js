/**
 * seedmanaged.js — put the rig into each state the managed-cleaning screens
 * have to be photographed in.
 *
 * Run from inside the backend clone, against localrig.js:
 *   node seedmanaged.js garage-armed     # $250, car with us, block read
 *   node seedmanaged.js garage-blind     # $250, car with us, block unreadable
 *   node seedmanaged.js garage-empty     # $250, nothing parked with us
 *   node seedmanaged.js anywhere-armed   # $300, car with us, block read
 *   node seedmanaged.js permove          # $50/$100 with typed days (regression)
 *   node seedmanaged.js noplan           # no subscription at all (regression)
 *   node seedmanaged.js valet-parked     # a valet job sitting at 'parked'
 *   node seedmanaged.js clear
 *
 * Writes documents straight into the in-memory database. Nothing is dispatched,
 * nothing is charged.
 */
const mongoose = require('mongoose');

const URI = 'mongodb://127.0.0.1:27099/test';

// Carroll Gardens, where the location is pinned for these shots.
const HERE = { lat: 40.6795, lng: -73.995, streetAddress: '5 2nd St, Brooklyn, NY 11231' };
const PARKED = { lat: 40.6802, lng: -73.9961, streetAddress: '84 2nd Pl, Brooklyn, NY 11231' };
const MON_830 = [{ day: 1, startTime: '08:30', endTime: '10:00' }];

async function main() {
    const mode = process.argv[2] || 'garage-armed';
    await mongoose.connect(URI);

    const User = require('./models/User');
    const Order = require('./models/Order');
    const Subscription = require('./models/Subscription');
    const ParkingNote = require('./models/ParkingNote');
    const CurbCustody = require('./models/CurbCustody');
    const OpsAlert = require('./models/OpsAlert');
    const curbCustody = require('./services/curbCustody');

    const customer = await User.findOne({ isValet: { $ne: true } }).sort({ createdAt: -1 });
    if (!customer) {
        console.error('No customer yet — sign up in the app first.');
        process.exit(1);
    }

    let valet = await User.findOne({ isValet: true });
    if (!valet) {
        valet = await User.create({
            phone: '+19175550147',
            firstName: 'Marcus',
            lastName: 'Rivera',
            isValet: true,
            isActive: true,
            verified: true,
            age: 34,
            currentLocation: { ...HERE, address: HERE.streetAddress, lastUpdated: new Date() },
        });
    }

    const wipe = async () => {
        await Promise.all([
            Order.deleteMany({ customer: customer._id }),
            Subscription.deleteMany({ user: customer._id }),
            CurbCustody.deleteMany({ customer: customer._id }),
            ParkingNote.deleteMany({}),
            OpsAlert.deleteMany({}),
        ]);
        await User.updateOne({ _id: customer._id }, { $unset: { cleaningSchedule: 1 } });
    };

    const makeSub = (tier, extra = {}) =>
        Subscription.create({
            user: customer._id,
            tier,
            interval: 'month',
            status: 'active',
            amountCents: { home_garage: 25000, valet_anywhere: 30000, street_cleaning: 10000 }[tier],
            stripeSubscriptionId: `sub_shot_${tier}_${Date.now()}`,
            currentPeriodStart: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
            currentPeriodEnd: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000),
            ...(tier === 'home_garage' ? { homeAddress: HERE } : {}),
            ...extra,
        });

    const makeParked = (sub) =>
        Order.create({
            customer: customer._id,
            valet: valet._id,
            customerLocation: HERE,
            parkingLocation: PARKED,
            parkingType: 'street',
            orderType: 'parking',
            duration: 120,
            pickUpTime: new Date(Date.now() - 3 * 60 * 60 * 1000),
            status: 'parked',
            parkedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
            totalAmount: 0,
            listPriceCents: 1000,
            paymentMethod: 'card',
            paymentStatus: 'paid',
            serviceType: 'park-and-hold',
            coveredBySubscription: sub._id,
            vehicle: { make: 'BMW', model: 'X5', color: 'Red', licensePlate: 'AA224' },
        });

    const arm = async (sub, { readBlock }) => {
        const order = await makeParked(sub);
        await curbCustody.arm({ order: await Order.findById(order._id) });
        if (readBlock) {
            const note = await ParkingNote.create({
                order: order._id,
                valet: valet._id,
                location: PARKED,
                signPhotoBucket: 'rig',
                signPhotoStoragePath: `parking-notes/${order._id}/sign.jpg`,
                streetCleaning: MON_830,
                sweepDataStatus: 'captured',
            });
            await curbCustody.enrichFromNote({
                order: await Order.findById(order._id),
                note,
            });
        }
        return order;
    };

    switch (mode) {
        case 'garage-armed': {
            await wipe();
            const sub = await makeSub('home_garage');
            await arm(sub, { readBlock: true });
            break;
        }
        case 'garage-blind': {
            await wipe();
            const sub = await makeSub('home_garage');
            await arm(sub, { readBlock: false });
            break;
        }
        case 'garage-empty': {
            await wipe();
            await makeSub('home_garage');
            break;
        }
        case 'anywhere-armed': {
            await wipe();
            const sub = await makeSub('valet_anywhere');
            await arm(sub, { readBlock: true });
            break;
        }
        case 'permove': {
            await wipe();
            const days = [
                { weekday: 1, hour: 9, minute: 0 },
                { weekday: 4, hour: 9, minute: 0 },
            ];
            await makeSub('street_cleaning', {
                movesPerWeek: 2,
                aspSchedule: { address: HERE, days, source: 'onboarding' },
            });
            await User.updateOne(
                { _id: customer._id },
                { $set: { cleaningSchedule: { address: HERE, days, status: 'active', source: 'subscription' } } }
            );
            break;
        }
        case 'noplan': {
            await wipe();
            break;
        }
        case 'valet-parked': {
            await wipe();
            const sub = await makeSub('home_garage');
            const order = await makeParked(sub);
            await Order.updateOne(
                { _id: order._id },
                { $set: { status: 'parked', aspMode: true, valet: valet._id } }
            );
            console.log('valet job order:', String(order._id), 'valet:', String(valet._id));
            break;
        }
        case 'clear':
            await wipe();
            break;
        default:
            console.error('Unknown mode:', mode);
            process.exit(1);
    }

    const custody = await CurbCustody.findOne({ customer: customer._id, closedAt: { $exists: false } }).lean();
    console.log(
        `[${mode}] customer=${customer.phone} ` +
            `sub=${(await Subscription.findOne({ user: customer._id }).lean())?.tier || 'none'} ` +
            `custody=${custody ? `${custody.state} @ ${custody.spot.streetAddress}` : 'none'} ` +
            `windows=${custody ? (custody.rules.windows || []).length : 0}`
    );
    await mongoose.disconnect();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
