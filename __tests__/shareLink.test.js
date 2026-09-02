/**
 * The standing handoff link the customer gives her doorman.
 * Run: npx jest shareLink
 *
 * Randi leaves her key at the front desk for her 8:30am street-cleaning move
 * and is in a meeting when the valet arrives. She asked for the code the night
 * before. She cannot have it: at that beat the code is the VALET'S, read out
 * loud on arrival, and whoever holds the keys types it back. So the doorman
 * doesn't need a number, he needs a screen — one link, texted once, that still
 * works next Thursday.
 *
 * A link that releases a car is worth being paranoid about, so most of what is
 * asserted here is what it must NOT do: never put a code or a keypad on screen
 * outside a real handoff window, never carry a phone number or an email or an
 * id, never let a stolen link sit there guessing six digits until it wins.
 */

/**
 * The valet's thread, as much of it as this file cares about.
 *
 * Only one query runs against it here: "is there an `otp_collect_keys` message
 * on this conversation", which is how the screen finds out the valet has
 * actually arrived and read a number out. Orders without a `conversationId`
 * never reach it — that is the fail-open path, and it is most of this file.
 */
let mockThread = {};
let mockFirestoreThrows = false;

jest.mock('firebase-admin', () => {
    const firestore = () => ({
        collection: () => ({
            doc: (conversationId) => ({
                collection: () => ({
                    where: (field, _op, value) => ({
                        limit: (n) => ({
                            get: async () => {
                                if (mockFirestoreThrows) {
                                    throw new Error('Firestore unreachable');
                                }
                                const docs = (mockThread[conversationId] || [])
                                    .filter((doc) => doc.data()[field] === value)
                                    .slice(0, n);
                                return { docs };
                            },
                        }),
                    }),
                }),
            }),
        }),
    });
    /**
     * Firebase ID tokens, as much of them as this file cares about.
     *
     * Minting and revoking now want proof that the caller IS the customer, and
     * the only thing that proves it is a token Google signed — see
     * `callerFirebaseUid` in the controller. Here a token is the string
     * `uid:<firebaseUid>`; anything else fails to verify, which is what a
     * stranger posting a customer id has.
     */
    const auth = () => ({
        verifyIdToken: async (token) => {
            const match = /^uid:(.+)$/.exec(String(token));
            if (!match) throw new Error('Decoding Firebase ID token failed');
            return { uid: match[1] };
        },
    });

    return { firestore, auth, messaging: () => ({ send: async () => 'msg-1' }) };
});

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../models/Order');
const User = require('../models/User');
const shareRouter = require('../routes/share');
const { handoffWindow } = require('../controllers/shareController');

let mongo;

const app = express();
app.use(express.json());
app.use('/api/share', shareRouter);

let phoneSeq = 9175550000;
// Everybody here has signed in on a phone, because that is the only way a
// customer reaches the mint at all now.
const makeUser = (isValet = false, extra = {}) => User.create({
    firstName: isValet ? 'Marco' : 'Randi',
    lastName: 'Tester',
    email: `u${new mongoose.Types.ObjectId()}@example.com`,
    phone: String(++phoneSeq),
    firebaseUid: `uid_${phoneSeq}`,
    verified: true,
    isValet,
    ...extra,
});

const liveOtp = (code, type) => ({
    code,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000),
    verified: false,
    type,
});

const CURB = { lat: 40.6798, lng: -73.9899, streetAddress: '296 12th St' };
// Four blocks north — a few minutes on foot. Nothing is gated on it any more;
// it is only there to be turned into "about four minutes away" on screen.
const FOUR_BLOCKS_OFF = { lat: 40.6835, lng: -73.9899, streetAddress: '5th Ave' };

const makeOrder = (customerId, extra = {}) => Order.create({
    customer: customerId,
    customerLocation: CURB,
    parkingType: 'street',
    orderType: 'parking',
    serviceType: 'park-and-hold',
    duration: 120,
    pickUpTime: new Date(),
    status: 'accepted',
    totalAmount: 1650,
    paymentMethod: 'card',
    paymentStatus: 'paid',
    vehicle: { color: 'Grey', model: 'Honda Civic', licensePlate: 'ABC1234' },
    ...extra,
});

/**
 * The morning beat: a valet carrying the job, with a code to read out.
 *
 * No `valetLocation` on purpose. That field is written only for the one order
 * a valet has open, and they carry several at a time — so absent is the normal
 * case on a busy Thursday, and the fixtures say so.
 */
const makeTypeItOrder = (customerId, valetId, code = '481902', extra = {}) =>
    makeOrder(customerId, {
        valet: valetId,
        acceptedAt: new Date(),
        otp: liveOtp(code, 'order_creation'),
        ...extra,
    });

/** The evening beat: the car is parked and the keys are coming back. */
const makeSayItOrder = (customerId, valetId, code = '773311', extra = {}) =>
    makeOrder(customerId, {
        valet: valetId,
        acceptedAt: new Date(),
        status: 'parked',
        parkingLocation: { lat: 40.6801, lng: -73.9912, streetAddress: '310 12th St' },
        parkedAt: new Date(),
        otpVerifiedTimes: { orderCreation: new Date() },
        otp: liveOtp(code, 'return_key'),
        ...extra,
    });

/**
 * The Authorization header the customer's own phone sends.
 *
 * `utils/apiAuth.js` has attached one to every call to this API since 2.2.0;
 * the doorman routes are the first that refuse to act without it.
 */
const asCustomer = async (userId) => {
    const user = await User.findById(userId).select('firebaseUid');
    return `Bearer uid:${user.firebaseUid}`;
};

const mintLink = async (userId, token) =>
    request(app)
        .post('/api/share/link')
        .set('Authorization', await asCustomer(userId))
        .send(token ? { userId: String(userId), token } : { userId: String(userId) });

// Whoever is holding the link. Turning it off is a change to the link, so
// possession is a credential for it — this is the path the app itself uses.
const revokeLink = (token) =>
    request(app).post('/api/share/link/revoke').send({ token });

// The other way off: the account holder, proved the same way minting is. This
// is what rescues a customer whose link somebody else minted and kept.
const revokeAsOwner = async (userId) =>
    request(app)
        .post('/api/share/link/revoke')
        .set('Authorization', await asCustomer(userId))
        .send({ userId: String(userId) });

// Somebody who read a customer id off the pending feed and nothing else.
const strangerMints = (userId) =>
    request(app).post('/api/share/link').send({ userId: String(userId) });

const tokenFor = async (userId) => (await mintLink(userId)).body.token;

const get = (token) => request(app).get(`/api/share/${token}`);

const guess = (token, otp) =>
    request(app).post(`/api/share/${token}/verify`).send({ otp });

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
});

afterEach(async () => {
    await Order.deleteMany({});
    await User.deleteMany({});
    mockThread = {};
    mockFirestoreThrows = false;
});

let announceSeq = 0;
/** The valet reading his code out loud, as his app records it. */
const valetReadsCodeAloud = (conversationId, code) => {
    announceSeq += 1;
    const doc = {
        id: `announce-${announceSeq}`,
        data: () => ({
            text: `OTP for collecting keys is ${code}`,
            senderId: 'system',
            isSystemMessage: true,
            messageType: 'otp_collect_keys',
        }),
    };
    mockThread[conversationId] = [...(mockThread[conversationId] || []), doc];
    return doc;
};

describe('minting the link', () => {
    test('the token comes back once — a second ask is told a link exists and nothing more', async () => {
        // Customer ids are published unauthenticated by getPendingOrders, and
        // this endpoint takes nothing but an id. Handing the existing token
        // back gave anyone who read that list a stranger's live doorman link.
        const customer = await makeUser();

        const first = await mintLink(customer._id);
        const second = await mintLink(customer._id);

        expect(first.statusCode).toBe(200);
        expect(first.body.url).toBe(`https://valetnetwork.co/h/${first.body.token}`);

        expect(second.statusCode).toBe(200);
        expect(second.body).toEqual({ success: true, alreadyLinked: true });
        expect(JSON.stringify(second.body)).not.toContain(first.body.token);
    });

    test('and the link already in the doorman’s texts survives being asked for again', async () => {
        const customer = await makeUser();

        const first = await mintLink(customer._id);
        await mintLink(customer._id);

        expect((await get(first.body.token)).statusCode).toBe(200);
        // `+doormanLink.token`: hidden on the schema, because the whole User
        // is answered to anybody by `GET /api/auth/getUserById`.
        const stored = await User.findById(customer._id).select('+doormanLink.token');
        expect(stored.doormanLink.token).toBe(first.body.token);
    });

    test('there is no clock on it — a standing link cannot expire on the morning it is needed', async () => {
        const customer = await makeUser();

        const { body } = await mintLink(customer._id);

        expect(body.expiresAt).toBeNull();
        const stored = await User.findById(customer._id).select('+doormanLink.token');
        expect(stored.doormanLink.token).toBe(body.token);
        expect(stored.doormanLink.revokedAt).toBeFalsy();
    });

    test('the token is not the customer id in disguise', async () => {
        const customer = await makeUser();

        const { body } = await mintLink(customer._id);

        expect(body.token).not.toContain(String(customer._id));
        expect(body.token.length).toBeGreaterThan(40);
    });

    test('after a revoke, asking again mints a live one rather than resurrecting the dead link', async () => {
        const customer = await makeUser();

        const first = await mintLink(customer._id);
        await revokeLink(first.body.token);
        const second = await mintLink(customer._id);

        expect(second.body.token).not.toBe(first.body.token);
        expect((await get(first.body.token)).statusCode).toBe(404);
        expect((await get(second.body.token)).statusCode).toBe(200);
    });
});

describe('confirming the link this phone is holding', () => {
    // `alreadyLinked` says a link exists. It never said whether it was OURS,
    // and the app read it as "yours is fine" — so a link revoked and re-minted
    // from another device left the first phone texting a dead url to a doorman.
    // Possession is the thing that can be checked, and checking it reveals
    // nothing to a caller who was not already holding the answer.

    test('the holder is told its url is the live one', async () => {
        const customer = await makeUser();
        const { body: minted } = await mintLink(customer._id);

        const res = await mintLink(customer._id, minted.token);

        expect(res.body).toEqual({
            success: true,
            alreadyLinked: true,
            tokenIsCurrent: true,
        });
    });

    test('and a phone holding a url that was replaced elsewhere is told so', async () => {
        const customer = await makeUser();
        const first = await mintLink(customer._id);

        // Another device: turn it off, make a new one. This phone still has
        // the old url in AsyncStorage and no idea.
        await revokeLink(first.body.token);
        const second = await mintLink(customer._id);
        expect(second.body.token).toBeTruthy();

        const res = await mintLink(customer._id, first.body.token);

        expect(res.body.alreadyLinked).toBe(true);
        expect(res.body.tokenIsCurrent).toBe(false);
        // Told it is stale, never handed the replacement.
        expect(JSON.stringify(res.body)).not.toContain(second.body.token);
    });

    test('asking without a token is still told only that a link exists', async () => {
        const customer = await makeUser();
        const first = await mintLink(customer._id);

        const res = await mintLink(customer._id);

        // No `tokenIsCurrent` at all: a client that made no claim must not read
        // a bare `false` as "your link is dead".
        expect(res.body).toEqual({ success: true, alreadyLinked: true });
        expect(JSON.stringify(res.body)).not.toContain(first.body.token);
    });
});

describe('who may mint one at all', () => {
    // The endpoint takes a customer id, and customer ObjectIds are published
    // unauthenticated by `GET /api/order/getPendingOrders`. So for as long as
    // an id was the whole of what it asked for, this was a dispenser: read an
    // id off that feed, post it here, walk away with a standing link to a
    // stranger's car. `firebaseUid` is no better — `GET /api/auth/getUserById`
    // answers with the whole user document and valet 2.2.0 reads the uid off
    // it to address its pushes, so it cannot be taken off tonight and anyone
    // with the id has the uid. What is left is the Firebase ID token.

    test('a customer id on its own mints nothing, and says nothing', async () => {
        const customer = await makeUser();

        const res = await strangerMints(customer._id);

        expect(res.statusCode).toBe(401);
        expect(res.body.token).toBeUndefined();
        // Not even whether this customer exists, or has a link.
        expect(res.body.alreadyLinked).toBeUndefined();
        const stored = await User.findById(customer._id).select('+doormanLink.token');
        expect(stored.doormanLink?.token).toBeFalsy();
    });

    test('and neither does somebody else’s sign-in', async () => {
        const randi = await makeUser();
        const stranger = await makeUser();

        const res = await request(app)
            .post('/api/share/link')
            .set('Authorization', await asCustomer(stranger._id))
            .send({ userId: String(randi._id) });

        expect(res.statusCode).toBe(401);
        const stored = await User.findById(randi._id).select('+doormanLink.token');
        expect(stored.doormanLink?.token).toBeFalsy();
    });

    test('a token that does not verify is the same as no token', async () => {
        const customer = await makeUser();

        const res = await request(app)
            .post('/api/share/link')
            .set('Authorization', 'Bearer not-a-real-id-token')
            .send({ userId: String(customer._id) });

        expect(res.statusCode).toBe(401);
    });

    test('the customer herself gets her link', async () => {
        const customer = await makeUser();

        const res = await mintLink(customer._id);

        expect(res.statusCode).toBe(200);
        expect(res.body.token).toBeTruthy();
        expect((await get(res.body.token)).statusCode).toBe(200);
    });
});

describe('the token is not in any user document anybody can read', () => {
    // `GET /api/auth/getUserById/:userId` answers with the whole User, to
    // anyone, and so does `POST /api/auth/loginUser`. A plain path on the
    // schema put the live doorman token in both of those beside the customer's
    // name — which is the car, handed over for an ObjectId. It is
    // `select: false` now, and only the three reads in shareController ask for
    // it back.

    test('an ordinary read of the customer does not carry it', async () => {
        const customer = await makeUser();
        const { body } = await mintLink(customer._id);

        const asAnyoneWouldReadIt = await User.findById(customer._id);

        expect(JSON.stringify(asAnyoneWouldReadIt)).not.toContain(body.token);
        expect(asAnyoneWouldReadIt.doormanLink.token).toBeUndefined();
        // The fact that a link exists is not the credential, and stays.
        expect(asAnyoneWouldReadIt.doormanLink.createdAt).toBeTruthy();
    });

    test('and the link still works, because the pages that need it ask for it', async () => {
        const customer = await makeUser();
        const { body } = await mintLink(customer._id);

        expect((await get(body.token)).statusCode).toBe(200);
        expect((await revokeLink(body.token)).statusCode).toBe(200);
        expect((await get(body.token)).body.code).toBe('REVOKED');
    });
});

describe('turning the link off', () => {
    // Two ways in, and the feature needs both. Possession is the everyday one.
    // Ownership is the way back from a link this phone has not got — which
    // used to be no way at all, and that was the trap: mint was open, so a
    // stranger could have a link minted for a customer and keep the only copy,
    // and she was the one person who could not switch it off.

    test('a customer id with nothing behind it is not a credential', async () => {
        const customer = await makeUser();
        const token = await tokenFor(customer._id);

        const res = await request(app)
            .post('/api/share/link/revoke')
            .send({ userId: String(customer._id) });

        expect(res.statusCode).toBe(401);
        expect((await get(token)).statusCode).toBe(200);
    });

    test('but the customer herself can, holding no token at all', async () => {
        const customer = await makeUser();
        const token = await tokenFor(customer._id);

        expect((await revokeAsOwner(customer._id)).statusCode).toBe(200);

        const res = await get(token);
        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('REVOKED');
    });

    test('a hijacked link is recoverable — revoke by account, then mint again', async () => {
        // The whole of the old attack, replayed. Step one no longer works, so
        // the rest of it is what a customer does to clean up after any link
        // whose url she has lost: turn it off by account, make a new one.
        const customer = await makeUser();
        expect((await strangerMints(customer._id)).statusCode).toBe(401);

        // Suppose one had been minted for her anyway, and she has no url.
        const stolen = await tokenFor(customer._id);

        expect((await revokeAsOwner(customer._id)).statusCode).toBe(200);
        const fresh = await mintLink(customer._id);

        expect(fresh.body.token).toBeTruthy();
        expect(fresh.body.token).not.toBe(stolen);
        // The stolen one is not merely switched off, it is not a link at all
        // any more — the fresh mint replaced the record it hung on.
        const dead = await get(stolen);
        expect(dead.statusCode).toBe(404);
        expect(dead.body.code).toBe('INVALID');
        expect((await get(fresh.body.token)).statusCode).toBe(200);
    });

    test('somebody else’s sign-in turns nothing off', async () => {
        const randi = await makeUser();
        const stranger = await makeUser();
        const hers = await tokenFor(randi._id);

        const res = await request(app)
            .post('/api/share/link/revoke')
            .set('Authorization', await asCustomer(stranger._id))
            .send({ userId: String(randi._id) });

        expect(res.statusCode).toBe(401);
        expect((await get(hers)).statusCode).toBe(200);
    });

    test('and neither is somebody else’s token', async () => {
        const randi = await makeUser();
        const stranger = await makeUser();
        const hers = await tokenFor(randi._id);
        const theirs = await tokenFor(stranger._id);

        expect((await revokeLink(theirs)).statusCode).toBe(200);
        expect((await revokeLink('not-a-real-token')).statusCode).toBe(404);

        expect((await get(hers)).statusCode).toBe(200);
    });

    test('the revoke-then-mint oracle stays shut', async () => {
        // The whole attack in three requests: read an id off the pending feed,
        // kill the link, ask for a new one, receive a working token for a
        // stranger's account. Both of the last two steps now fail on their
        // own, and the link is still live at the end of it.
        const customer = await makeUser();
        const token = await tokenFor(customer._id);

        const killed = await request(app)
            .post('/api/share/link/revoke')
            .send({ userId: String(customer._id) });
        const minted = await strangerMints(customer._id);

        expect(killed.statusCode).toBe(401);
        expect(minted.statusCode).toBe(401);
        expect(minted.body.token).toBeUndefined();
        expect((await get(token)).statusCode).toBe(200);
    });

    test('the holder can still turn it off, and doing it twice is fine', async () => {
        const customer = await makeUser();
        const token = await tokenFor(customer._id);

        expect((await revokeLink(token)).statusCode).toBe(200);
        expect((await revokeLink(token)).statusCode).toBe(200);

        const res = await get(token);
        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('REVOKED');
    });
});

describe('a link that should not answer', () => {
    test('a token nobody ever minted', async () => {
        const res = await get('not-a-real-token');
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ success: false, code: 'INVALID' });
    });

    test('one the customer revoked', async () => {
        const customer = await makeUser();
        const token = await tokenFor(customer._id);

        expect((await revokeLink(token)).statusCode).toBe(200);

        const res = await get(token);
        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('REVOKED');
    });
});

describe('the link is the customer’s, not one job’s', () => {
    test('between jobs it names the next sweep instead of going blank', async () => {
        const customer = await makeUser(false, {
            cleaningSchedule: {
                address: { streetAddress: '296 12th St', lat: CURB.lat, lng: CURB.lng },
                days: [{ weekday: 4, hour: 8, minute: 30 }],
                status: 'active',
            },
        });
        const token = await tokenFor(customer._id);

        const res = await get(token);

        expect(res.statusCode).toBe(200);
        expect(res.body.handoff.stage).toBe('idle');
        expect(res.body.handoff.needsEntry).toBe(false);
        expect(res.body.handoff.codeToSay).toBeNull();
        expect(res.body.handoff.schedule.streetAddress).toBe('296 12th St');

        const next = new Date(res.body.handoff.schedule.nextAt);
        expect(next.getTime()).toBeGreaterThan(Date.now());
        expect(
            new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/New_York',
                weekday: 'short',
                hour: 'numeric',
                minute: '2-digit',
            }).format(next)
        ).toBe('Thu 8:30 AM');
    });

    test('a schedule paused with no end date has no next move to name', async () => {
        const customer = await makeUser(false, {
            cleaningSchedule: {
                address: { streetAddress: '296 12th St' },
                days: [{ weekday: 4, hour: 8, minute: 30 }],
                status: 'paused',
                pausedUntil: null,
            },
        });

        const res = await get(await tokenFor(customer._id));

        expect(res.body.handoff.schedule.nextAt).toBeNull();
        expect(res.body.handoff.schedule.streetAddress).toBe('296 12th St');
    });

    test('a pause with an end date pushes the next move past it', async () => {
        const inThreeWeeks = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);
        const customer = await makeUser(false, {
            cleaningSchedule: {
                address: { streetAddress: '296 12th St' },
                days: [{ weekday: 4, hour: 8, minute: 30 }],
                status: 'paused',
                pausedUntil: inThreeWeeks,
            },
        });

        const res = await get(await tokenFor(customer._id));

        expect(new Date(res.body.handoff.schedule.nextAt).getTime()).toBeGreaterThanOrEqual(
            inThreeWeeks.getTime()
        );
    });

    test('a customer with no schedule is told nothing rather than guessed at', async () => {
        const customer = await makeUser();

        const res = await get(await tokenFor(customer._id));

        expect(res.body.handoff.stage).toBe('idle');
        expect(res.body.handoff.schedule).toBeNull();
    });

    test('the same url carries this week’s job and next week’s', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const token = await tokenFor(customer._id);

        const thisWeek = await makeTypeItOrder(customer._id, valet._id, '481902');
        expect((await get(token)).body.handoff.stage).toBe('type_code');

        await Order.findByIdAndUpdate(thisWeek._id, { status: 'completed' });
        expect((await get(token)).body.handoff.stage).toBe('idle');

        await makeTypeItOrder(customer._id, valet._id, '556677');
        expect((await get(token)).body.handoff.stage).toBe('type_code');
    });
});

describe('when a code may be revealed', () => {
    test('a booking nobody has accepted opens nothing, code or no code', async () => {
        const customer = await makeUser();
        const order = await makeOrder(customer._id, {
            status: 'pending',
            otp: liveOtp('112233', 'order_creation'),
        });

        expect((await handoffWindow(order)).beat).toBeNull();
    });

    test('a valet on the job opens the type beat, and it never carries the number', async () => {
        // The busy-morning case, and the one the old proximity gate got wrong:
        // this order has NO valetLocation at all, because the valet's phone is
        // reporting against the other job he is carrying. The doorman still
        // gets a keypad — the number is the valet's to read aloud, so an empty
        // box gives away nothing.
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeTypeItOrder(customer._id, valet._id, '481902');

        expect(order.valetLocation?.lat).toBeUndefined();
        expect(await handoffWindow(order)).toEqual({
            beat: 'type',
            code: null,
            reason: 'valet_on_the_job',
        });
    });

    test('a valet four blocks off opens it too — arriving is his business, not a lock', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeTypeItOrder(customer._id, valet._id, '481902', {
            valetLocation: FOUR_BLOCKS_OFF,
        });

        expect((await handoffWindow(order)).beat).toBe('type');
    });

    test('a parked car with the keys coming back opens the say beat', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeSayItOrder(customer._id, valet._id, '773311');

        const window = await handoffWindow(order);
        expect(window.beat).toBe('say');
        expect(window.code).toBe('773311');
    });

    test('a park the valet has closed out is over, whatever code is staged on it', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeSayItOrder(customer._id, valet._id, '773311', {
            parkClosedAt: new Date(),
        });

        expect(await handoffWindow(order)).toEqual({
            beat: null,
            code: null,
            reason: 'park_closed_out',
        });
    });

    test('Randi’s morning: on a sweep the valet keeps the keys, so nothing is spoken while the car sits', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeSayItOrder(customer._id, valet._id, '773311', {
            aspMode: true,
        });

        expect(await handoffWindow(order)).toEqual({
            beat: null,
            code: null,
            reason: 'valet_keeps_the_keys_through_the_sweep',
        });
    });

    test('a retrieval before the valet has the keys is a type beat', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeOrder(customer._id, {
            orderType: 'retrieval',
            valet: valet._id,
            acceptedAt: new Date(),
            otp: liveOtp('334455', 'return_key'),
        });

        expect((await handoffWindow(order)).beat).toBe('type');
    });

    test('a retrieval nobody has taken opens nothing, even carrying a return code', async () => {
        const customer = await makeUser();
        const order = await makeOrder(customer._id, {
            orderType: 'retrieval',
            status: 'pending',
            otp: liveOtp('334455', 'return_key'),
        });

        expect(await handoffWindow(order)).toEqual({
            beat: null,
            code: null,
            reason: 'nobody_has_taken_this_job',
        });
    });

    test('a retrieval opens the say beat the moment custody is recorded, wherever the valet is', async () => {
        // Custody — beat 1 verified — is the write that MINTS this code, and
        // it is the same fact the customer's own phone shows her. No fix on
        // the valet here either.
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeOrder(customer._id, {
            orderType: 'retrieval',
            valet: valet._id,
            acceptedAt: new Date(),
            otpVerifiedTimes: { returnKey: new Date() },
            otp: liveOtp('998877', 'return_key'),
        });

        const window = await handoffWindow(order);
        expect(window.beat).toBe('say');
        expect(window.code).toBe('998877');
    });

    test('a legacy sweep return leg gets no keypad — the valet has held the keys since 8am', async () => {
        // The 2026-08-31 production failure. This leg predates `aspMode` being
        // stamped on legs, so every cheap test reads it as an untouched
        // retrieval and offers the doorman a box to type into. Only
        // `retrievalHasCustody`, which follows the link back to the parent,
        // knows better.
        const customer = await makeUser();
        const valet = await makeUser(true);
        const parent = await makeOrder(customer._id, {
            valet: valet._id,
            status: 'parked',
            aspMode: true,
            aspOrderCreated: true,
            conversationId: 'conv-legacy',
        });
        const leg = await makeOrder(customer._id, {
            orderType: 'retrieval',
            valet: valet._id,
            acceptedAt: new Date(),
            linkedOrderId: parent._id,
            conversationId: 'conv-legacy',
            otp: liveOtp('665544', 'return_key'),
        });
        await Order.findByIdAndUpdate(parent._id, { linkedOrderId: leg._id });

        const window = await handoffWindow(await Order.findById(leg._id));
        expect(window.beat).toBe('say');
        expect(window.code).toBe('665544');
    });

    test('a sweep leg the valet stood down shows nobody a number', async () => {
        // `valetCancelOrder` puts a leg back on the board by clearing
        // `order.valet` and setting it pending. `aspMode` survives that, and
        // `retrievalHasCustody` reads `aspMode` as custody — it has to, a sweep
        // leg is born with the keys already handed over — so the say beat
        // opened on a flag with nobody on the job. The doorman was reading six
        // digits out to an empty lobby while his messages reached no one.
        const customer = await makeUser();
        const valet = await makeUser(true);
        const park = await makeOrder(customer._id, {
            valet: valet._id,
            status: 'parked',
            aspMode: true,
            aspOrderCreated: true,
            parkClosedAt: new Date(),
            conversationId: 'conv-stood-down',
        });
        const leg = await makeOrder(customer._id, {
            orderType: 'retrieval',
            status: 'pending',
            aspMode: true,
            linkedOrderId: park._id,
            conversationId: 'conv-stood-down',
            otp: liveOtp('884422', 'return_key'),
        });
        await Order.findByIdAndUpdate(park._id, { linkedOrderId: leg._id });
        const token = await tokenFor(customer._id);

        expect(await handoffWindow(await Order.findById(leg._id))).toEqual({
            beat: null,
            code: null,
            reason: 'nobody_has_taken_this_job',
        });

        const res = await get(token);
        expect(res.body.handoff.stage).toBe('waiting');
        expect(res.body.handoff.codeToSay).toBeNull();
        expect(JSON.stringify(res.body)).not.toContain('884422');
    });

    test('and it opens again the moment a valet picks the leg back up', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const park = await makeOrder(customer._id, {
            valet: valet._id,
            status: 'parked',
            aspMode: true,
            aspOrderCreated: true,
            parkClosedAt: new Date(),
            conversationId: 'conv-picked-up',
        });
        const leg = await makeOrder(customer._id, {
            orderType: 'retrieval',
            valet: valet._id,
            acceptedAt: new Date(),
            aspMode: true,
            linkedOrderId: park._id,
            conversationId: 'conv-picked-up',
            otp: liveOtp('884422', 'return_key'),
        });
        await Order.findByIdAndUpdate(park._id, { linkedOrderId: leg._id });

        const window = await handoffWindow(await Order.findById(leg._id));
        expect(window.beat).toBe('say');
        expect(window.code).toBe('884422');
    });
});

describe('the keypad waits for the valet to actually arrive', () => {
    // With the GPS gate gone, `stage` flipped to type_code the instant somebody
    // accepted — twenty minutes and a subway ride before there was anyone to
    // read a number out — so the doorman got a keypad early and the "Marco is
    // on his way" screen never rendered at all.
    //
    // The signal is the valet's own app posting the code into the thread as he
    // says it. Unforgeable by a stranger with an order id, unlike the location
    // write that used to gate this, because writing it needs the conversation.

    const makeArrivalOrder = async (conversationId, code = '481902') => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeTypeItOrder(customer._id, valet._id, code, { conversationId });
        return { customer, token: await tokenFor(customer._id) };
    };

    test('before he reads it out, the screen says he is on his way', async () => {
        const { token } = await makeArrivalOrder('conv-walking');

        const { handoff } = (await get(token)).body;

        expect(handoff.stage).toBe('valet_on_way');
        expect(handoff.needsEntry).toBe(false);
        expect(handoff.codeToSay).toBeNull();
    });

    test('and the moment he does, the box is there', async () => {
        const { token } = await makeArrivalOrder('conv-at-the-door');
        valetReadsCodeAloud('conv-at-the-door', '481902');

        const { handoff } = (await get(token)).body;

        expect(handoff.stage).toBe('type_code');
        expect(handoff.needsEntry).toBe(true);
        // Still not the number. Nothing about arriving changes whose it is.
        expect(handoff.codeToSay).toBeNull();
    });

    test('the morning’s announcement does not open the evening’s beat', async () => {
        // One ASP conversation carries both legs, so the thread still holds the
        // 8am message when the evening job wants a keypad of its own. The code
        // is what tells them apart — a timestamp filter beside the tag would
        // need a Firestore composite index on a path this page polls.
        const { token } = await makeArrivalOrder('conv-both-legs', '556677');
        valetReadsCodeAloud('conv-both-legs', '481902');

        expect((await get(token)).body.handoff.stage).toBe('valet_on_way');
    });

    test('once it has opened it stays open, without asking again', async () => {
        const { token } = await makeArrivalOrder('conv-sticky');
        valetReadsCodeAloud('conv-sticky', '481902');
        expect((await get(token)).body.handoff.stage).toBe('type_code');

        // The thread going away — a read that fails, a message deleted — must
        // not take the keypad off a doorman mid-handoff. And nothing is read at
        // all now: the answer is remembered rather than polled for.
        mockThread['conv-sticky'] = [];
        mockFirestoreThrows = true;

        expect((await get(token)).body.handoff.stage).toBe('type_code');
    });

    test('a thread that cannot be read shows the keypad anyway', async () => {
        // Fails open on purpose. Nothing secret is on that screen — the number
        // is the valet's, spoken out loud, and an empty box gives nothing away
        // — so a doorman who cannot type costs more than one who types early.
        const { token } = await makeArrivalOrder('conv-firestore-down');
        mockFirestoreThrows = true;

        const { handoff } = (await get(token)).body;

        expect(handoff.stage).toBe('type_code');
        expect(handoff.needsEntry).toBe(true);
    });

    test('a job with no thread yet is not held back by this', async () => {
        // `acceptOrder` mints the conversation, so a document without one has
        // nowhere to look. That is the fail-open case too, not a locked screen.
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeTypeItOrder(customer._id, valet._id, '481902');
        const token = await tokenFor(customer._id);

        expect((await get(token)).body.handoff.stage).toBe('type_code');
    });

    test('and typing is still accepted, whatever this check thinks', async () => {
        // The arrival signal decides what the screen DRAWS. It must never be
        // able to refuse a correct code — a doorman whose keypad is already up
        // has to be able to spend it even if the thread has gone dark since.
        const { token } = await makeArrivalOrder('conv-verify-anyway');
        mockFirestoreThrows = true;

        expect((await guess(token, '481902')).statusCode).toBe(200);
    });
});

describe('what the doorman sees', () => {
    test('on the beat where he types, there is no code on the screen', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeTypeItOrder(customer._id, valet._id, '481902');
        const token = await tokenFor(customer._id);

        const res = await get(token);

        expect(res.statusCode).toBe(200);
        expect(res.body.handoff.needsEntry).toBe(true);
        expect(res.body.handoff.codeToSay).toBeNull();
        expect(res.body.handoff.stage).toBe('type_code');
        // The one that matters: the valet's number must not be anywhere in the
        // response, not under any key.
        expect(JSON.stringify(res.body)).not.toContain('481902');
    });

    test('on the beat where he speaks, the code is right there', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeSayItOrder(customer._id, valet._id, '773311');
        const token = await tokenFor(customer._id);

        const res = await get(token);

        expect(res.body.handoff.needsEntry).toBe(false);
        expect(res.body.handoff.codeToSay).toBe('773311');
        expect(res.body.handoff.stage).toBe('say_code');
    });

    test('"waiting for a valet" and a keypad are never on screen together', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const token = await tokenFor(customer._id);

        // Every shape the screen can take, walked in order.
        const order = await makeOrder(customer._id, {
            status: 'pending',
            otp: liveOtp('112233', 'order_creation'),
        });
        for (const patch of [
            {},
            { valet: valet._id, acceptedAt: new Date(), status: 'accepted' },
            { valetLocation: FOUR_BLOCKS_OFF },
            { 'otpVerifiedTimes.orderCreation': new Date(), 'otp.verified': true },
        ]) {
            await Order.findByIdAndUpdate(order._id, patch);
            const { handoff } = (await get(token)).body;
            if (handoff.needsEntry) expect(handoff.stage).toBe('type_code');
            if (handoff.stage === 'waiting') expect(handoff.needsEntry).toBe(false);
        }
    });

    test('once the keys have changed hands, it stops counting down an arrival that already happened', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeOrder(customer._id, {
            valet: valet._id,
            acceptedAt: new Date(),
            valetLocation: FOUR_BLOCKS_OFF,
            otpVerifiedTimes: { orderCreation: new Date() },
            otp: { ...liveOtp('556677', 'order_creation'), verified: true },
        });
        const token = await tokenFor(customer._id);

        const { handoff } = (await get(token)).body;

        expect(handoff.stage).toBe('keys_handed');
        expect(handoff.valet.etaMinutes).toBeNull();
    });

    test('the keypad is up while he is still walking, and says how far off he is', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeOrder(customer._id, {
            valet: valet._id,
            acceptedAt: new Date(),
            valetLocation: FOUR_BLOCKS_OFF,
            otp: liveOtp('556677', 'order_creation'),
        });
        const token = await tokenFor(customer._id);

        const { handoff } = (await get(token)).body;

        expect(handoff.stage).toBe('type_code');
        expect(handoff.needsEntry).toBe(true);
        expect(handoff.valet.etaMinutes).toBeGreaterThan(0);
        expect(handoff.valet.etaMinutes).toBeLessThan(15);
    });

    test('and with no fix on him there is simply no ETA, not a blank screen', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeTypeItOrder(customer._id, valet._id, '556677');
        const token = await tokenFor(customer._id);

        const { handoff } = (await get(token)).body;

        expect(handoff.stage).toBe('type_code');
        expect(handoff.needsEntry).toBe(true);
        expect(handoff.valet.etaMinutes).toBeNull();
    });

    test('an enterprise park closed out into a live retrieval is not "finished"', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const park = await makeOrder(customer._id, {
            valet: valet._id,
            status: 'completed',
            endCustomerName: 'Suite 4B',
        });
        await makeOrder(customer._id, {
            orderType: 'retrieval',
            valet: valet._id,
            acceptedAt: new Date(),
            linkedOrderId: park._id,
            otp: liveOtp('221100', 'return_key'),
        });
        const token = await tokenFor(customer._id);

        const res = await get(token);

        expect(res.statusCode).toBe(200);
        expect(res.body.handoff.stage).not.toBe('done');
        expect(res.body.handoff.orderType).toBe('retrieval');
    });

    test('Randi’s evening: the sweep’s return leg still knows which car it is', async () => {
        // The leg the sweep mints carries no vehicle and no spot of its own —
        // both live on the park it came from. A doorman shown a blank car
        // cannot tell the valet he is the right one.
        const customer = await makeUser();
        const valet = await makeUser(true);
        const park = await makeOrder(customer._id, {
            valet: valet._id,
            status: 'parked',
            parkedAt: new Date(),
            parkingLocation: { lat: 40.6801, lng: -73.9912, streetAddress: '310 12th St' },
            aspMode: true,
            aspOrderCreated: true,
            conversationId: 'conv-sweep',
        });
        const leg = await Order.create({
            customer: customer._id,
            valet: valet._id,
            acceptedAt: new Date(),
            customerLocation: CURB,
            parkingType: 'retrieval',
            orderType: 'retrieval',
            serviceType: 'park-and-hold',
            duration: 30,
            pickUpTime: new Date(),
            status: 'accepted',
            totalAmount: 0,
            paymentMethod: 'card',
            paymentStatus: 'paid',
            aspMode: true,
            linkedOrderId: park._id,
            conversationId: 'conv-sweep',
            otp: liveOtp('884422', 'return_key'),
        });
        await Order.findByIdAndUpdate(park._id, { linkedOrderId: leg._id });
        const token = await tokenFor(customer._id);

        const { handoff } = (await get(token)).body;

        expect(handoff.stage).toBe('say_code');
        expect(handoff.codeToSay).toBe('884422');
        expect(handoff.vehicle.licensePlate).toBe('ABC1234');
        expect(handoff.parkingAddress).toBe('310 12th St');
    });

    test('a car and two first names, and nothing else about anybody', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeTypeItOrder(customer._id, valet._id);
        const token = await tokenFor(customer._id);

        const res = await get(token);
        const { handoff } = res.body;

        expect(handoff.customerFirstName).toBe('Randi');
        expect(handoff.valet.firstName).toBe('Marco');
        expect(handoff.vehicle).toEqual({
            make: null,
            model: 'Honda Civic',
            color: 'Grey',
            licensePlate: 'ABC1234',
        });

        // The contract names these fields and no others.
        expect(Object.keys(handoff).sort()).toEqual([
            'aspMode',
            'codeToSay',
            'customerFirstName',
            'needsEntry',
            'orderType',
            'parkingAddress',
            'schedule',
            'serviceType',
            'stage',
            'status',
            'valet',
            'vehicle',
        ]);

        const serialised = JSON.stringify(res.body);
        expect(serialised).not.toContain(customer.phone);
        expect(serialised).not.toContain(valet.phone);
        // Where she lives. `parkingAddress` is the only address this link ever
        // carries, and on this beat the car isn't parked yet.
        expect(serialised).not.toContain(CURB.streetAddress);
        expect(serialised).not.toContain(String(order._id));
        expect(serialised).not.toContain(String(customer._id));
        expect(serialised).not.toContain(String(valet._id));
    });
});

describe('the burst limiter itself', () => {
    // The rolling window is the only thing standing between a doorman and a
    // lockout on a handoff he is getting RIGHT, so what it charges for is not
    // an implementation detail.
    const metered = express();
    metered.use(
        '/thing',
        require('../middleware/rateLimit')({
            windowMs: 60 * 1000,
            max: 2,
            keyFrom: () => 'one-key',
            countWhen: (res) => res.statusCode >= 400,
        }),
        (req, res) => res.status(req.query.ok ? 200 : 400).json({ ok: !!req.query.ok })
    );

    test('a good answer is free, a bad one is not', async () => {
        for (let i = 0; i < 5; i += 1) {
            expect((await request(metered).get('/thing?ok=1')).statusCode).toBe(200);
        }

        expect((await request(metered).get('/thing')).statusCode).toBe(400);
        expect((await request(metered).get('/thing')).statusCode).toBe(400);
        expect((await request(metered).get('/thing')).statusCode).toBe(429);

        // And the lockout covers the good answers too, once it is on.
        expect((await request(metered).get('/thing?ok=1')).statusCode).toBe(429);
    });
});

describe('typing the code in', () => {
    test('closes the handoff exactly as the app would have', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeTypeItOrder(customer._id, valet._id, '481902');
        const token = await tokenFor(customer._id);

        const res = await guess(token, '481902');

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);

        const after = await Order.findById(order._id);
        expect(after.otp.verified).toBe(true);
        expect(after.otpVerifiedTimes.orderCreation).toBeTruthy();
    });

    test('getting it right first time costs nothing', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeTypeItOrder(customer._id, valet._id, '481902');
        const token = await tokenFor(customer._id);

        await guess(token, '481902');

        const after = await Order.findById(order._id);
        expect(after.shareVerifyAttempts?.typeBeat || 0).toBe(0);
    });

    test('is refused on the beat where the code is his to say', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeSayItOrder(customer._id, valet._id, '773311');
        const token = await tokenFor(customer._id);

        // The valet types this one, standing at the car. A link that could
        // verify it on its own would close a key return with nobody there.
        const res = await guess(token, '773311');

        expect(res.statusCode).toBe(400);
        expect(await Order.findById(order._id).then((o) => o.otp.verified)).toBe(false);
    });

    test('is refused once the window has shut, whatever the page is still showing', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeTypeItOrder(customer._id, valet._id, '481902');
        const token = await tokenFor(customer._id);

        expect((await get(token)).body.handoff.needsEntry).toBe(true);

        // The handoff finished some other way — the customer did it in the app.
        // The keypad is still on the doorman's screen, left open in a pocket;
        // the server re-derives the window and has to refuse it anyway.
        await Order.findByIdAndUpdate(order._id, { 'otp.verified': true });

        const res = await guess(token, '481902');
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe('There is no code to enter right now');
    });

    test('a tap when no window is open is not a guess, and never costs a try', async () => {
        // Five taps at a moment with nothing to type — a page left open from
        // the last job, a doorman poking at it early — used to lock him out
        // for ten minutes without a single number ever having been graded.
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeSayItOrder(customer._id, valet._id, '773311');
        const token = await tokenFor(customer._id);

        for (let i = 0; i < 8; i += 1) {
            const res = await guess(token, '000000');
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toBe('There is no code to enter right now');
        }

        // Nothing was spent, on either counter.
        expect(
            await Order.findById(order._id).then((o) => o.shareVerifyAttempts?.typeBeat || 0)
        ).toBe(0);

        // And when the valet does turn up, the doorman still has his tries.
        await Order.findByIdAndUpdate(order._id, {
            'otp.type': 'order_creation',
            'otp.code': '481902',
        });
        expect((await guess(token, '481902')).statusCode).toBe(200);
    });

    test('a leaked link gets five guesses in ten minutes, then has to wait', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeTypeItOrder(customer._id, valet._id, '481902');
        const token = await tokenFor(customer._id);

        for (let i = 0; i < 5; i += 1) {
            expect((await guess(token, '000000')).statusCode).toBe(400);
        }

        const sixth = await guess(token, '000000');
        expect(sixth.statusCode).toBe(429);
        expect(sixth.headers['retry-after']).toBeTruthy();
        expect(await Order.findById(order._id).then((o) => o.otp.verified)).toBe(false);
    });

    test('and ten wrong answers in total end it — patience does not buy a sixth digit', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeTypeItOrder(customer._id, valet._id, '481902');
        const token = await tokenFor(customer._id);

        // Nine already spent over however many nights the attacker wanted.
        await Order.findByIdAndUpdate(order._id, {
            'shareVerifyAttempts.typeBeat': 9,
        });

        expect((await guess(token, '000000')).statusCode).toBe(400);
        expect(
            await Order.findById(order._id).then((o) => o.shareVerifyAttempts.typeBeat)
        ).toBe(10);

        const locked = await guess(token, '000000');
        expect(locked.statusCode).toBe(429);
        expect(locked.body.locked).toBe(true);
        // No promise that it reopens, because it doesn't.
        expect(locked.headers['retry-after']).toBeUndefined();

        // Not even the right code gets in after that.
        const correct = await guess(token, '481902');
        expect(correct.statusCode).toBe(429);
        expect(await Order.findById(order._id).then((o) => o.otp.verified)).toBe(false);
    });
});
