/**
 * A customer with no push channel must not read as a broken accept.
 * Run: npx jest pushChannel
 *
 * The valet app reads the customer's token out of Firestore `users/{uid}` and,
 * on the shipped build, reads it unguarded: `userDoc.data().fcmToken`. Only the
 * phone apps ever create that document, so a WEB signup has none, `.data()` is
 * undefined, and the read throws. In the accept flow that throw escaped into
 * the one catch wrapping both the accept and the notification, and the valet
 * was shown "Failed to accept order" for a job the server had accepted 120ms
 * earlier — order 6a95821dbea3d616e27aa833, 2026-08-31.
 *
 * The app-side guard is written but only helps once a build ships. What fixes
 * the builds already on phones is the two halves tested here:
 *
 *  1. the document always EXISTS, so the shipped read yields `null` instead of
 *     throwing, and
 *  2. `POST /api/notification/send` answers a tokenless payload with
 *     200 / `success: true` / `delivered: false` — so the app's
 *     `if (!data.success) throw` never fires either.
 */

let mockDocs = {};
const mockCreates = [];

const alreadyExists = () => {
    const err = new Error('Document already exists');
    err.code = 6;
    return err;
};

let mockFirestoreThrows = null;

jest.mock('firebase-admin', () => {
    const FieldValue = { serverTimestamp: () => '<server-timestamp>' };
    const firestore = () => ({
        collection: (name) => ({
            doc: (id) => ({
                get: async () => {
                    if (mockFirestoreThrows) throw mockFirestoreThrows;
                    const key = `${name}/${id}`;
                    return {
                        exists: Object.prototype.hasOwnProperty.call(mockDocs, key),
                        data: () => mockDocs[key],
                    };
                },
                create: async (payload) => {
                    const key = `${name}/${id}`;
                    if (Object.prototype.hasOwnProperty.call(mockDocs, key)) {
                        throw alreadyExists();
                    }
                    mockDocs[key] = payload;
                    mockCreates.push({ key, payload });
                    return {};
                },
            }),
        }),
    });
    firestore.FieldValue = FieldValue;
    return { firestore, messaging: () => ({ send: async () => 'msg-1' }) };
});

const { ensurePushChannelDoc, PLACEHOLDER_SOURCE } = require('../services/pushChannel');
const notificationController = require('../controllers/notificationController');

const mockRes = () => {
    const res = {};
    res.statusCode = 200;
    res.body = null;
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
};

const WEB_UID = '28uNkgBXPYaVM5zSY88wvkTcaNJ3';

beforeEach(() => {
    mockDocs = {};
    mockCreates.length = 0;
    mockFirestoreThrows = null;
});

describe('preparing the push channel', () => {
    test('a web signup with no document gets one, holding a null token', async () => {
        expect(await ensurePushChannelDoc(WEB_UID)).toBe('created');

        const doc = mockDocs[`users/${WEB_UID}`];
        expect(doc).toBeTruthy();
        // The shipped build reads `.data().fcmToken`. With the document
        // present that is `null` — falsy, and crucially not a throw.
        expect(doc.fcmToken).toBeNull();
        expect(doc.createdBy).toBe(PLACEHOLDER_SOURCE);
    });

    test('an existing document is left exactly as it was', async () => {
        mockDocs[`users/${WEB_UID}`] = { fcmToken: 'a-real-live-token' };

        expect(await ensurePushChannelDoc(WEB_UID)).toBe('exists');

        expect(mockDocs[`users/${WEB_UID}`].fcmToken).toBe('a-real-live-token');
        expect(mockCreates).toHaveLength(0);
    });

    test('a device that registers mid-write keeps its token', async () => {
        // `create` throws ALREADY_EXISTS rather than stamping null over it.
        mockDocs[`users/${WEB_UID}`] = { fcmToken: 'registered-a-moment-ago' };
        const ref = require('firebase-admin').firestore().collection('users').doc(WEB_UID);
        await expect(ref.create({ fcmToken: null })).rejects.toThrow(/already exists/i);
        expect(mockDocs[`users/${WEB_UID}`].fcmToken).toBe('registered-a-moment-ago');
    });

    test('a Firestore outage is reported, never thrown — login must not fail', async () => {
        mockFirestoreThrows = new Error('DEADLINE_EXCEEDED');

        await expect(ensurePushChannelDoc(WEB_UID)).resolves.toBe('failed');
    });

    test('no uid is nothing to do', async () => {
        expect(await ensurePushChannelDoc(null)).toBe('skipped');
        expect(await ensurePushChannelDoc('')).toBe('skipped');
        expect(mockCreates).toHaveLength(0);
    });
});

describe('the contract the shipped build depends on', () => {
    test('a tokenless send is answered 200 / success / not delivered', async () => {
        // What the shipped valet app posts once `fcmToken` reads null.
        const req = { body: { title: 'Order Accepted', body: 'Your order has been accepted by a valet' } };
        const res = mockRes();

        await notificationController.sendNotification(req, res);

        expect(res.statusCode).toBe(200);
        // The app throws on `!data.success`, so this flag is the whole point.
        expect(res.body.success).toBe(true);
        expect(res.body.delivered).toBe(false);
        expect(res.body.reason).toBe('no-token-supplied');
    });
});
