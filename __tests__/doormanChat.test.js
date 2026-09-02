/**
 * The doorman's half of the chat, proxied through the share link.
 * Run: npx jest doormanChat
 *
 * He is standing at the front desk with Randi's keys and no way to say so. The
 * valet is two blocks away in an app; she is in a meeting. So the link carries
 * the thread — but it carries it through the server, because this project's
 * Firestore rules allow anonymous read and write to everything and a browser
 * client in the hands of a bearer link is a browser client in the hands of
 * whoever it gets forwarded to.
 *
 * The transcript is where the handoff codes actually live — the apps deliver
 * OTPs as chat messages — so most of what is asserted here is again what the
 * link must NOT do: never print a code the reveal window is withholding, never
 * hand back a phone number or an id, never read a finished job's conversation,
 * and never let one link talk at a valet all morning.
 */

let mockThread = {};
const mockAdded = [];

jest.mock('firebase-admin', () => {
    const firestore = () => ({
        collection: () => ({
            doc: (conversationId) => ({
                collection: () => ({
                    orderBy: (field, direction) => ({
                        limit: (n) => ({
                            get: async () => {
                                const docs = (mockThread[conversationId] || [])
                                    .slice()
                                    .sort((a, b) =>
                                        direction === 'desc'
                                            ? b.data()[field].toMillis() - a.data()[field].toMillis()
                                            : a.data()[field].toMillis() - b.data()[field].toMillis()
                                    )
                                    .slice(0, n);
                                return { docs };
                            },
                        }),
                    }),
                    add: async (payload) => {
                        mockAdded.push({ conversationId, payload });
                        return { id: `written-${mockAdded.length}` };
                    },
                }),
            }),
        }),
    });
    firestore.Timestamp = { now: () => ({ toMillis: () => Date.now() }) };
    firestore.FieldValue = { serverTimestamp: () => '<server-timestamp>' };
    // Minting the link now wants the customer's Firebase ID token — see
    // `callerFirebaseUid`. Here a token is the string `uid:<firebaseUid>`;
    // nothing in this file is about who may mint, only about the chat that
    // hangs off a link once one exists.
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

let mongo;

const app = express();
app.use(express.json());
app.use('/api/share', shareRouter);

let phoneSeq = 9175551000;
const makeUser = (isValet = false, extra = {}) => User.create({
    firstName: isValet ? 'Marco' : 'Randi',
    lastName: 'Tester',
    email: `u${new mongoose.Types.ObjectId()}@example.com`,
    phone: String(++phoneSeq),
    // Signed in on a phone, which is what the mint asks for proof of.
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

const CONVO = 'conv-randi';

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
    conversationId: CONVO,
    vehicle: { color: 'Grey', model: 'Honda Civic', licensePlate: 'ABC1234' },
    ...extra,
});

/** The morning beat: a valet carrying the job, with a code to read out. */
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
        parkedAt: new Date(),
        parkingLocation: { lat: 40.6801, lng: -73.9912, streetAddress: '310 12th St' },
        otpVerifiedTimes: { orderCreation: new Date() },
        otp: liveOtp(code, 'return_key'),
        ...extra,
    });

let messageSeq = 0;
/** One Firestore message document, in the shape both apps write. */
const message = (fields, conversationId = CONVO) => {
    messageSeq += 1;
    const at = Date.now() + messageSeq * 1000;
    const data = {
        createdAt: { toMillis: () => at },
        serverCreatedAt: { toMillis: () => at },
        ...fields,
    };
    const doc = { id: `m${messageSeq}`, data: () => data };
    mockThread[conversationId] = [...(mockThread[conversationId] || []), doc];
    return doc;
};

const tokenFor = async (userId) => {
    const user = await User.findById(userId).select('firebaseUid');
    const res = await request(app)
        .post('/api/share/link')
        .set('Authorization', `Bearer uid:${user.firebaseUid}`)
        .send({ userId: String(userId) });
    return res.body.token;
};

const revokeLink = (token) =>
    request(app).post('/api/share/link/revoke').send({ token });

const read = (token) => request(app).get(`/api/share/${token}/messages`);

const say = (token, text) =>
    request(app).post(`/api/share/${token}/messages`).send({ text });

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
    mockAdded.length = 0;
});

describe('a link that should not be talking at all', () => {
    test('a token nobody ever minted reads nothing and says nothing', async () => {
        expect((await read('not-a-real-token')).statusCode).toBe(404);

        const sent = await say('not-a-real-token', 'I have the keys');
        expect(sent.statusCode).toBe(404);
        expect(sent.body.code).toBe('INVALID');
        expect(mockAdded).toHaveLength(0);
    });

    test('one the customer revoked, even mid-handoff', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeTypeItOrder(customer._id, valet._id);
        const token = await tokenFor(customer._id);
        message({ text: 'On my way', senderId: String(valet._id) });

        expect((await read(token)).body.messages).toHaveLength(1);

        await revokeLink(token);

        expect((await read(token)).body.code).toBe('REVOKED');
        expect((await say(token, 'hello')).statusCode).toBe(404);
        expect(mockAdded).toHaveLength(0);
    });

    test('between jobs there is nothing to read — a standing link is not an archive', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeTypeItOrder(customer._id, valet._id);
        const token = await tokenFor(customer._id);
        message({ text: 'Left the keys with the front desk', senderId: String(customer._id) });

        expect((await read(token)).body.messages).toHaveLength(1);

        // Thursday's job is over. The link still works — it is hers, not the
        // job's — but last week's conversation is not his to scroll.
        await Order.findByIdAndUpdate(order._id, { status: 'completed' });

        const res = await read(token);
        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('NO_LIVE_ORDER');

        const sent = await say(token, 'anyone there?');
        expect(sent.statusCode).toBe(404);
        expect(mockAdded).toHaveLength(0);
    });

    test('a booking nobody has accepted has no thread yet, and says so without dying', async () => {
        const customer = await makeUser();
        await makeOrder(customer._id, {
            status: 'pending',
            conversationId: undefined,
            otp: liveOtp('112233', 'order_creation'),
        });
        const token = await tokenFor(customer._id);

        const res = await read(token);
        expect(res.statusCode).toBe(200);
        expect(res.body.canSend).toBe(false);
        expect(res.body.messages).toEqual([]);

        expect((await say(token, 'I have the keys')).statusCode).toBe(409);
        expect(mockAdded).toHaveLength(0);
    });
});

describe('the transcript is not a side channel for the code', () => {
    test('the code the doorman is meant to be TYPING never appears in the chat', async () => {
        // The whole point. On this beat the number is the valet's, read out
        // loud at the door, and the screen deliberately withholds it — so a
        // transcript that prints the message it arrived in would hand the link
        // alone everything it needs to take a car.
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeTypeItOrder(customer._id, valet._id, '481902');
        const token = await tokenFor(customer._id);

        message({
            text: 'OTP for collecting keys is 481902',
            senderId: 'system',
            isSystemMessage: true,
            messageType: 'otp_collect_keys',
        });
        message({ text: 'I am downstairs', senderId: String(valet._id) });

        const res = await read(token);

        expect(res.body.messages.map((m) => m.text)).toEqual(['I am downstairs']);
        expect(JSON.stringify(res.body)).not.toContain('481902');
    });

    test('and stays hidden once the window has shut behind it', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeTypeItOrder(customer._id, valet._id, '481902');
        const token = await tokenFor(customer._id);
        message({
            text: 'OTP for collecting keys is 481902',
            senderId: 'system',
            isSystemMessage: true,
            messageType: 'otp_collect_keys',
        });

        // The keys changed hands, so the type beat is over. The message is
        // still sitting in the thread with the number in it.
        await Order.findByIdAndUpdate(order._id, {
            'otp.verified': true,
            'otpVerifiedTimes.orderCreation': new Date(),
        });

        expect(JSON.stringify((await read(token)).body)).not.toContain('481902');
    });

    test('on the beat where the code is his to SAY, the message he already has on screen comes through', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeSayItOrder(customer._id, valet._id, '773311');
        const token = await tokenFor(customer._id);
        message({
            text: 'OTP for returning keys is 773311',
            senderId: 'system',
            isSystemMessage: true,
            messageType: 'otp_verification',
        });

        const { messages } = (await read(token)).body;

        expect(messages).toHaveLength(1);
        expect(messages[0].from).toBe('system');
        expect(messages[0].text).toContain('773311');
    });

    test('a stale code from the morning does not ride out on the evening’s window', async () => {
        // The ASP sweep mints its return leg on the parent's conversation, so
        // one thread carries both legs. An hours-old `otp_verification` is
        // still tagged as a code message and must not surface just because a
        // window happens to be open now.
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeSayItOrder(customer._id, valet._id, '773311');
        const token = await tokenFor(customer._id);
        message({
            text: 'OTP for returning keys is 665544',
            senderId: 'system',
            isSystemMessage: true,
            messageType: 'otp_verification',
        });

        expect(JSON.stringify((await read(token)).body)).not.toContain('665544');
    });

    test('"OTP has been sent to the customer" is valet bookkeeping, not his business', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeSayItOrder(customer._id, valet._id, '773311');
        const token = await tokenFor(customer._id);
        message({
            text: 'OTP has been sent to the customer.',
            senderId: 'system',
            isSystemMessage: true,
            messageType: 'otp_sent',
        });

        expect((await read(token)).body.messages).toEqual([]);
    });

    test('a valet who types the code with his thumbs is redacted, not forwarded', async () => {
        // Classifying by `messageType` covers what the apps TAG. It does not
        // cover a person typing. "code is 481902" is an ordinary bubble by
        // every test in the filter, and it went out verbatim — the number the
        // screen above it was deliberately withholding, in the chat under it.
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeTypeItOrder(customer._id, valet._id, '481902');
        const token = await tokenFor(customer._id);
        message({ text: 'at the door, code is 481902', senderId: String(valet._id) });

        const res = await read(token);

        expect(JSON.stringify(res.body)).not.toContain('481902');
        // Still a message. Blanking the number is not the same as taking the
        // sentence away from a doorman who is being talked to.
        expect(res.body.messages).toHaveLength(1);
        expect(res.body.messages[0].text).toContain('at the door');
    });

    test('and stays redacted with the window shut, which is when it used to leak', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeTypeItOrder(customer._id, valet._id, '481902');
        const token = await tokenFor(customer._id);
        message({ text: 'code is 481902 by the way', senderId: String(valet._id) });

        // Nobody is on the job any more, so there is no window at all — and the
        // old filter only ever looked at the window when a message was tagged.
        await Order.findByIdAndUpdate(order._id, { $unset: { valet: '' } });

        expect(JSON.stringify((await read(token)).body)).not.toContain('481902');
    });

    test('the other leg’s code is blanked too — one thread carries both', async () => {
        // The sweep mints its return leg on the parent's conversation, so the
        // morning's number and the evening's are in one transcript. Only the
        // one the screen is showing right now may survive.
        const customer = await makeUser();
        const valet = await makeUser(true);
        const park = await makeOrder(customer._id, {
            valet: valet._id,
            status: 'parked',
            aspMode: true,
            aspOrderCreated: true,
            parkClosedAt: new Date(),
            otp: liveOtp('665544', 'return_key'),
        });
        const leg = await makeOrder(customer._id, {
            orderType: 'retrieval',
            valet: valet._id,
            acceptedAt: new Date(),
            aspMode: true,
            linkedOrderId: park._id,
            otp: liveOtp('884422', 'return_key'),
        });
        await Order.findByIdAndUpdate(park._id, { linkedOrderId: leg._id });
        const token = await tokenFor(customer._id);
        message({ text: 'this morning it was 665544', senderId: String(valet._id) });

        const res = await read(token);

        expect(res.body.messages).toHaveLength(1);
        expect(JSON.stringify(res.body)).not.toContain('665544');
    });

    test('but the number already on his screen is left where he can read it', async () => {
        // On the say beat `codeToSay` is printed above this thread. Blanking
        // the same digits out of the valet's sentence would only confuse the
        // man who is about to say them out loud.
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeSayItOrder(customer._id, valet._id, '773311');
        const token = await tokenFor(customer._id);
        message({ text: 'read me 773311 and I will hand them over', senderId: String(valet._id) });

        expect((await read(token)).body.messages[0].text).toContain('773311');
    });

    test('an untagged-looking tag is still a tag', async () => {
        // `type` was only read when `messageType` was a string and the drop
        // tested `if (type)`, so an empty string and a number both fell through
        // as "untagged" — and a tagged OTP message reached the doorman.
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeTypeItOrder(customer._id, valet._id, '481902');
        const token = await tokenFor(customer._id);

        message({
            text: 'Pay here: https://buy.stripe.com/whatever',
            senderId: 'system',
            messageType: '',
        });
        message({
            text: 'Photo after parking — tap to view',
            senderId: String(valet._id),
            messageType: 7,
        });
        message({ text: 'I am downstairs', senderId: String(valet._id) });

        const res = await read(token);

        expect(res.body.messages.map((m) => m.text)).toEqual(['I am downstairs']);
        expect(JSON.stringify(res.body)).not.toContain('buy.stripe.com');
    });

    test('a photo post keeps its signed storage url to itself', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeTypeItOrder(customer._id, valet._id);
        const token = await tokenFor(customer._id);
        message({
            text: 'Photo after parking — tap to view',
            senderId: String(valet._id),
            messageType: 'photo',
            photoUrl: 'https://storage.googleapis.com/signed?token=secret',
            containsLink: true,
            link: 'https://storage.googleapis.com/signed?token=secret',
        });

        expect(JSON.stringify((await read(token)).body)).not.toContain('storage.googleapis.com');
    });
});

describe('what the doorman can read', () => {
    test('who said what, and nothing about who they are', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const order = await makeTypeItOrder(customer._id, valet._id);
        const token = await tokenFor(customer._id);

        message({ text: 'Keys are at the desk', senderId: String(customer._id) });
        message({ text: 'Two minutes away', senderId: String(valet._id) });
        message({
            text: 'Front desk: I am in the lobby',
            senderId: String(customer._id),
            senderRole: 'doorman',
        });

        const res = await read(token);

        expect(res.body.messages.map((m) => m.from)).toEqual(['customer', 'valet', 'doorman']);
        expect(Object.keys(res.body.messages[0]).sort()).toEqual(['at', 'from', 'id', 'text']);
        expect(res.body.messages[0].at).toBeGreaterThan(0);

        const serialised = JSON.stringify(res.body);
        expect(serialised).not.toContain(customer.phone);
        expect(serialised).not.toContain(valet.phone);
        // Where she lives, and the address of the thread itself.
        expect(serialised).not.toContain(CURB.streetAddress);
        expect(serialised).not.toContain(String(customer._id));
        expect(serialised).not.toContain(String(valet._id));
        expect(serialised).not.toContain(String(order._id));
        expect(serialised).not.toContain(CONVO);
    });

    test('a valet on a web signup is still the valet, by firebase uid', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true, { firebaseUid: 'fb-marco' });
        await makeTypeItOrder(customer._id, valet._id);
        const token = await tokenFor(customer._id);
        message({ text: 'Pulling up now', senderId: 'fb-marco' });

        expect((await read(token)).body.messages[0].from).toBe('valet');
    });

    test('the tail of a long thread, oldest of that tail first', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeTypeItOrder(customer._id, valet._id);
        const token = await tokenFor(customer._id);

        for (let i = 0; i < 60; i += 1) {
            message({ text: `line ${i}`, senderId: String(valet._id) });
        }

        const { messages } = (await read(token)).body;

        expect(messages).toHaveLength(50);
        expect(messages[0].text).toBe('line 10');
        expect(messages[49].text).toBe('line 59');
    });

    test('Randi’s evening: the sweep’s leg reads the thread it shares with its parent', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const park = await makeOrder(customer._id, {
            valet: valet._id,
            status: 'parked',
            parkedAt: new Date(),
            aspMode: true,
            aspOrderCreated: true,
            parkClosedAt: new Date(),
        });
        const leg = await makeOrder(customer._id, {
            orderType: 'retrieval',
            valet: valet._id,
            acceptedAt: new Date(),
            aspMode: true,
            linkedOrderId: park._id,
            otp: liveOtp('884422', 'return_key'),
        });
        await Order.findByIdAndUpdate(park._id, { linkedOrderId: leg._id });
        const token = await tokenFor(customer._id);
        message({ text: 'Bringing it back now', senderId: String(valet._id) });

        const res = await read(token);

        expect(res.statusCode).toBe(200);
        expect(res.body.messages.map((m) => m.text)).toEqual(['Bringing it back now']);
    });
});

describe('what the doorman can send', () => {
    test('lands in the valet’s thread, in the customer’s lane, saying who is typing', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeTypeItOrder(customer._id, valet._id);
        const token = await tokenFor(customer._id);

        const res = await say(token, 'I am at the front desk, come to the lobby');

        expect(res.statusCode).toBe(200);
        expect(mockAdded).toHaveLength(1);

        const { conversationId, payload } = mockAdded[0];
        expect(conversationId).toBe(CONVO);
        // The valet is on 2.2.0 and labels bubbles off senderId alone, so the
        // text is the only place "this is not the customer" can be said.
        expect(payload.text).toBe('Front desk: I am at the front desk, come to the lobby');
        expect(payload.senderId).toBe(String(customer._id));
        expect(payload.senderRole).toBe('doorman');
        // Both stamps, or the valet's list mis-sorts it.
        expect(payload.createdAt).toBeTruthy();
        expect(payload.serverCreatedAt).toBe('<server-timestamp>');
        // Nothing that would make an existing renderer treat it as a system
        // notice and filter it out of the conversation.
        expect(payload.isSystemMessage).toBeUndefined();
        expect(payload.messageType).toBeUndefined();
    });

    test('an ASP return leg posts into the parent’s thread, where the valet is', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        const park = await makeOrder(customer._id, {
            valet: valet._id,
            status: 'parked',
            aspMode: true,
            aspOrderCreated: true,
            parkClosedAt: new Date(),
        });
        const leg = await makeOrder(customer._id, {
            orderType: 'retrieval',
            valet: valet._id,
            acceptedAt: new Date(),
            aspMode: true,
            linkedOrderId: park._id,
            otp: liveOtp('884422', 'return_key'),
        });
        await Order.findByIdAndUpdate(park._id, { linkedOrderId: leg._id });
        const token = await tokenFor(customer._id);

        await say(token, 'She is back, I can take the keys');

        expect(mockAdded[0].conversationId).toBe(CONVO);
    });

    test('an empty message is not a message', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeTypeItOrder(customer._id, valet._id);
        const token = await tokenFor(customer._id);

        for (const text of ['', '   ', '\n\n\n', null, 42]) {
            expect((await say(token, text)).statusCode).toBe(400);
        }
        expect(mockAdded).toHaveLength(0);
    });

    test('control characters are flattened rather than passed to a renderer', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeTypeItOrder(customer._id, valet._id);
        const token = await tokenFor(customer._id);

        await say(token, 'lobby\u0000\u001b now\nplease');

        expect(mockAdded[0].payload.text).toBe('Front desk: lobby now please');
    });

    test('a wall of text is refused outright, not silently cut in half', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeTypeItOrder(customer._id, valet._id);
        const token = await tokenFor(customer._id);

        const res = await say(token, 'x'.repeat(401));

        expect(res.statusCode).toBe(400);
        expect(mockAdded).toHaveLength(0);
        expect((await say(token, 'x'.repeat(400))).statusCode).toBe(200);
    });

    test('ten messages in five minutes, then the link stops buzzing the valet', async () => {
        const customer = await makeUser();
        const valet = await makeUser(true);
        await makeTypeItOrder(customer._id, valet._id);
        const token = await tokenFor(customer._id);

        for (let i = 0; i < 10; i += 1) {
            expect((await say(token, `message ${i}`)).statusCode).toBe(200);
        }

        const eleventh = await say(token, 'message 10');
        expect(eleventh.statusCode).toBe(429);
        expect(eleventh.headers['retry-after']).toBeTruthy();
        expect(mockAdded).toHaveLength(10);
    });
});
