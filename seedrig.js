/**
 * seedrig.js — test accounts and jobs for the app against localrig.js, so the
 * user and valet sides can be tried end to end without the live API.
 *
 * Run from inside the backend clone, with localrig.js up:
 *   node seedrig.js accounts     <- the three accounts below (always safe to rerun)
 *   node seedrig.js job          <- a codes-OFF job: Marcus on the way to Rishi Test
 *   node seedrig.js job-codes    <- the same for Codes On (3-digit codes)
 *   node seedrig.js pending      <- a job no valet has taken yet
 *   node seedrig.js parked       <- parked, keys walked back
 *   node seedrig.js returning    <- keys coming back: the say-the-code beat
 *   node seedrig.js history      <- finished trips for Activity and receipts
 *   node seedrig.js clear        <- every job gone
 *
 * Sign in on the app (dev build pointed at the rig) with the phone and any six
 * digits. Writes documents directly: nothing is charged, nobody is dispatched.
 */
const mongoose = require('mongoose');

const URI = 'mongodb://127.0.0.1:27099/test';
const WYCKOFF = { lat: 40.68526, lng: -73.98921, streetAddress: '43 Wyckoff St, Brooklyn, NY 11201, USA' };
const PARKED = { lat: 40.68311, lng: -73.99192, streetAddress: '286 Warren St, Brooklyn, NY 11201, USA' };
const CAR = { color: 'Blue', make: 'Subaru', model: 'Outback', licensePlate: 'KDT-4417' };

const ACCOUNTS = {
    user: { phone: '+15555550101', firstName: 'Rishi', lastName: 'Test', handoffCodes: false, vehicle: CAR },
    codes: { phone: '+15555550103', firstName: 'Codes', lastName: 'On', handoffCodes: true },
    valet: {
        phone: '+15555550102',
        firstName: 'Marcus',
        lastName: 'Rivera',
        isValet: true,
        isActive: true,
        verified: true,
        age: 34,
        // Past the Yardstik gate, or the app parks him on the check screen.
        backgroundCheck: { status: 'passed', provider: 'grandfathered' },
        // ...and past onboarding, or acceptOrder answers 403.
        valetOnboardingStatus: 'active',
        currentLocation: { lat: 40.6866, lng: -73.9905, address: 'Boerum Pl, Brooklyn', lastUpdated: new Date() },
    },
};

// The rig's Firestore stand-in (rigfirestore.js, started by localrig.js). Each
// seeded job gets a chat of its own there, the way accepting one does, so the
// app never falls back to an older job's chat between the same two people.
const http = require('http');
function fsCall(body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request(
            { host: '127.0.0.1', port: 8098, path: '/fs', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
            (res) => {
                let raw = '';
                res.on('data', (c) => (raw += c));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(raw || '{}'));
                    } catch (e) {
                        reject(e);
                    }
                });
            }
        );
        req.on('error', reject);
        req.end(data);
    });
}
async function clearChats(customerIds) {
    for (const id of customerIds) {
        const r = await fsCall({ op: 'query', path: 'conversations', wheres: [['customerId', '==', String(id)]] }).catch(() => ({ docs: [] }));
        for (const d of r.docs || []) await fsCall({ op: 'delete', path: `conversations/${d.id}` });
    }
}

async function upsert(User, fields) {
    const found = await User.findOne({ phone: fields.phone });
    if (found) {
        Object.assign(found, fields);
        await found.save();
        return found;
    }
    return User.create({ firebaseUid: `rig-${fields.phone.replace(/\D/g, '')}`, verified: true, isActive: true, ...fields });
}

async function main() {
    const mode = process.argv[2] || 'accounts';
    await mongoose.connect(URI);
    const User = require('./models/User');
    const Order = require('./models/Order');

    const user = await upsert(User, ACCOUNTS.user);
    const codes = await upsert(User, ACCOUNTS.codes);
    const valet = await upsert(User, ACCOUNTS.valet);
    console.log('accounts:', [user, codes, valet].map((u) => `${u.firstName} ${u.phone}`).join(' | '));
    if (mode === 'accounts') return done();

    const customer = mode === 'job-codes' ? codes : user;
    await Order.deleteMany({ customer: { $in: [user._id, codes._id] }, status: { $ne: 'completed' } });
    await clearChats([user._id, codes._id]).catch(() => console.log('(rig chat store not running; chats not cleared)'));
    if (mode === 'clear') {
        const r = await Order.deleteMany({ customer: { $in: [user._id, codes._id] } });
        console.log('cleared', r.deletedCount, 'jobs');
        return done();
    }

    const now = new Date();
    const code = () => String(Math.floor(100 + Math.random() * 900)); // 3 digits
    const base = {
        customer: customer._id,
        customerLocation: WYCKOFF,
        orderType: 'parking',
        serviceType: 'standard',
        duration: 180,
        paymentMethod: 'card',
        paymentStatus: 'paid',
        totalAmount: 1000,
        handoffCode: !!customer.handoffCodes,
        createdAt: now,
        pickUpTime: now,
    };

    if (mode === 'history') {
        const day = 86400000;
        const rows = [
            { d: 1, amt: 1300, service: 'park-and-hold' },
            { d: 3, amt: 1000 },
            { d: 6, amt: 1500, asp: true },
        ];
        for (const r of rows) {
            const at = new Date(now.getTime() - r.d * day);
            await Order.create({
                ...base,
                serviceType: r.service || 'standard',
                status: 'completed',
                totalAmount: r.amt,
                valet: valet._id,
                vehicle: CAR,
                parkingLocation: PARKED,
                createdAt: at,
                pickUpTime: at,
                ...(r.asp ? { aspMode: true, asp_time: at } : {}),
                otpVerifiedTimes: { orderCreation: at, parkingLocation: at, returnKey: at },
            });
        }
        console.log('seeded', rows.length, 'finished trips');
        return done();
    }

    const doc = {
        ...base,
        status: 'accepted',
        valet: valet._id,
        valetLocation: { lat: 40.6861, lng: -73.9902, lastUpdated: now },
        // The collect beat: minted at booking, as createOrder does (codes on or off).
        otp: { code: code(), createdAt: now, expiresAt: new Date(now.getTime() + 60 * 60000), verified: false, type: 'order_creation' },
        suggestedVehicle: customer.vehicle && customer.vehicle.licensePlate ? customer.vehicle : undefined,
    };
    if (mode === 'pending') {
        doc.status = 'pending';
        delete doc.valet;
        delete doc.valetLocation;
    } else if (mode === 'parked') {
        doc.status = 'parked';
        doc.vehicle = CAR;
        doc.parkingLocation = PARKED;
        doc.otp.verified = true;
        doc.otpVerifiedTimes = { orderCreation: now, parkingLocation: now, returnKey: now };
    } else if (mode === 'returning') {
        doc.status = 'parked';
        doc.vehicle = CAR;
        doc.parkingLocation = PARKED;
        doc.otpVerifiedTimes = { orderCreation: now, parkingLocation: now };
        // The return beat: minted when the valet pinned the spot.
        doc.otp = { code: code(), createdAt: now, expiresAt: new Date(now.getTime() + 60 * 60000), verified: false, type: 'return_key' };
    } else if (mode === 'car-away') {
        // A park whose car stands a block from where the keys change hands.
        doc.status = 'pending';
        delete doc.valet;
        delete doc.valetLocation;
        doc.carLocation = { lat: 40.68437, lng: -73.98682, streetAddress: '120 Bergen St, Brooklyn, NY 11217, USA' };
    } else if (mode !== 'job' && mode !== 'job-codes') {
        console.error('unknown mode', mode);
        process.exit(1);
    }
    if (doc.valet) {
        const chat = await fsCall({
            op: 'add',
            path: 'conversations',
            data: { createdAt: { __fv: 'serverTimestamp' }, customerId: String(customer._id), valetId: String(valet._id), status: 'active', lastMessage: null },
        }).catch(() => null);
        if (chat && chat.id) doc.conversationId = chat.id;
    }
    const o = await Order.create(doc);
    console.log('job', o._id.toString(), '->', o.status, `· codes ${o.handoffCode ? 'ON' : 'off'}`, `· code ${o.otp && o.otp.code}`);
    return done();
}

async function done() {
    await mongoose.disconnect();
    process.exit(0);
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
