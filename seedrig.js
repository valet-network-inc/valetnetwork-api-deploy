/**
 * seedrig.js — test accounts and jobs for the app against localrig.js, so the
 * user and valet sides can be tried end to end without the live API.
 *
 * Run from inside the backend clone, with localrig.js up:
 *   node seedrig.js accounts     <- the four accounts below (always safe to rerun)
 *   node seedrig.js job          <- a codes-OFF job: Marcus on the way to Rishi Test
 *   node seedrig.js job-codes    <- the same for Codes On (2-digit codes)
 *
 * Link account by phone number (Rishi Test + Alex Test, through the real API,
 * so the phone hears every step over its socket):
 *   node seedrig.js request      <- Alex sends Rishi a request (Rishi's phone:
 *                                   "Link with Alex?", Accept / Decline)
 *   node seedrig.js approve      <- Alex accepts the request Rishi sent from the
 *                                   phone (Rishi typed 555-555-0104)
 *   node seedrig.js decline      <- Alex declines it
 *   node seedrig.js link         <- linked, no taps
 *   node seedrig.js unlink       <- Rishi unlinks
 *   WHO=alex node seedrig.js parked  <- any job mode, on Alex instead
 *   WHO=alex node seedrig.js chat Hi <- a chat message from Alex (or Rishi) on the newest job
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
    // Rishi Test's partner for Link account. No car, so linking copies Rishi's
    // into the empty profile (decision: copied once, never overwritten).
    partner: { phone: '+15555550104', firstName: 'Alex', lastName: 'Test', handoffCodes: false },
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

// One call to the rig API as `who` (a seeded account), the way their phone
// would make it.
function api(who, method, path, payload) {
    const body = payload ? JSON.stringify(payload) : '';
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port: 8099,
                path,
                method,
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                    authorization: `Bearer rig-${who.phone.replace(/\D/g, '')}`,
                },
            },
            (res) => {
                let raw = '';
                res.on('data', (c) => (raw += c));
                res.on('end', () => {
                    let json = null;
                    try {
                        json = JSON.parse(raw);
                    } catch (e) {}
                    resolve({ status: res.statusCode, json, raw });
                });
            }
        );
        req.on('error', reject);
        req.end(body);
    });
}

const say = (label, r) =>
    console.log(label, '->', r.status, r.status === 200 ? '' : (r.json && (r.json.code || r.json.message)) || r.raw.slice(0, 160));

async function main() {
    const mode = process.argv[2] || 'accounts';
    await mongoose.connect(URI);
    const User = require('./models/User');
    const Order = require('./models/Order');

    const user = await upsert(User, ACCOUNTS.user);
    const codes = await upsert(User, ACCOUNTS.codes);
    const valet = await upsert(User, ACCOUNTS.valet);
    const partner = await upsert(User, ACCOUNTS.partner);
    console.log('accounts:', [user, codes, partner, valet].map((u) => `${u.firstName} ${u.phone}`).join(' | '));
    if (mode === 'accounts') return done();

    // Link account, played from Alex's side through the real routes.
    const asAlex = (method, path, payload) => api(partner, method, path, payload);
    const pendingFor = async () => {
        const s = await asAlex('GET', `/api/account-link/status?userId=${partner._id}`);
        return s.json || {};
    };
    if (mode === 'request') {
        const r = await asAlex('POST', '/api/account-link/request', { userId: String(partner._id), phone: user.phone });
        say(`Alex asks ${user.phone}`, r);
        return done();
    }
    if (mode === 'approve' || mode === 'decline') {
        const s = await pendingFor();
        if (s.status !== 'pending' || !s.link || s.link.role !== 'inviter') {
            console.log('Nothing waiting on Alex (status:', s.status || 'none', ')');
            return done();
        }
        const r = await asAlex('POST', `/api/account-link/${mode === 'approve' ? 'authorize' : 'decline'}`, {
            userId: String(partner._id),
            linkId: String(s.link._id),
        });
        say(mode === 'approve' ? 'Alex taps Accept' : 'Alex taps Decline', r);
        return done();
    }
    if (mode === 'link') {
        const sent = await asAlex('POST', '/api/account-link/request', { userId: String(partner._id), phone: user.phone });
        say(`Alex asks ${user.phone}`, sent);
        if (!sent.json || !sent.json.link) return done();
        const ok = await api(user, 'POST', '/api/account-link/authorize', { userId: String(user._id), linkId: String(sent.json.link._id) });
        say('Rishi taps Accept', ok);
        return done();
    }
    if (mode === 'unlink') {
        const r = await api(user, 'POST', '/api/account-link/unlink', { userId: String(user._id) });
        say('Rishi unlinks', r);
        return done();
    }
    // `chat <text>`: a message from Rishi (WHO=alex: from Alex) into their
    // newest job's chat, written the way their phone writes it.
    if (mode === 'chat') {
        const who = process.env.WHO === 'alex' ? partner : user;
        const text = process.argv.slice(3).join(' ') || 'Hi!';
        const job = await Order.findOne({ customer: who._id, conversationId: { $exists: true, $ne: null } }).sort({ createdAt: -1 });
        if (!job) {
            console.log(`No chat on ${who.firstName}'s jobs. Seed one first (WHO=alex node seedrig.js job).`);
            return done();
        }
        await fsCall({
            op: 'add',
            path: `conversations/${job.conversationId}/messages`,
            data: { text, senderId: String(who._id), createdAt: { __fv: 'serverTimestamp' }, serverCreatedAt: { __fv: 'serverTimestamp' } },
        });
        console.log(`${who.firstName} says "${text}" on job ${job._id}`);
        return done();
    }

    // `accept`: Marcus takes the newest job waiting for a valet (a key
    // delivery, a booking made in the app), the way his phone would: a chat
    // first, then acceptOrder. One phone can then play both sides.
    if (mode === 'accept') {
        const job = await Order.findOne({ status: 'pending', paymentStatus: 'paid', customer: { $in: [user._id, codes._id] } }).sort({ createdAt: -1 });
        if (!job) {
            console.log('No job waiting for a valet.');
            return done();
        }
        const chat = await fsCall({
            op: 'add',
            path: 'conversations',
            data: { createdAt: { __fv: 'serverTimestamp' }, customerId: String(job.customer), valetId: String(valet._id), status: 'active', lastMessage: null },
        }).catch(() => null);
        const body = JSON.stringify({
            orderId: String(job._id),
            valetId: String(valet._id),
            valetLocation: { latitude: valet.currentLocation.lat, longitude: valet.currentLocation.lng },
            conversationId: chat && chat.id,
        });
        const answer = await new Promise((resolve, reject) => {
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port: 8099,
                    path: '/api/order/acceptOrder',
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'content-length': Buffer.byteLength(body),
                        authorization: `Bearer rig-${valet.phone.replace(/\D/g, '')}`,
                    },
                },
                (res) => {
                    let raw = '';
                    res.on('data', (c) => (raw += c));
                    res.on('end', () => resolve({ status: res.statusCode, raw }));
                }
            );
            req.on('error', reject);
            req.end(body);
        });
        console.log('accept', String(job._id), job.keyDeliveryOnly ? '(keys only)' : `(${job.orderType})`, '->', answer.status, answer.status === 200 ? 'Marcus has it' : answer.raw.slice(0, 200));
        return done();
    }

    // WHO=alex seeds the job on Alex Test (Rishi's link partner) instead.
    const customer = mode === 'job-codes' ? codes : process.env.WHO === 'alex' ? partner : user;
    // Alex's jobs clear only Alex's, so Rishi's park stays put and Home can
    // show both tickets. Rishi's and Codes On's clear each other, as before.
    const scope =
        mode === 'clear'
            ? [user._id, codes._id, partner._id]
            : customer === partner
            ? [partner._id]
            : [user._id, codes._id];
    await Order.deleteMany({ customer: { $in: scope }, status: { $ne: 'completed' } });
    await clearChats(scope).catch(() => console.log('(rig chat store not running; chats not cleared)'));
    if (mode === 'clear') {
        const r = await Order.deleteMany({ customer: { $in: scope } });
        console.log('cleared', r.deletedCount, 'jobs');
        return done();
    }

    const now = new Date();
    const code = require('./services/handoffCode').newHandoffCode; // the server's own (2 digits)
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
        // A plain park ends "completed" when the keys go back (the valet's
        // swipe); the car stays on the street until the user asks for it.
        doc.status = 'completed';
        doc.completedAt = now;
        // The valet read the signs: swept Thursdays 9-10:30 (the ticket's note).
        doc.parkingType = 'street';
        doc.parkingLocation = { ...PARKED, streetCleaning: [{ day: 4, startTime: '09:00', endTime: '10:30' }] };
        doc.vehicle = CAR;
        doc.otp.verified = true;
        doc.otpVerifiedTimes = { orderCreation: now, parkingLocation: now, returnKey: now };
    } else if (mode === 'returning') {
        doc.status = 'parked';
        doc.vehicle = CAR;
        doc.parkingLocation = PARKED;
        doc.otpVerifiedTimes = { orderCreation: now, parkingLocation: now };
        // The return beat: minted when the valet pinned the spot.
        doc.otp = { code: code(), createdAt: now, expiresAt: new Date(now.getTime() + 60 * 60000), verified: false, type: 'return_key' };
    } else if (mode === 'parked-hold') {
        // Park & Retrieve, parked, return unspent: Home offers "Cancel the return".
        doc.status = 'parked';
        doc.serviceType = 'park-and-hold';
        doc.totalAmount = 1300;
        doc.vehicle = CAR;
        doc.parkingLocation = PARKED;
        doc.otp.verified = true;
        doc.otpVerifiedTimes = { orderCreation: now, parkingLocation: now, returnKey: now };
        // Closed out: keys back with the user, return trip owed (what the
        // server stamps when the valet finishes the park).
        doc.parkClosedAt = now;
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
