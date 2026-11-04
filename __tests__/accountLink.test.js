/**
 * Link account — two customers sharing their parks and a plan.
 * Run: npx jest accountLink
 *
 * A customer asked "How can Peter and I share an account?" The answer is a
 * pair: both keep their own login, card and history, each sees the other's
 * parks, and a plan held by either covers both, one park at a time. What is
 * being pinned down here, in the order it would hurt to get wrong:
 *
 *  1. The handshake makes exactly one link. Whoever SHOWED the code taps
 *     Authorize; nothing else turns a scan into a link, and no account can end
 *     up in two links, not even two Authorize taps landing in the same second.
 *
 *  2. One plan, one car at a time. The partner's parks are covered by the
 *     holder's plan and stamped with its id, so the free park a day and the
 *     weekly moves are shared. While some other car is riding the plan, a new
 *     park is an ordinary paid one — list price AND an end time, because a
 *     park held "until you ask for it back" is a second car on the plan with
 *     a price on it.
 *
 *  3. Money follows the park. A partner acting on the other one's park acts
 *     for the booker: the order, the card and the refund stay the booker's,
 *     and `actedBy` records who tapped.
 *
 *  4. Nothing about the other person leaves the server but the partner
 *     summary: first and last name, photo, last four digits of the phone. Not
 *     their full number, their Firebase uid, their Stripe customer, their
 *     plan's billing, or the car on their profile.
 *
 * The fifteen cases in the brief's "Tests to write" are the first describe,
 * one `it` each and worded after them. The contract's additions follow.
 *
 * The link routes are driven through the real router, so every call here also
 * passes requireSelf and the rate limiter the way a phone's does. The order and
 * plan paths are called on their controllers directly, the way
 * cancelRetrieval.test.js calls them.
 */

// The in-memory Mongo's first writes in a suite this size can run past Jest's
// 5 s default on a cold machine, and a timeout reads exactly like a hang in
// the code under test.
jest.setTimeout(30000);

// `uid:<firebaseUid>` stands in for a real Firebase ID token, as in
// requireSelfGates.test.js. The rest is there because the controllers behind
// these routes reach for messaging and firestore on their happy paths.
jest.mock('firebase-admin', () => ({
    auth: () => ({
        verifyIdToken: async (token) => {
            const m = /^uid:(.+)$/.exec(String(token));
            if (!m) throw new Error('Decoding Firebase ID token failed');
            return { uid: m[1] };
        },
    }),
    messaging: () => ({
        send: async () => 'mock',
        sendEachForMulticast: async () => ({ responses: [], successCount: 0, failureCount: 0 }),
    }),
    firestore: () => ({
        collection: () => ({
            doc: () => ({
                get: async () => ({ exists: false, data: () => null }),
                set: async () => {},
                update: async () => {},
                collection: () => ({ add: async () => {}, get: async () => ({ docs: [] }) }),
            }),
            add: async () => {},
            where: () => ({ get: async () => ({ docs: [], empty: true }) }),
        }),
    }),
    apps: [{}],
    initializeApp: () => {},
    credential: { cert: () => ({}), applicationDefault: () => ({}) },
    storage: () => ({ bucket: () => ({ file: () => ({}) }) }),
}));

// No Stripe key, as in coveredParkPricing.test.js: with `stripe` null any path
// that reaches Stripe fails loudly, so an answer that comes back is proof it
// was decided before any card was touched.
process.env.NODE_ENV = 'test';
delete process.env.STRIPE_API_KEY;

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const User = require('../models/User');
const Order = require('../models/Order');
const Subscription = require('../models/Subscription');
const AccountLink = require('../models/AccountLink');
const CurbCustody = require('../models/CurbCustody');
const accountLinkRouter = require('../routes/accountLink');
const subscriptionRouter = require('../routes/subscription');
const authController = require('../controllers/authController');
const orderController = require('../controllers/orderController');
const quoteController = require('../controllers/quoteController');
const subscriptionController = require('../controllers/subscriptionController');
const notificationController = require('../controllers/notificationController');
const accountLinkController = require('../controllers/accountLinkController');
const subscriptionService = require('../services/subscriptionService');
const curbCustody = require('../services/curbCustody');
const accountLinks = require('../services/accountLinks');
const { requireOrderOwner } = require('../middleware/requireSelf');

let mongo;

/* -------------------------------------------------------------------------- */
/* doubles                                                                    */
/* -------------------------------------------------------------------------- */

/** Minimal express-ish double: captures status + json body. */
const mockRes = () => {
    const res = {};
    res.statusCode = 200;
    res.body = null;
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

/** Socket double that records every emit so we can assert on the wiring. */
const mockIo = () => {
    const emits = [];
    const io = {
        emits,
        emit: (event, payload) => emits.push({ room: null, event, payload }),
        to: (room) => ({
            emit: (event, payload) => emits.push({ room: String(room), event, payload }),
        }),
    };
    return io;
};

// One socket double per test, read at request time, so every emit the link
// routes make during a case lands in `io.emits`.
let io = mockIo();

const app = express();
app.use(express.json());
app.use((req, res, next) => {
    req.io = io;
    next();
});
app.use('/api/account-link', accountLinkRouter);
app.use('/api/subscription', subscriptionRouter);

// Pushes are called through the module (accountLinkController says so), so a
// spy here sees every one without anything reaching FCM.
let pushes;

/* -------------------------------------------------------------------------- */
/* people, plans, orders                                                      */
/* -------------------------------------------------------------------------- */

// `phone` is unique-indexed and `verified` is required on User.
let phoneSeq = 6465551000;
const makeUser = (extra = {}) => {
    const n = ++phoneSeq;
    return User.create({
        firstName: 'Randi',
        lastName: 'Tester',
        phone: `+1${n}`,
        firebaseUid: `uid_${n}`,
        verified: true,
        ...extra,
    });
};

/** The Authorization header a signed-in client sends. */
const as = (user) => ['Authorization', `Bearer uid:${user.firebaseUid}`];

/** The five fields of a partner summary, and nothing else, ever. */
const SUMMARY_KEYS = ['_id', 'firstName', 'lastName', 'phoneMasked', 'profileImage'];

const HOME = { lat: 40.679, lng: -73.995, streetAddress: '123 Court St, Brooklyn' };
const DAY = 24 * 60 * 60 * 1000;

let planSeq = 0;
const makePlan = (user, extra = {}) => {
    const n = ++planSeq;
    return Subscription.create({
        user: user._id,
        tier: 'home_garage',
        interval: 'month',
        status: 'active',
        amountCents: 25000,
        stripeCustomerId: `cus_plan${n}`,
        stripeSubscriptionId: `sub_plan${n}`,
        currentPeriodEnd: new Date(Date.now() + 30 * DAY),
        homeAddress: HOME,
        ...extra,
    });
};
const streetCleaning = { tier: 'street_cleaning', amountCents: 10000, movesPerWeek: 2 };
const aspMove = { aspMode: true, serviceType: 'park-and-hold' };

// A park as the database holds it, for the read paths and the ownership
// gates — they read what is there, not how it was booked.
const makeOrder = (customer, extra = {}) =>
    Order.create({
        customer: customer._id,
        customerLocation: HOME,
        parkingType: 'street',
        orderType: 'parking',
        serviceType: 'standard',
        duration: 120,
        pickUpTime: new Date(),
        status: 'parked',
        totalAmount: 1500,
        paymentMethod: 'card',
        paymentStatus: 'paid',
        ...extra,
    });

/* -------------------------------------------------------------------------- */
/* the link routes, as a phone calls them                                     */
/* -------------------------------------------------------------------------- */

const post = (path, user, body = {}) =>
    request(app)
        .post(`/api/account-link${path}`)
        .set(...as(user))
        .send({ userId: String(user._id), ...body });

const api = {
    request: (u, phone) => post('/request', u, { phone }),
    authorize: (u, linkId) => post('/authorize', u, { linkId: String(linkId) }),
    decline: (u, linkId) => post('/decline', u, { linkId: String(linkId) }),
    unlink: (u) => post('/unlink', u),
    status: (u) =>
        request(app)
            .get('/api/account-link/status')
            .query({ userId: String(u._id) })
            .set(...as(u)),
};

/** `requester` types `approver`'s number and sends it; `approver` taps Accept. */
const linkByPhone = async (approver, requester) => {
    const sent = await api.request(requester, approver.phone);
    expect(sent.statusCode).toBe(200);
    const approved = await api.authorize(approver, sent.body.link._id);
    expect(approved.statusCode).toBe(200);
    return approved.body;
};

/** Everything the link routes emitted to one room, for one event. */
const emitsTo = (user, event) =>
    io.emits.filter((e) => e.room === String(user._id) && e.event === event);

/* -------------------------------------------------------------------------- */
/* booking, as the app books                                                  */
/* -------------------------------------------------------------------------- */

const quote = async (user, extra = {}) => {
    const res = mockRes();
    await quoteController.quoteOrder(
        {
            body: {
                userId: String(user._id),
                orderType: 'parking',
                serviceType: 'standard',
                duration: 120,
                lat: HOME.lat,
                lng: HOME.lng,
                ...extra,
            },
        },
        res
    );
    expect(res.statusCode).toBe(200);
    return res.body;
};

/** validateSubscriptionForOrder, which runs in front of createOrder. */
const validate = async (body) => {
    const req = { body };
    const res = mockRes();
    let passed = false;
    await orderController.validateSubscriptionForOrder(req, res, () => {
        passed = true;
    });
    return { req, res, passed };
};

/** POST /api/order/createOrder: the plan lookup, then the booking. */
const book = async (user, extra = {}) => {
    const { req, passed } = await validate({ customer: String(user._id) });
    expect(passed).toBe(true);
    req.body = {
        customer: String(user._id),
        customerLocation: HOME,
        parkingType: 'street',
        duration: 120,
        pickUpTime: new Date().toISOString(),
        orderType: 'parking',
        serviceType: 'standard',
        ...extra,
    };
    req.io = mockIo();
    const res = mockRes();
    await orderController.createOrder(req, res);
    return { req, res };
};

/** Run a middleware and say whether it called next(). */
const runMiddleware = async (mw, req) => {
    const res = mockRes();
    let passed = false;
    await mw(req, res, () => {
        passed = true;
    });
    return { res, passed };
};

/* -------------------------------------------------------------------------- */

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    // The partial unique indexes on AccountLink are what make "one active link
    // per account" true under a race. They have to exist before the race
    // cases run, not whenever autoIndex gets round to them.
    await AccountLink.syncIndexes();
    await User.init();
    await Order.init();
    await Subscription.init();
    await CurbCustody.init();
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
});

beforeEach(() => {
    io = mockIo();
    pushes = jest
        .spyOn(notificationController, 'sendPushNotification')
        .mockResolvedValue({ success: true });
});

afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all([
        AccountLink.deleteMany({}),
        Order.deleteMany({}),
        Subscription.deleteMany({}),
        CurbCustody.deleteMany({}),
        User.deleteMany({}),
    ]);
});

/* ========================================================================== */
/* The brief's fifteen                                                        */
/* ========================================================================== */

describe('the brief: tests to write', () => {
    it('request → accept yields one active link, and householdIds returns both ids for both', async () => {
        const alice = await makeUser({ firstName: 'Alice', lastName: 'Ames' });
        const peter = await makeUser({ firstName: 'Peter', lastName: 'Park' });

        // Peter types Alice's number.
        const sent = await api.request(peter, alice.phone);
        expect(sent.statusCode).toBe(200);
        expect(sent.body.success).toBe(true);
        expect(sent.body.link).toMatchObject({ status: 'pending', role: 'invitee' });
        expect(sent.body.link.expiresAt).toBeTruthy();
        // Back comes the number he typed, and nothing about whose it is.
        expect(sent.body.askedPhone).toBe(alice.phone);
        expect(JSON.stringify(sent.body)).not.toContain('Alice');

        // Alice hears about it, live and by push, with Peter's name and number.
        const requested = emitsTo(alice, 'accountLink:requested');
        expect(requested).toHaveLength(1);
        expect(requested[0].payload.from).toMatchObject({ firstName: 'Peter', phone: peter.phone });
        expect(requested[0].payload.link.role).toBe('inviter');
        expect(pushes).toHaveBeenCalledWith(
            alice.firebaseUid,
            'Link request',
            'Peter wants to link accounts. Open Profile → Link account to answer.',
            { type: 'accountLink', linkStatus: 'pending' }
        );

        // Alice decides; Peter waits on the number he typed.
        const aliceSees = await api.status(alice);
        expect(aliceSees.body).toMatchObject({ status: 'pending', askedPhone: null, waitingFor: null });
        expect(aliceSees.body.pendingFrom).toMatchObject({ firstName: 'Peter', lastName: 'Park', phone: peter.phone });
        const peterSees = await api.status(peter);
        expect(peterSees.body).toMatchObject({
            status: 'pending',
            askedPhone: alice.phone,
            pendingFrom: null,
            waitingFor: null,
            partner: null,
        });

        pushes.mockClear();
        const approved = await api.authorize(alice, sent.body.link._id);
        expect(approved.statusCode).toBe(200);
        expect(approved.body.link).toMatchObject({ status: 'active', role: 'inviter' });
        expect(approved.body.link.authorizedAt).toBeTruthy();
        expect(approved.body.partner.firstName).toBe('Peter');

        // Exactly one link, and it is active.
        const links = await AccountLink.find({}).lean();
        expect(links).toHaveLength(1);
        expect(links[0].status).toBe('active');
        expect(links[0].members.map(String).sort()).toEqual(
            [String(alice._id), String(peter._id)].sort()
        );
        expect(links[0].requestedPhone).toBe(alice.phone);

        // Own id first, then the partner's — from both sides.
        expect(await accountLinks.householdIds(alice._id)).toEqual([
            String(alice._id),
            String(peter._id),
        ]);
        expect(await accountLinks.householdIds(peter._id)).toEqual([
            String(peter._id),
            String(alice._id),
        ]);

        // Both rooms are told, each with the OTHER person as the partner.
        const toAlice = emitsTo(alice, 'accountLink:active');
        const toPeter = emitsTo(peter, 'accountLink:active');
        expect(toAlice).toHaveLength(1);
        expect(toPeter).toHaveLength(1);
        expect(toAlice[0].payload.partner.firstName).toBe('Peter');
        expect(toPeter[0].payload.partner.firstName).toBe('Alice');
        expect(toPeter[0].payload.link.role).toBe('invitee');

        expect(pushes).toHaveBeenCalledTimes(1);
        expect(pushes).toHaveBeenCalledWith(
            peter.firebaseUid,
            "You're linked",
            'Alice accepted. You both see the same parks now.',
            { type: 'accountLink', linkStatus: 'active' }
        );
    });
    it("a second request replaces the first; the first one's Accept is then NOT_PENDING", async () => {
        const alice = await makeUser({ firstName: 'Alice' });
        const carol = await makeUser({ firstName: 'Carol' });
        const peter = await makeUser({ firstName: 'Peter' });

        const first = await api.request(peter, alice.phone);
        const second = await api.request(peter, carol.phone);
        expect(second.statusCode).toBe(200);

        // One request out at a time: the first is retired, and Alice is told.
        const rows = await AccountLink.find({ invitee: peter._id }).sort({ _id: 1 }).lean();
        expect(rows.map((r) => r.status)).toEqual(['expired', 'pending']);
        expect(emitsTo(alice, 'accountLink:declined')).toHaveLength(1);

        const stale = await api.authorize(alice, first.body.link._id);
        expect(stale.statusCode).toBe(409);
        expect(stale.body.code).toBe('NOT_PENDING');
        expect((await api.status(alice)).body.status).toBe('none');

        const fresh = await api.authorize(carol, second.body.link._id);
        expect(fresh.statusCode).toBe(200);
    });
    it("own number → 400 SELF_LINK; not a number → 400 BAD_PHONE; a linked sender → 409; the sender learns nothing about the number", async () => {
        const alice = await makeUser({ firstName: 'Alice' });
        const carol = await makeUser({ firstName: 'Carol' });
        const dan = await makeUser({ firstName: 'Dan' });
        const val = await makeUser({ firstName: 'Val', isValet: true });

        // Her own number, however she types it.
        const d = alice.phone.replace(/\D/g, '').slice(-10);
        const self = await api.request(alice, `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`);
        expect(self.statusCode).toBe(400);
        expect(self.body).toMatchObject({ code: 'SELF_LINK', message: "That's your own number." });

        // Not a phone number.
        for (const bad of ['', '12345', 'call me', '+1']) {
            const r = await api.request(alice, bad);
            expect(r.statusCode).toBe(400);
            expect(r.body).toMatchObject({ code: 'BAD_PHONE', message: 'Enter their full phone number.' });
        }

        // A linked sender: pairs only.
        await linkByPhone(carol, dan);
        const linkedSender = await api.request(dan, alice.phone);
        expect(linkedSender.statusCode).toBe(409);
        expect(linkedSender.body).toMatchObject({
            code: 'ALREADY_LINKED',
            message: 'That account is already linked with someone.',
        });

        // Whatever is behind the number — someone already linked, a valet,
        // nobody at all — the sender gets the same answer.
        io = mockIo();
        pushes.mockClear();
        const shape = (r) => ({
            statusCode: r.statusCode,
            keys: Object.keys(r.body).sort(),
            link: { status: r.body.link.status, role: r.body.link.role },
        });
        const toLinked = await api.request(alice, carol.phone);
        const toValet = await api.request(alice, val.phone);
        const toNobody = await api.request(alice, '+12125550199');
        expect(shape(toLinked)).toEqual(shape(toNobody));
        expect(shape(toValet)).toEqual(shape(toNobody));
        expect(toNobody.body.askedPhone).toBe('+12125550199');

        // …and nobody behind those numbers was told anything: Carol is linked,
        // Val is a valet.
        expect(emitsTo(carol, 'accountLink:requested')).toHaveLength(0);
        expect(emitsTo(val, 'accountLink:requested')).toHaveLength(0);
        expect(pushes).not.toHaveBeenCalled();

        expect(await AccountLink.countDocuments({ status: 'active' })).toBe(1);
    });
    it('both hold a live plan → 409 BOTH_HAVE_PLANS at Accept, never at the request (that would tell a stranger the number has a plan)', async () => {
        const both = 'You both have a plan. One of you has to cancel theirs first.';

        const alice = await makeUser({ firstName: 'Alice' });
        const peter = await makeUser({ firstName: 'Peter' });
        await makePlan(alice);
        await makePlan(peter, streetCleaning);
        const sent = await api.request(peter, alice.phone);
        expect(sent.statusCode).toBe(200);
        const refused = await api.authorize(alice, sent.body.link._id);
        expect(refused.statusCode).toBe(409);
        expect(refused.body).toMatchObject({ code: 'BOTH_HAVE_PLANS', message: both });
        // Left waiting: one of them can cancel a plan and Accept again.
        expect((await AccountLink.findById(sent.body.link._id).lean()).status).toBe('pending');

        // Bought between the request and the tap.
        const carol = await makeUser({ firstName: 'Carol' });
        const dan = await makeUser({ firstName: 'Dan' });
        await makePlan(carol);
        const asked = await api.request(dan, carol.phone);
        expect(asked.statusCode).toBe(200);
        await makePlan(dan, streetCleaning);

        const late = await api.authorize(carol, asked.body.link._id);
        expect(late.statusCode).toBe(409);
        expect(late.body).toMatchObject({ code: 'BOTH_HAVE_PLANS', message: both });

        expect(await AccountLink.countDocuments({ status: 'active' })).toBe(0);
        expect(await accountLinks.householdIds(carol._id)).toEqual([String(carol._id)]);
    });
    it('two concurrent authorizes cannot produce two active links for one user', async () => {
        // The double tap: one request, Authorize landing twice.
        const alice = await makeUser({ firstName: 'Alice' });
        const peter = await makeUser({ firstName: 'Peter' });
        const claimed = await api.request(peter, alice.phone);
        const taps = await Promise.all([
            api.authorize(alice, claimed.body.link._id),
            api.authorize(alice, claimed.body.link._id),
        ]);
        expect(taps.map((r) => r.statusCode).sort()).toEqual([200, 409]);
        // The second tap asked for the link the first one made. It is told the
        // request is no longer waiting — never that the account it just linked
        // "is already linked with someone".
        expect(taps.find((r) => r.statusCode === 409).body.code).toBe('NOT_PENDING');
        expect(await AccountLink.countDocuments({ status: 'active' })).toBe(1);

        // The same double tap pinned to its narrowest window, which Promise.all
        // cannot promise to hit: the second tap read the request while it was
        // still pending, and asks "is either of them linked?" only after the
        // first tap has made it active.
        const realFindById = AccountLink.findById.bind(AccountLink);
        const staleRead = jest.spyOn(AccountLink, 'findById').mockImplementation((id, ...rest) => ({
            lean: async () => {
                const doc = await realFindById(id, ...rest).lean();
                return doc && doc.status === 'active' ? { ...doc, status: 'pending' } : doc;
            },
        }));
        const late = await api.authorize(alice, claimed.body.link._id);
        staleRead.mockRestore();
        expect(late.statusCode).toBe(409);
        expect(late.body.code).toBe('NOT_PENDING');
        // The link it was asking about is left exactly as the first tap made it.
        expect((await AccountLink.findById(claimed.body.link._id).lean()).status).toBe('active');
        expect(emitsTo(peter, 'accountLink:declined')).toHaveLength(0);

        // Two different requests on one account, approved in the same second.
        // The API retires a sender's earlier request when they send another,
        // so this is the state a race between two sends leaves behind.
        const carol = await makeUser({ firstName: 'Carol' });
        const dan = await makeUser({ firstName: 'Dan' });
        const erin = await makeUser({ firstName: 'Erin' });
        const now = new Date();
        const [fromCarol, fromErin] = await Promise.all([
            AccountLink.create({
                inviter: carol._id,
                invitee: dan._id,
                members: [carol._id, dan._id],
                status: 'pending',
                claimedAt: now,
            }),
            AccountLink.create({
                inviter: erin._id,
                invitee: dan._id,
                members: [erin._id, dan._id],
                status: 'pending',
                claimedAt: now,
            }),
        ]);
        const race = await Promise.all([
            api.authorize(carol, fromCarol._id),
            api.authorize(erin, fromErin._id),
        ]);
        expect(race.map((r) => r.statusCode).sort()).toEqual([200, 409]);
        expect(race.find((r) => r.statusCode === 409).body.code).toBe('ALREADY_LINKED');
        expect(await AccountLink.countDocuments({ members: dan._id, status: 'active' })).toBe(1);
    });

    it('authorize copies the car into an empty profile and never overwrites a saved one', async () => {
        // Profile → Your car, the way the app saves it.
        const saveCar = async (user, vehicle) => {
            const res = mockRes();
            await authController.updateUser({ body: { phone: user.phone, vehicle } }, res);
            expect(res.statusCode).toBe(200);
        };
        // The car itself; a saved car also says who entered it and when.
        const carOf = async (user) => {
            const v = (await User.findById(user._id).select('+vehicle').lean()).vehicle;
            return v ? { color: v.color, model: v.model, licensePlate: v.licensePlate } : v;
        };

        // One side has a car: it is copied into the other's empty slot.
        const alice = await makeUser({ firstName: 'Alice' });
        const peter = await makeUser({ firstName: 'Peter' });
        await saveCar(alice, { color: 'Blue', model: 'Honda Civic', licensePlate: 'abc1234' });
        const approved = await linkByPhone(peter, alice); // Alice asked, Peter accepted
        const civic = { color: 'Blue', model: 'Honda Civic', licensePlate: 'ABC1234' };
        expect(await carOf(peter)).toEqual(civic);
        expect(await carOf(alice)).toEqual(civic);
        // The one who tapped Authorize is told what is on their own profile
        // now, and so is the other phone, each in its own room.
        expect(approved.vehicle).toEqual(civic);
        expect(emitsTo(alice, 'accountLink:active')[0].payload.vehicle).toEqual(civic);
        expect(emitsTo(peter, 'accountLink:active')[0].payload.vehicle).toEqual(civic);

        // Both have one: nothing moves.
        const carol = await makeUser({ firstName: 'Carol' });
        const dan = await makeUser({ firstName: 'Dan' });
        await saveCar(carol, { color: 'Red', model: 'Mini', licensePlate: 'CAR0001' });
        await saveCar(dan, { color: 'Black', model: 'Volvo', licensePlate: 'DAN0002' });
        await linkByPhone(carol, dan);
        expect(await carOf(carol)).toEqual({ color: 'Red', model: 'Mini', licensePlate: 'CAR0001' });
        expect(await carOf(dan)).toEqual({ color: 'Black', model: 'Volvo', licensePlate: 'DAN0002' });

        // Neither has one: nothing is invented.
        const erin = await makeUser({ firstName: 'Erin' });
        const finn = await makeUser({ firstName: 'Finn' });
        const bare = await linkByPhone(erin, finn);
        expect(bare.vehicle).toBeNull();
        expect(await carOf(erin)).toBeUndefined();
        expect(await carOf(finn)).toBeUndefined();
    });

    it("validateSubscriptionForOrder for the non-holder sets req.subscription to the partner's plan; the order stamps coveredBySubscription with that plan's id", async () => {
        const ann = await makeUser({ firstName: 'Ann' });
        const bob = await makeUser({ firstName: 'Bob' });
        const plan = await makePlan(ann);
        await linkByPhone(ann, bob);

        const { req, passed } = await validate({ customer: String(bob._id) });
        expect(passed).toBe(true);
        expect(String(req.subscription._id)).toBe(String(plan._id));

        const { res } = await book(bob);
        expect(res.statusCode).toBe(201);
        expect(res.body.coveredBySubscription).toBe(true);
        expect(String(res.body.order.coveredBySubscription)).toBe(String(plan._id));
        expect(res.body.order.totalAmount).toBe(0);
        // The order is still Bob's: his name on the valet's job card.
        expect(String(res.body.order.customer)).toBe(String(bob._id));
    });

    it("with the holder's covered park live, the partner's quote is partner_park_live and createOrder charges list price; once that park completes, the partner is covered again", async () => {
        // Street cleaning, so "covered again" is not muddied by the free park
        // a day the two of them also share on the flat plans.
        const ann = await makeUser({ firstName: 'Ann' });
        const bob = await makeUser({ firstName: 'Bob' });
        const plan = await makePlan(ann, streetCleaning);
        await linkByPhone(ann, bob);

        const annsMove = await book(ann, aspMove);
        expect(annsMove.res.body.coveredBySubscription).toBe(true);

        const q = await quote(bob, aspMove);
        expect(q.covered).toBe(false);
        expect(q.reason).toBe('partner_park_live');
        expect(q.label).toBe("Not covered — Ann's park is using the plan");
        expect(q.detail).toBe("It's covered again once that park ends.");
        expect(q.priceCents).toBe(q.listPriceCents);
        expect(q.listPriceCents).toBeGreaterThan(0);

        // The price on the button is the price charged.
        const bobsMove = await book(bob, aspMove);
        expect(bobsMove.res.statusCode).toBe(200);
        expect(bobsMove.res.body.success).toBe(true);
        expect(bobsMove.res.body.coveredBySubscription).toBeUndefined();
        expect(bobsMove.res.body.order.coveredBySubscription).toBeUndefined();
        expect(bobsMove.res.body.order.totalAmount).toBe(q.listPriceCents);
        expect(bobsMove.res.body.order.paymentStatus).toBe('pending');

        await Order.updateOne({ _id: annsMove.res.body.order._id }, { status: 'completed' });

        const again = await quote(bob, aspMove);
        expect(again.covered).toBe(true);
        expect(again.reason).toBe('asp_move_covered');
        expect(again.label).toBe("Free with Ann's plan");
        expect(again.priceCents).toBe(0);
        const covered = await book(bob, aspMove);
        // Bob's earlier move was never paid for, so the one-order rule lets
        // this one through, and this time the plan pays.
        expect(covered.res.body.coveredBySubscription).toBe(true);
        expect(String(covered.res.body.order.coveredBySubscription)).toBe(String(plan._id));
    });

    it("freeParksUsedToday counts the partner's covered park against the holder's daily allowance", async () => {
        const ann = await makeUser({ firstName: 'Ann' });
        const bob = await makeUser({ firstName: 'Bob' });
        const plan = await makePlan(ann); // Fixed garage: one free park a day
        await linkByPhone(ann, bob);

        expect(await subscriptionService.freeParksUsedToday(plan)).toBe(0);
        const bobsPark = await book(bob);
        expect(bobsPark.res.body.coveredBySubscription).toBe(true);
        expect(await subscriptionService.freeParksUsedToday(plan)).toBe(1);

        // Once Bob's car is back, the plan is free for another car — but not
        // for another free park today.
        await Order.updateOne({ _id: bobsPark.res.body.order._id }, { status: 'completed' });
        const annsQuote = await quote(ann);
        expect(annsQuote.covered).toBe(false);
        expect(annsQuote.reason).toBe('daily_free_park_used');
        const annsPark = await book(ann);
        expect(annsPark.res.body.order.coveredBySubscription).toBeUndefined();
        expect(annsPark.res.body.order.totalAmount).toBe(annsQuote.listPriceCents);
    });

    it('the non-holder gets readOnly: true from status, 409 ON_PARTNERS_PLAN from create, and a 404 naming the holder from change/cancel', async () => {
        const ann = await makeUser({ firstName: 'Ann' });
        const bob = await makeUser({ firstName: 'Bob' });
        const plan = await makePlan(ann);
        await linkByPhone(ann, bob);

        const status = mockRes();
        await subscriptionController.getSubscriptionStatus({ params: { userId: String(bob._id) } }, status);
        expect(status.statusCode).toBe(200);
        expect(status.body.hasActiveSubscription).toBe(true);
        expect(status.body.readOnly).toBe(true);
        expect(String(status.body.subscription._id)).toBe(String(plan._id));
        expect(status.body.subscription.tier).toBe('home_garage');
        expect(Object.keys(status.body.heldBy).sort()).toEqual(SUMMARY_KEYS);
        expect(status.body.heldBy).toMatchObject({ _id: String(ann._id), firstName: 'Ann' });

        const create = mockRes();
        await subscriptionController.createSubscription(
            { body: { userId: String(bob._id), tier: 'valet_anywhere', interval: 'month' } },
            create
        );
        expect(create.statusCode).toBe(409);
        expect(create.body).toEqual({
            success: false,
            code: 'ON_PARTNERS_PLAN',
            message: "You're on Ann's plan.",
        });

        // Through the real routes, with Bob's own token: he passes the gate as
        // himself and is told whose plan it is.
        const change = await request(app)
            .post('/api/subscription/change')
            .set(...as(bob))
            .send({ userId: String(bob._id), tier: 'valet_anywhere', interval: 'month' });
        expect(change.statusCode).toBe(404);
        expect(change.body.message).toBe("That plan is on Ann's account.");

        const cancel = await request(app)
            .post('/api/subscription/cancel')
            .set(...as(bob))
            .send({ userId: String(bob._id) });
        expect(cancel.statusCode).toBe(404);
        expect(cancel.body.message).toBe("That plan is on Ann's account.");

        // And naming the holder's id gets him the gate, not her plan.
        const asAnn = await request(app)
            .post('/api/subscription/cancel')
            .set(...as(bob))
            .send({ userId: String(ann._id) });
        expect(asAnn.statusCode).toBe(403);
        expect((await Subscription.findById(plan._id)).status).toBe('active');
    });

    it("unlink by either side revokes; the former partner's next quote is no_active_subscription; their in-progress order is untouched", async () => {
        const ann = await makeUser({ firstName: 'Ann' });
        const bob = await makeUser({ firstName: 'Bob' });
        const plan = await makePlan(ann);
        await linkByPhone(ann, bob);

        // Bob's covered park, now with the valet.
        const bobsPark = await book(bob);
        expect(bobsPark.res.body.coveredBySubscription).toBe(true);
        await Order.updateOne({ _id: bobsPark.res.body.order._id }, { status: 'parked' });
        const before = await Order.findById(bobsPark.res.body.order._id).lean();

        // The non-holder unlinks.
        const byBob = await api.unlink(bob);
        expect(byBob.statusCode).toBe(200);
        const revoked = await AccountLink.findOne({}).sort({ createdAt: -1 }).lean();
        expect(revoked.status).toBe('revoked');
        expect(String(revoked.revokedBy)).toBe(String(bob._id));
        expect(emitsTo(ann, 'accountLink:revoked')).toHaveLength(1);
        expect(emitsTo(bob, 'accountLink:revoked')).toHaveLength(1);
        expect(pushes).toHaveBeenLastCalledWith(
            ann.firebaseUid,
            'Account unlinked',
            "Bob unlinked from you. You no longer see each other's parks.",
            { type: 'accountLink', linkStatus: 'revoked' }
        );

        const bobsQuote = await quote(bob);
        expect(bobsQuote.reason).toBe('no_active_subscription');
        expect(bobsQuote.covered).toBe(false);

        // A park already in progress finishes on the terms it was booked on.
        const after = await Order.findById(bobsPark.res.body.order._id).lean();
        expect(after.status).toBe('parked');
        expect(String(after.coveredBySubscription)).toBe(String(plan._id));
        expect(after.totalAmount).toBe(before.totalAmount);
        expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());

        // The holder unlinks.
        await linkByPhone(bob, ann);
        expect((await quote(bob)).plan).toMatchObject({ tier: 'home_garage' });
        const byAnn = await api.unlink(ann);
        expect(byAnn.statusCode).toBe(200);
        expect(await AccountLink.countDocuments({ status: 'active' })).toBe(0);
        const last = await AccountLink.findOne({}).sort({ createdAt: -1 }).lean();
        expect(last.status).toBe('revoked');
        expect(String(last.revokedBy)).toBe(String(ann._id));
        expect((await quote(bob)).reason).toBe('no_active_subscription');
        expect((await Order.findById(bobsPark.res.body.order._id).lean()).status).toBe('parked');

        // Nothing left to unlink.
        const again = await api.unlink(bob);
        expect(again.statusCode).toBe(404);
        expect(again.body).toMatchObject({ code: 'NOT_LINKED', message: "You're not linked with anyone." });
    });

    it("hasActiveOrder for B returns A's live order with own-first ordering; getOrdersByUser for B includes A's history", async () => {
        const a = await makeUser({ firstName: 'Ann' });
        const b = await makeUser({ firstName: 'Bob' });
        await linkByPhone(a, b);

        const active = async (user) => {
            const res = mockRes();
            await orderController.hasActiveOrder({ query: { userId: String(user._id) } }, res);
            expect(res.statusCode).toBe(200);
            return res.body;
        };

        // Only Ann has a park: Bob's home screen shows hers.
        const annsLive = await makeOrder(a, { status: 'parked' });
        let bSees = await active(b);
        expect(bSees.hasActiveOrder).toBe(true);
        expect(String(bSees.activeOrder._id)).toBe(String(annsLive._id));
        expect(bSees.activeOrders).toHaveLength(1);

        // Bob books too: his own comes first, hers second.
        const bobsLive = await makeOrder(b, { status: 'pending' });
        bSees = await active(b);
        expect(bSees.activeOrders.map((o) => String(o._id))).toEqual([
            String(bobsLive._id),
            String(annsLive._id),
        ]);
        expect(String(bSees.activeOrder._id)).toBe(String(bobsLive._id));
        // …and from Ann's side, hers first.
        const aSees = await active(a);
        expect(aSees.activeOrders.map((o) => String(o._id))).toEqual([
            String(annsLive._id),
            String(bobsLive._id),
        ]);

        // History: every park either of them booked, newest first.
        const annsOld = await makeOrder(a, {
            status: 'completed',
            pickUpTime: new Date(Date.now() - 3 * DAY),
        });
        const res = mockRes();
        await orderController.getOrdersByUser({ query: { userId: String(b._id) } }, res);
        expect(res.statusCode).toBe(200);
        const ids = res.body.orders.map((o) => String(o._id));
        expect(ids).toHaveLength(3);
        expect(ids).toEqual(expect.arrayContaining([String(annsOld._id), String(annsLive._id), String(bobsLive._id)]));
        expect(ids[ids.length - 1]).toBe(String(annsOld._id));
    });

    it('requireOrderOwner passes for the linked partner and still 403s for a stranger', async () => {
        const ann = await makeUser({ firstName: 'Ann' });
        const bob = await makeUser({ firstName: 'Bob' });
        const stranger = await makeUser({ firstName: 'Zed' });
        await linkByPhone(ann, bob);
        const annsPark = await makeOrder(ann);

        const gate = requireOrderOwner();
        const asking = (user, orderId = annsPark._id) => ({
            params: { orderId: String(orderId) },
            body: {},
            headers: { authorization: `Bearer uid:${user.firebaseUid}` },
        });

        const byOwner = asking(ann);
        expect((await runMiddleware(gate, byOwner)).passed).toBe(true);
        expect(byOwner.callerUserId).toBe(String(ann._id));
        expect(byOwner.orderOwnerId).toBe(String(ann._id));

        // The partner passes as themselves; the order is still Ann's.
        const byPartner = asking(bob);
        expect((await runMiddleware(gate, byPartner)).passed).toBe(true);
        expect(byPartner.callerUserId).toBe(String(bob._id));
        expect(byPartner.orderOwnerId).toBe(String(ann._id));

        const byStranger = await runMiddleware(gate, asking(stranger));
        expect(byStranger.passed).toBe(false);
        expect(byStranger.res.statusCode).toBe(403);
        expect(byStranger.res.body.message).toBe('That is not your order.');

        // Same answer for an order that does not exist.
        const noSuch = await runMiddleware(gate, asking(bob, new mongoose.Types.ObjectId()));
        expect(noSuch.res.statusCode).toBe(403);
        expect(noSuch.res.body.message).toBe('That is not your order.');

        // And once they unlink, Bob is a stranger to her orders again.
        await api.unlink(bob);
        const exPartner = await runMiddleware(gate, asking(bob));
        expect(exPartner.passed).toBe(false);
        expect(exPartner.res.statusCode).toBe(403);
    });

    it("createOrder's one-order rule is unchanged: B can book while A has a live order (charged, not covered, if A's is covered)", async () => {
        // Street cleaning: two covered moves a week, so the only thing that
        // can stop Bob's move being covered is Ann's move riding the plan.
        const ann = await makeUser({ firstName: 'Ann' });
        const bob = await makeUser({ firstName: 'Bob' });
        await makePlan(ann, streetCleaning);
        await linkByPhone(ann, bob);

        const annsMove = await book(ann, aspMove);
        expect(annsMove.res.body.coveredBySubscription).toBe(true);

        // Bob has nothing in flight of his own, so he may book…
        const q = await quote(bob, aspMove);
        expect(q.reason).toBe('partner_park_live');
        const bobsMove = await book(bob, aspMove);
        expect(bobsMove.res.statusCode).toBe(200);
        expect(bobsMove.res.body.success).toBe(true);
        // …charged, because Ann's car is riding the plan.
        expect(bobsMove.res.body.order.coveredBySubscription).toBeUndefined();
        expect(bobsMove.res.body.order.totalAmount).toBe(q.listPriceCents);
        expect(bobsMove.res.body.order.paymentStatus).toBe('pending');

        // The rule itself is still one per ACCOUNT: Ann cannot book a second
        // while hers is in flight, linked or not.
        const annsSecond = await book(ann, aspMove);
        expect(annsSecond.res.statusCode).toBe(400);
        expect(String(annsSecond.res.body.existingOrderId)).toBe(String(annsMove.res.body.order._id));

        // Nor can Bob, once his is paid for and in flight.
        await Order.updateOne({ _id: bobsMove.res.body.order._id }, { paymentStatus: 'paid' });
        const bobsSecond = await book(bob);
        expect(bobsSecond.res.statusCode).toBe(400);
        expect(String(bobsSecond.res.body.existingOrderId)).toBe(String(bobsMove.res.body.order._id));
    });

    it("deleting A's account revokes the link and B's status reads none", async () => {
        const ann = await makeUser({ firstName: 'Ann' });
        const bob = await makeUser({ firstName: 'Bob' });
        await makePlan(ann);
        await linkByPhone(ann, bob);
        pushes.mockClear();

        const res = mockRes();
        await authController.deleteAccount({ params: { userId: String(ann._id) }, io }, res);
        expect(res.statusCode).toBe(200);
        expect(await User.findById(ann._id)).toBeNull();

        const link = await AccountLink.findOne({}).lean();
        expect(link.status).toBe('revoked');
        expect(String(link.revokedBy)).toBe(String(ann._id));
        expect(emitsTo(bob, 'accountLink:revoked')).toHaveLength(1);
        expect(pushes).toHaveBeenCalledWith(
            bob.firebaseUid,
            'Account unlinked',
            "Ann unlinked from you. You no longer see each other's parks.",
            { type: 'accountLink', linkStatus: 'revoked' }
        );

        const status = await api.status(bob);
        expect(status.statusCode).toBe(200);
        expect(status.body.status).toBe('none');
        expect(status.body.partner).toBeNull();
        expect(status.body.plan).toEqual({ heldBy: null, tier: null, name: null });
        expect(await accountLinks.householdIds(bob._id)).toEqual([String(bob._id)]);
        // Bob is free to link with somebody else.
        const carol = await makeUser({ firstName: 'Carol' });
        await linkByPhone(carol, bob);
    });
});

/* ========================================================================== */
/* The contract's additions                                                   */
/* ========================================================================== */

describe('what the other person may see', () => {
    it("bookedBy appears only on the partner's orders, and carries exactly the five summary fields", async () => {
        const ann = await makeUser({
            firstName: 'Ann',
            lastName: 'Archer',
            phone: '+17185554821',
            firebaseUid: 'uid_ann_secret',
            stripeCustomerId: 'cus_ann_secret',
            profileImage: 'https://example.com/ann.jpg',
        });
        const bob = await makeUser({ firstName: 'Bob' });
        await linkByPhone(ann, bob);

        await makeOrder(ann, { status: 'parked' });
        await makeOrder(ann, { status: 'completed', pickUpTime: new Date(Date.now() - DAY) });
        await makeOrder(bob, { status: 'pending' });

        const expected = {
            _id: String(ann._id),
            firstName: 'Ann',
            lastName: 'Archer',
            profileImage: 'https://example.com/ann.jpg',
            phoneMasked: '4821',
        };
        const check = (orders) => {
            const plain = JSON.parse(JSON.stringify(orders));
            for (const order of plain) {
                if (order.customer === String(bob._id)) {
                    expect(order.bookedBy).toBeUndefined();
                } else {
                    expect(order.bookedBy).toEqual(expected);
                    expect(Object.keys(order.bookedBy).sort()).toEqual(SUMMARY_KEYS);
                }
            }
            const text = JSON.stringify(plain);
            for (const secret of ['7185554821', 'uid_ann_secret', 'cus_ann_secret']) {
                expect(text).not.toContain(secret);
            }
        };

        const active = mockRes();
        await orderController.hasActiveOrder({ query: { userId: String(bob._id) } }, active);
        expect(active.body.activeOrders).toHaveLength(2);
        check(active.body.activeOrders);

        const history = mockRes();
        await orderController.getOrdersByUser({ query: { userId: String(bob._id) } }, history);
        expect(history.body.orders).toHaveLength(3);
        check(history.body.orders);

        // Ann's own read of her own parks is exactly what it was: no bookedBy.
        const hers = mockRes();
        await orderController.getOrdersByUser({ query: { userId: String(ann._id) } }, hers);
        const plain = JSON.parse(JSON.stringify(hers.body.orders));
        expect(plain.filter((o) => o.customer === String(ann._id)).every((o) => !o.bookedBy)).toBe(true);
        expect(plain.find((o) => o.customer === String(bob._id)).bookedBy.firstName).toBe('Bob');
    });

    it('GET /status never leaks more than the summary; partner / pendingFrom / waitingFor follow the role', async () => {
        const saveCar = async (user) => {
            const res = mockRes();
            await authController.updateUser(
                { body: { phone: user.phone, vehicle: { color: 'Grey', model: 'Golf', licensePlate: 'SECRET9' } } },
                res
            );
        };
        const alice = await makeUser({
            firstName: 'Alice',
            phone: '+12125550111',
            firebaseUid: 'uid_alice_secret',
            stripeCustomerId: 'cus_alice_secret',
        });
        const peter = await makeUser({
            firstName: 'Peter',
            phone: '+12125550222',
            firebaseUid: 'uid_peter_secret',
            stripeCustomerId: 'cus_peter_secret',
        });
        await saveCar(alice);
        await makePlan(alice);

        const TOP_KEYS = ['askedPhone', 'link', 'partner', 'pendingFrom', 'plan', 'status', 'success', 'waitingFor'];
        const LINK_KEYS = ['_id', 'authorizedAt', 'expiresAt', 'role', 'status'];
        // `phoneOk`: the one place a full number is meant to show — the
        // sender's, to the person deciding on their request, and the number
        // the sender typed, back to them.
        const noSecrets = (body, other, phoneOk = false) => {
            const text = JSON.stringify(body);
            if (!phoneOk) expect(text).not.toContain(other.phone.replace(/\D/g, '').slice(-10));
            expect(text).not.toContain(other.firebaseUid);
            expect(text).not.toContain('cus_');
            expect(text).not.toContain('sub_');
            expect(text).not.toContain('SECRET9');
        };

        // Nothing out yet.
        let s = await api.status(peter);
        expect(Object.keys(s.body).sort()).toEqual(TOP_KEYS);
        expect(s.body).toMatchObject({ status: 'none', link: null, partner: null, pendingFrom: null, waitingFor: null });

        // Peter sends Alice a request. Alice sees who is asking, with the
        // number they signed in with; Peter sees the number he typed and
        // nothing else.
        const claimed = await api.request(peter, alice.phone);
        s = await api.status(alice);
        expect(Object.keys(s.body).sort()).toEqual(TOP_KEYS);
        expect(s.body.status).toBe('pending');
        expect(Object.keys(s.body.link).sort()).toEqual(LINK_KEYS);
        expect(s.body.link.role).toBe('inviter');
        expect(s.body.link.expiresAt).toBeTruthy();
        expect(s.body.plan).toEqual({ heldBy: 'self', tier: 'home_garage', name: 'Permanent valet' });
        expect(s.body.partner).toBeNull();
        expect(s.body.waitingFor).toBeNull();
        expect(s.body.askedPhone).toBeNull();
        expect(Object.keys(s.body.pendingFrom).sort()).toEqual([...SUMMARY_KEYS, 'phone'].sort());
        expect(s.body.pendingFrom).toMatchObject({
            _id: String(peter._id),
            firstName: 'Peter',
            phoneMasked: '0222',
            phone: '+12125550222',
        });
        noSecrets(s.body, peter, true);

        s = await api.status(peter);
        expect(s.body.status).toBe('pending');
        expect(s.body.link.role).toBe('invitee');
        expect(s.body.partner).toBeNull();
        expect(s.body.pendingFrom).toBeNull();
        expect(s.body.waitingFor).toBeNull();
        expect(s.body.askedPhone).toBe('+12125550111');
        // Before Accept the sender learns nothing about whose number it is.
        expect(JSON.stringify(s.body)).not.toContain('Alice');
        noSecrets(s.body, alice, true);

        // Linked.
        await api.authorize(alice, claimed.body.link._id);
        s = await api.status(peter);
        expect(s.body.status).toBe('active');
        expect(s.body.pendingFrom).toBeNull();
        expect(s.body.waitingFor).toBeNull();
        expect(Object.keys(s.body.partner).sort()).toEqual(SUMMARY_KEYS);
        expect(s.body.partner.firstName).toBe('Alice');
        expect(s.body.link.authorizedAt).toBeTruthy();
        expect(s.body.plan).toEqual({ heldBy: 'partner', tier: 'home_garage', name: 'Permanent valet' });
        noSecrets(s.body, alice);

        s = await api.status(alice);
        expect(s.body.partner.firstName).toBe('Peter');
        noSecrets(s.body, peter);

        // Every socket payload the handshake sent is held to the same rule,
        // the request's `from` carrying the sender's number on purpose.
        for (const e of io.emits) {
            const other = e.room === String(alice._id) ? peter : alice;
            const text = JSON.stringify(e.payload);
            expect(text).not.toContain(other.firebaseUid);
            if (e.event !== 'accountLink:requested') {
                expect(text).not.toContain(other.phone.replace(/\D/g, '').slice(-10));
            }
            if (e.payload.partner) expect(Object.keys(e.payload.partner).sort()).toEqual(SUMMARY_KEYS);
            if (e.payload.from) expect(Object.keys(e.payload.from).sort()).toEqual([...SUMMARY_KEYS, 'phone'].sort());
        }

        // Asking about somebody else's panel is the gate's 403, not their panel.
        const nosy = await request(app)
            .get('/api/account-link/status')
            .query({ userId: String(alice._id) })
            .set(...as(peter));
        expect(nosy.statusCode).toBe(403);
    });

    it('the readOnly subscription status payload carries no Stripe ids and no billing', async () => {
        const ann = await makeUser({ firstName: 'Ann', stripeCustomerId: 'cus_user_ann' });
        const bob = await makeUser({ firstName: 'Bob' });
        await makePlan(ann, {
            stripeCustomerId: 'cus_plan_ann',
            stripeSubscriptionId: 'sub_plan_ann',
            stripePriceId: 'price_plan_ann',
            trialDepositPaymentIntentId: 'pi_trial_ann',
            promoCode: 'ANNSPROMO',
            trialEndsAt: new Date(Date.now() + 5 * DAY),
            payments: [{ invoiceId: 'in_ann', amountCents: 25000, paidAt: new Date() }],
        });
        await linkByPhone(ann, bob);

        const res = mockRes();
        await subscriptionController.getSubscriptionStatus({ params: { userId: String(bob._id) } }, res);
        expect(res.body.readOnly).toBe(true);

        const text = JSON.stringify(res.body);
        for (const secret of [
            'cus_user_ann',
            'cus_plan_ann',
            'sub_plan_ann',
            'price_plan_ann',
            'pi_trial_ann',
            'in_ann',
            'ANNSPROMO',
            ann.firebaseUid,
            ann.phone.replace(/\D/g, '').slice(-10),
        ]) {
            expect(text).not.toContain(secret);
        }
        const sub = res.body.subscription;
        for (const field of [
            'amountCents',
            'interval',
            'currentPeriodEnd',
            'cancelAtPeriodEnd',
            'periodUsageCents',
            'refundIfCancelledCents',
            'promoCode',
            'trial',
            'valueIndicator',
        ]) {
            expect(sub[field]).toBeNull();
        }
        // What the partner IS shown: the plan and its coverage.
        expect(sub.tier).toBe('home_garage');
        expect(sub.homeAddress.streetAddress).toBe(HOME.streetAddress);
        expect(typeof sub.freeParkAvailableToday).toBe('boolean');

        // The holder still sees her own plan, bill and all.
        const hers = mockRes();
        await subscriptionController.getSubscriptionStatus({ params: { userId: String(ann._id) } }, hers);
        expect(hers.body.readOnly).toBeUndefined();
        expect(hers.body.heldBy).toBeUndefined();
        expect(hers.body.subscription.amountCents).toBe(25000);
    });

    it("User.vehicle stays out of getUserById's response", async () => {
        const ann = await makeUser({ firstName: 'Ann' });
        const saved = mockRes();
        await authController.updateUser(
            { body: { phone: ann.phone, vehicle: { color: 'Blue', model: 'Civic', licensePlate: 'hide123' } } },
            saved
        );
        // It is stored…
        const stored = await User.findById(ann._id).select('+vehicle').lean();
        expect(stored.vehicle.licensePlate).toBe('HIDE123');

        // …and the ungated read does not carry it.
        const res = mockRes();
        await authController.getUserById({ params: { userId: String(ann._id) } }, res);
        expect(res.statusCode).toBe(200);
        const user = JSON.parse(JSON.stringify(res.body.user));
        expect(user._id).toBe(String(ann._id));
        expect(user.vehicle).toBeUndefined();
        expect(JSON.stringify(user)).not.toContain('HIDE123');
    });
});

describe('the handshake, the ways it can go sideways', () => {
    it('a request to a number with no account waits, and becomes theirs to answer when that number signs up', async () => {
        const peter = await makeUser({ firstName: 'Peter' });

        // Typed the way people type a number.
        const sent = await api.request(peter, '(917) 555-0188');
        expect(sent.statusCode).toBe(200);
        expect(sent.body.askedPhone).toBe('+19175550188');
        const row = await AccountLink.findById(sent.body.link._id).lean();
        expect(row).toMatchObject({ status: 'pending', requestedPhone: '+19175550188' });
        expect(row.inviter).toBeUndefined();
        expect((await api.status(peter)).body).toMatchObject({ status: 'pending', askedPhone: '+19175550188' });

        // Someone signs up with that number: their first status read finds it.
        const nina = await makeUser({ firstName: 'Nina', phone: '+19175550188' });
        const s = await api.status(nina);
        expect(s.body.status).toBe('pending');
        expect(s.body.link.role).toBe('inviter');
        expect(s.body.pendingFrom).toMatchObject({ firstName: 'Peter', phone: peter.phone });

        const ok = await api.authorize(nina, s.body.link._id);
        expect(ok.statusCode).toBe(200);
        expect(await accountLinks.householdIds(peter._id)).toEqual([String(peter._id), String(nina._id)]);

        // Phone numbers as they come.
        const { normalizePhone } = accountLinkController;
        expect(normalizePhone('718-555-0142')).toBe('+17185550142');
        expect(normalizePhone('1 718 555 0142')).toBe('+17185550142');
        expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
        expect(normalizePhone('555-0142')).toBeNull();
    });
    it("the sender's Cancel request (POST /unlink on a pending link) revokes it; only the person asked can Decline or Accept", async () => {
        const alice = await makeUser({ firstName: 'Alice' });
        const peter = await makeUser({ firstName: 'Peter' });
        const stranger = await makeUser({ firstName: 'Zed' });

        const sent = await api.request(peter, alice.phone);
        const linkId = sent.body.link._id;

        // Only the person asked can Decline…
        const bySender = await api.decline(peter, linkId);
        expect(bySender.statusCode).toBe(403);
        expect(bySender.body.success).toBe(false);
        const byStranger = await api.decline(stranger, linkId);
        expect(byStranger.statusCode).toBe(403);
        // …or Accept.
        const selfApprove = await api.authorize(peter, linkId);
        expect(selfApprove.statusCode).toBe(403);
        expect((await AccountLink.findById(linkId).lean()).status).toBe('pending');

        // Peter taps Cancel request on his waiting screen.
        const cancelled = await api.unlink(peter);
        expect(cancelled.statusCode).toBe(200);
        const row = await AccountLink.findById(linkId).lean();
        expect(row.status).toBe('revoked');
        expect(String(row.revokedBy)).toBe(String(peter._id));
        // Alice's Accept screen goes away.
        const declined = emitsTo(alice, 'accountLink:declined');
        expect(declined).toHaveLength(1);
        expect(declined[0].payload.link._id).toBe(linkId);
        // A withdrawn request is no push.
        expect(pushes).toHaveBeenCalledTimes(1); // the request's, and only that

        // Nothing left to accept.
        const late = await api.authorize(alice, linkId);
        expect(late.statusCode).toBe(409);
        expect(late.body.code).toBe('NOT_PENDING');
        expect((await api.status(alice)).body.status).toBe('none');
        expect((await api.status(peter)).body.status).toBe('none');

        // And Decline from the right person does what it says.
        const again = await api.request(peter, alice.phone);
        const no = await api.decline(alice, again.body.link._id);
        expect(no.statusCode).toBe(200);
        expect((await AccountLink.findById(again.body.link._id).lean()).status).toBe('revoked');
        expect(emitsTo(peter, 'accountLink:declined')).toHaveLength(1);

        // A request to a number with no account can be withdrawn too.
        const toNobody = await api.request(peter, '+12125550177');
        expect((await api.unlink(peter)).statusCode).toBe(200);
        expect((await AccountLink.findById(toNobody.body.link._id).lean()).status).toBe('revoked');
    });
    it('a request nobody answers within seven days reads as none on both phones', async () => {
        const alice = await makeUser({ firstName: 'Alice' });
        const peter = await makeUser({ firstName: 'Peter' });
        const sent = await api.request(peter, alice.phone);

        await AccountLink.updateOne(
            { _id: sent.body.link._id },
            { $set: { claimedAt: new Date(Date.now() - accountLinkController.PENDING_TTL_MS - 60 * 1000) } }
        );

        expect((await api.status(alice)).body.status).toBe('none');
        expect((await api.status(peter)).body.status).toBe('none');
        const late = await api.authorize(alice, sent.body.link._id);
        expect(late.statusCode).toBe(409);
        expect(late.body.code).toBe('NOT_PENDING');
        expect(await AccountLink.countDocuments({ status: 'active' })).toBe(0);
    });
    it('the unique indexes alone refuse a second active link when the pre-check is raced past (E11000 → 409 ALREADY_LINKED)', async () => {
        const carol = await makeUser({ firstName: 'Carol' });
        const dan = await makeUser({ firstName: 'Dan' });
        const erin = await makeUser({ firstName: 'Erin' });
        await AccountLink.create({
            inviter: carol._id,
            invitee: dan._id,
            members: [carol._id, dan._id],
            status: 'active',
            authorizedAt: new Date(),
        });
        const pending = await AccountLink.create({
            inviter: erin._id,
            invitee: dan._id,
            members: [erin._id, dan._id],
            status: 'pending',
            claimedAt: new Date(),
        });

        // Blind the "is either of them already linked?" read, which is what a
        // race does: both taps read "no" before either writes.
        const realFindOne = AccountLink.findOne.bind(AccountLink);
        const blind = jest.spyOn(AccountLink, 'findOne').mockImplementation((filter, ...rest) =>
            filter && filter.status === 'active'
                ? { lean: async () => null }
                : realFindOne(filter, ...rest)
        );
        // Watched, not changed: proof the flip to active was really attempted,
        // so the 409 below is the index talking and not the pre-check.
        const flips = jest.spyOn(AccountLink, 'findOneAndUpdate');

        const res = await api.authorize(erin, pending._id);
        blind.mockRestore();
        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('ALREADY_LINKED');
        expect(
            flips.mock.calls.some(([, update]) => update && update.$set && update.$set.status === 'active')
        ).toBe(true);
        flips.mockRestore();

        expect(await AccountLink.countDocuments({ members: dan._id, status: 'active' })).toBe(1);
        // The request that can never succeed is taken off the table, and the
        // sender's waiting screen is told.
        expect((await AccountLink.findById(pending._id).lean()).status).toBe('expired');
        expect(emitsTo(dan, 'accountLink:declined')).toHaveLength(1);
    });
});

describe("acting on the other one's park", () => {
    it("a partner's retrieval on the owner's park is created for the owner and bills the owner; actedBy is the partner", async () => {
        const ann = await makeUser({ firstName: 'Ann' });
        const bob = await makeUser({ firstName: 'Bob' });
        const stranger = await makeUser({ firstName: 'Zed' });
        await linkByPhone(ann, bob);
        const annsPark = await makeOrder(ann, {
            serviceType: 'park-and-hold',
            paymentIntentId: 'pi_ann_park',
        });

        const bringBack = async (user, extra = {}) => {
            const body = {
                customer: String(user._id),
                originalOrderId: String(annsPark._id),
                ...extra,
            };
            const { req, passed } = await validate(body);
            expect(passed).toBe(true);
            req.io = mockIo();
            const res = mockRes();
            await orderController.createRetrievalOrder(req, res);
            return { req, res };
        };

        const refused = await bringBack(stranger);
        expect(refused.res.statusCode).toBe(403);

        // Bob asks for Ann's car. A client would never send an intent here; one
        // that did must not become the refund target on Ann's order.
        const { req, res } = await bringBack(bob, { paymentIntentId: 'pi_bob_card' });
        expect(res.statusCode).toBe(201);
        const retrieval = await Order.findById(res.body.order._id).lean();
        expect(String(retrieval.customer)).toBe(String(ann._id));
        expect(String(retrieval.actedBy)).toBe(String(bob._id));
        expect(retrieval.paymentIntentId).toBeUndefined();
        expect(String(retrieval.linkedOrderId)).toBe(String(annsPark._id));
        // Park & Retrieve: the ride back was bought with Ann's park, on Ann's
        // card, so nothing is charged now to anyone.
        expect(retrieval.isFreeService).toBe(true);
        expect(retrieval.paymentStatus).toBe('paid');
        // Both home screens hear about it.
        const rooms = req.io.emits.filter((e) => e.event === 'orderUpdated').map((e) => e.room);
        expect(rooms).toEqual(expect.arrayContaining([String(ann._id), String(bob._id)]));

        // Ann asking for her own car carries no actedBy.
        await Order.deleteMany({ orderType: 'retrieval' });
        const own = await bringBack(ann);
        expect(own.res.statusCode).toBe(201);
        expect((await Order.findById(own.res.body.order._id).lean()).actedBy).toBeUndefined();
    });

    it("on a managed plan an open custody row for the holder's car keeps the partner's park off the plan, even after the holder's order is completed; that park is not indefinite", async () => {
        const ann = await makeUser({ firstName: 'Ann' });
        const bob = await makeUser({ firstName: 'Bob' });
        const plan = await makePlan(ann); // Fixed garage: we hold the car
        await linkByPhone(ann, bob);

        // Ann's covered park from two days ago. Its order is completed — the
        // valet closed it out — but the car is still ours on the street.
        const annsPark = await makeOrder(ann, {
            status: 'completed',
            pickUpTime: new Date(Date.now() - 2 * DAY),
            coveredBySubscription: plan._id,
            indefinite: true,
            totalAmount: 0,
        });
        const custody = await CurbCustody.create({
            customer: ann._id,
            subscription: plan._id,
            tier: 'home_garage',
            currentOrder: annsPark._id,
        });

        const q = await quote(bob);
        expect(q.reason).toBe('partner_park_live');
        expect(q.label).toBe("Not covered — Ann's park is using the plan");
        expect(q.covered).toBe(false);
        expect(q.priceCents).toBe(q.listPriceCents);
        expect(q.indefinite).toBe(false);

        const bobsPark = await book(bob);
        expect(bobsPark.res.body.success).toBe(true);
        const order = bobsPark.res.body.order;
        expect(order.coveredBySubscription).toBeUndefined();
        expect(order.indefinite).not.toBe(true);
        expect(order.totalAmount).toBe(q.listPriceCents);

        // Parked, it is still an ordinary paid park: no custody row from this plan.
        const parked = await Order.findByIdAndUpdate(
            order._id,
            { status: 'parked', paymentStatus: 'paid', parkingLocation: HOME },
            { new: true }
        );
        expect(await curbCustody.classify(parked)).toBeNull();

        // Once we hand Ann's car back, the plan is free for Bob's next park.
        await Order.updateOne({ _id: order._id }, { status: 'completed' });
        await CurbCustody.updateOne({ _id: custody._id }, { $set: { closedAt: new Date() } });
        const after = await quote(bob);
        expect(after.reason).toBe('daily_free_park');
        expect(after.covered).toBe(true);
        expect(after.indefinite).toBe(true);
    });

    it('emitToHousehold reaches both rooms when linked, one room when not', async () => {
        const ann = await makeUser({ firstName: 'Ann', phone: '+13475559876' });
        const bob = await makeUser({ firstName: 'Bob' });
        const annsPark = await makeOrder(ann, {
            paymentDetails: { clientSecret: 'pi_secret_ann', amount: 1500 },
        });

        // Not linked: Ann's room and nobody else's.
        const alone = mockIo();
        await accountLinks.emitToHousehold(alone, ann._id, 'orderUpdated', annsPark);
        expect(alone.emits.map((e) => e.room)).toEqual([String(ann._id)]);

        await linkByPhone(ann, bob);

        // Linked: the booker first, then the partner.
        const both = mockIo();
        await accountLinks.emitToHousehold(both, ann._id, 'orderUpdated', {
            type: 'ORDER_CANCELLED',
            order: await Order.findById(annsPark._id).populate('customer'),
        });
        expect(both.emits.map((e) => e.room)).toEqual([String(ann._id), String(bob._id)]);
        expect(both.emits.every((e) => e.event === 'orderUpdated')).toBe(true);
        // The partner's copy describes Ann by her summary, and drops the
        // secret of her charge.
        const toBob = JSON.parse(JSON.stringify(both.emits[1].payload));
        expect(toBob.type).toBe('ORDER_CANCELLED');
        expect(Object.keys(toBob.order.customer).sort()).toEqual(SUMMARY_KEYS);
        expect(JSON.stringify(toBob)).not.toContain('3475559876');
        expect(JSON.stringify(toBob)).not.toContain(ann.firebaseUid);
        expect(JSON.stringify(toBob)).not.toContain('pi_secret_ann');

        // Unlinked again: back to one room.
        await api.unlink(bob);
        const after = mockIo();
        await accountLinks.emitToHousehold(after, ann._id, 'orderUpdated', annsPark);
        expect(after.emits.map((e) => e.room)).toEqual([String(ann._id)]);
    });
});

describe('the one-park rule at its edges, and what a partner never holds', () => {
    it("a covered move blocks the partner's move only when the two overlap in time", async () => {
        const ann = await makeUser({ firstName: 'Ann' });
        const bob = await makeUser({ firstName: 'Bob' });
        const plan = await makePlan(ann, streetCleaning);
        await linkByPhone(ann, bob);

        // Ann's covered move, booked ahead for three days from now.
        const annsMove = await makeOrder(ann, {
            ...aspMove,
            status: 'pending',
            pickUpTime: new Date(Date.now() + 3 * DAY),
            duration: 120,
            coveredBySubscription: plan._id,
            totalAmount: 0,
        });
        const today = await quote(bob, aspMove);
        expect(today.reason).not.toBe('partner_park_live');
        expect(today.covered).toBe(true);

        // Bob's move for the same morning as hers overlaps it.
        const sameTime = await quote(bob, { ...aspMove, pickUpTime: new Date(Date.now() + 3 * DAY + 30 * 60 * 1000) });
        expect(sameTime.reason).toBe('partner_park_live');

        // Hers under way now: his move three days out does not meet it...
        await Order.updateOne({ _id: annsMove._id }, { status: 'in_progress', pickUpTime: new Date() });
        const later = await quote(bob, { ...aspMove, pickUpTime: new Date(Date.now() + 3 * DAY) });
        expect(later.reason).not.toBe('partner_park_live');
        // ...and one right now does.
        const now = await quote(bob, aspMove);
        expect(now.reason).toBe('partner_park_live');
        expect(now.covered).toBe(false);
    });

    it("on the managed plans a held park booked for tomorrow stops a covered park today: both would be held at once", async () => {
        const ann = await makeUser({ firstName: 'Ann' });
        const bob = await makeUser({ firstName: 'Bob' });
        const plan = await makePlan(ann, { tier: 'valet_anywhere', amountCents: 30000 });
        await linkByPhone(ann, bob);

        // Bob's covered park for tomorrow: held with no end once it starts.
        await makeOrder(bob, {
            status: 'pending',
            pickUpTime: new Date(Date.now() + 20 * 60 * 60 * 1000),
            coveredBySubscription: plan._id,
            indefinite: true,
            totalAmount: 0,
        });

        const q = await quote(ann);
        expect(q.reason).toBe('partner_park_live');
        expect(q.label).toBe("Not covered — Bob's park is using the plan");
        expect(q.indefinite).toBe(false);

        const booked = await book(ann);
        expect(booked.res.body.success).toBe(true);
        expect(booked.res.body.order.coveredBySubscription).toBeUndefined();
        expect(booked.res.body.order.indefinite).not.toBe(true);
    });

    it('a paid park the plan will hold but did not pay for holds the plan from the moment it is booked', async () => {
        const ann = await makeUser({ firstName: 'Ann' });
        const bob = await makeUser({ firstName: 'Bob' });
        await makePlan(ann); // Fixed garage: we hold the car
        await linkByPhone(ann, bob);

        // Ann's second park of the day: paid, held with no end time, no plan
        // stamp, and no custody row yet because no valet has parked it.
        const annsPark = await makeOrder(ann, {
            status: 'accepted',
            indefinite: true,
            paymentStatus: 'paid',
        });
        const q = await quote(bob);
        expect(q.reason).toBe('partner_park_live');
        expect(q.label).toBe("Not covered — Ann's park is using the plan");

        // A checkout she walked away from is not a car on the plan.
        await Order.updateOne({ _id: annsPark._id }, { paymentStatus: 'pending' });
        const abandoned = await quote(bob);
        expect(abandoned.reason).not.toBe('partner_park_live');
    });

    it("a partner can't buy a plan while the holder's is past due: it covers them both again once the card clears", async () => {
        const ann = await makeUser({ firstName: 'Ann' });
        const bob = await makeUser({ firstName: 'Bob' });
        const plan = await makePlan(ann);
        await linkByPhone(ann, bob);
        await Subscription.updateOne({ _id: plan._id }, { status: 'past_due' });

        const res = mockRes();
        await subscriptionController.createSubscription(
            { body: { userId: String(bob._id), tier: 'home_garage', interval: 'month' } },
            res
        );
        expect(res.statusCode).toBe(409);
        expect(res.body).toMatchObject({ code: 'ON_PARTNERS_PLAN', message: "You're on Ann's plan." });
    });

    it("a partner who cancels the booker's park gets it back without the booker's payment details", async () => {
        const ann = await makeUser({ firstName: 'Ann' });
        const bob = await makeUser({ firstName: 'Bob' });
        await linkByPhone(ann, bob);
        const annsPark = await makeOrder(ann, {
            status: 'pending',
            paymentIntentId: 'pi_ann_cancel',
            paymentDetails: {
                amount: 1500,
                chargeId: 'ch_ann_cancel',
                paymentMethodDetails: { type: 'card', brand: 'visa', last4: '4242' },
            },
        });

        const res = mockRes();
        await orderController.cancelOrder(
            { body: { orderId: String(annsPark._id), userId: String(bob._id) }, io: mockIo() },
            res
        );
        expect(res.statusCode).toBe(200);
        const body = JSON.stringify(res.body);
        for (const secret of ['pi_ann_cancel', 'ch_ann_cancel', '4242']) {
            expect(body).not.toContain(secret);
        }
        expect(res.body.order.status).toBe('cancelled');
        expect(String((await Order.findById(annsPark._id)).actedBy)).toBe(String(bob._id));
    });

    it("only customer accounts can link: a valet can't send a request, and one sent to a valet's number reaches nobody", async () => {
        const ann = await makeUser({ firstName: 'Ann' });
        const val = await makeUser({ firstName: 'Val', isValet: true });

        const fromValet = await api.request(val, ann.phone);
        expect(fromValet.statusCode).toBe(403);
        expect(fromValet.body.code).toBe('NOT_A_CUSTOMER');
        expect(await AccountLink.countDocuments({})).toBe(0);

        const toValet = await api.request(ann, val.phone);
        expect(toValet.statusCode).toBe(200);
        expect((await AccountLink.findById(toValet.body.link._id).lean()).inviter).toBeUndefined();
        // Not even after the valet reads their own status.
        expect((await api.status(val)).body.status).toBe('none');
        expect(emitsTo(val, 'accountLink:requested')).toHaveLength(0);
    });
    it('a past-due plan still counts as a plan: linking two people who each hold one is refused', async () => {
        const ann = await makeUser({ firstName: 'Ann' });
        const bob = await makeUser({ firstName: 'Bob' });
        await makePlan(ann);
        await makePlan(bob, { status: 'past_due' });

        const sent = await api.request(bob, ann.phone);
        const accepted = await api.authorize(ann, sent.body.link._id);
        expect(accepted.statusCode).toBe(409);
        expect(accepted.body.code).toBe('BOTH_HAVE_PLANS');
    });
    it("the partner's copy of an order carries no Stripe id and no card; the booker's own copy is untouched", async () => {
        const ann = await makeUser({ firstName: 'Ann' });
        const bob = await makeUser({ firstName: 'Bob' });
        await linkByPhone(ann, bob);

        const annsPark = await makeOrder(ann, {
            paymentIntentId: 'pi_ann_park',
            paymentDetails: {
                amount: 1500,
                clientSecret: 'pi_ann_park_secret',
                chargeId: 'ch_ann',
                receiptUrl: 'https://pay.stripe.com/receipts/ann',
                paymentMethodDetails: { type: 'card', brand: 'visa', last4: '4242' },
            },
            extensions: [
                { additionalHours: 1, amountCents: 500, paymentIntentId: 'pi_ann_ext', chargedAt: new Date() },
            ],
            checkout: { failureCode: 'card_declined', failureMessage: 'Your card was declined.' },
        });

        const read = async (user) => {
            const res = mockRes();
            await orderController.hasActiveOrder({ query: { userId: String(user._id) } }, res);
            return res.body.activeOrder;
        };

        const bobSees = JSON.stringify(await read(bob));
        for (const secret of ['pi_ann', 'ch_ann', 'pay.stripe.com', '4242', 'card_declined']) {
            expect(bobSees).not.toContain(secret);
        }
        const toBob = JSON.parse(bobSees);
        expect(toBob.paymentDetails.amount).toBe(1500);
        expect(toBob.extensions[0].amountCents).toBe(500);
        expect(toBob.paymentStatus).toBe('paid');

        const annSees = await read(ann);
        expect(String(annSees._id)).toBe(String(annsPark._id));
        expect(annSees.paymentIntentId).toBe('pi_ann_park');
        expect(annSees.paymentDetails.paymentMethodDetails.last4).toBe('4242');
    });
});
