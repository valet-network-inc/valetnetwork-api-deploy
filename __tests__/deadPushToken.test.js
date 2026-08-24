/**
 * A dead recipient token used to take the valet's whole action down with it.
 *
 * The valet app reads the customer's FCM token out of the Firestore user doc,
 * which can be months stale, and posts it to POST /api/notification/send. When
 * APNs had retired that token Firebase threw `messaging/invalid-argument:
 * APNs device token is disabled.`, the controller answered 500, and the app —
 * which treats any push failure as failure of the surrounding action — never
 * wrote the arrival message, never set the arrival flag, and never minted the
 * key OTP. "Notify Arrival" showed the valet an unexplained error 500 while
 * the customer's phone sat there perfectly reachable on a newer token.
 *
 * A dead handset is the recipient's condition, not our outage.
 */

const mockSent = [];
let mockFailFor = new Set();
let mockTokenDocs = [];
const mockUpdates = [];

jest.mock('firebase-admin', () => ({
    messaging: () => ({
        send: async (message) => {
            if (mockFailFor.has(message.token)) {
                const err = new Error('APNs device token is disabled.');
                err.code = 'messaging/invalid-argument';
                throw err;
            }
            mockSent.push(message);
            return 'projects/test/messages/1';
        },
    }),
}));

jest.mock('../models/FCMToken', () => ({
    find: (query) => {
        const matches = mockTokenDocs.filter(
            (t) =>
                t.firebaseUid === query.firebaseUid &&
                t.isActive &&
                t.token !== query.token.$ne
        );
        // Mirrors a mongoose query: chainable, and awaitable at the end.
        return {
            sort: () => Promise.resolve(matches),
            then: (resolve) => resolve(matches),
        };
    },
    findOneAndUpdate: async (query, update) => {
        const doc = mockTokenDocs.find((t) => t.token === query.token);
        if (!doc) return null;
        Object.assign(doc, update);
        return doc;
    },
    updateOne: async (query, update) => {
        mockUpdates.push({ id: query._id, update });
        const doc = mockTokenDocs.find((t) => t._id === query._id);
        if (doc) Object.assign(doc, update);
        return {};
    },
}));
jest.mock('../models/User', () => ({}));
jest.mock('../models/Order', () => ({}));

const { sendNotification } = require('../controllers/notificationController');

const call = async (body) => {
    let payload;
    let code;
    const res = {
        status(c) {
            code = c;
            return this;
        },
        json(p) {
            payload = p;
            return this;
        },
    };
    await sendNotification({ body }, res);
    return { code, payload };
};

beforeEach(() => {
    mockSent.length = 0;
    mockUpdates.length = 0;
    mockFailFor = new Set(['stale-token']);
    mockTokenDocs = [
        {
            _id: 'tok-old',
            token: 'stale-token',
            firebaseUid: 'uid-1',
            isActive: true,
        },
        {
            _id: 'tok-new',
            token: 'live-token',
            firebaseUid: 'uid-1',
            isActive: true,
        },
    ];
});

describe('POST /api/notification/send with a dead token', () => {
    it('delivers on the recipient\'s other registered device', async () => {
        const { code, payload } = await call({
            token: 'stale-token',
            title: 'Your Car Has Arrived!',
            body: 'Rishi is here with your car.',
        });

        expect(code).toBe(200);
        expect(payload.success).toBe(true);
        expect(payload.delivered).toBe(true);
        expect(payload.usedFallbackToken).toBe(true);
        expect(mockSent).toHaveLength(1);
        expect(mockSent[0].token).toBe('live-token');
    });

    it('retires the dead token so it is not tried again', async () => {
        await call({ token: 'stale-token', title: 'T', body: 'B' });
        expect(mockTokenDocs.find((t) => t._id === 'tok-old').isActive).toBe(false);
    });

    it('still answers 200 when every device is dead — a valet action must not abort', async () => {
        mockFailFor = new Set(['stale-token', 'live-token']);

        const { code, payload } = await call({
            token: 'stale-token',
            title: 'T',
            body: 'B',
        });

        expect(code).toBe(200);
        expect(payload.success).toBe(true);
        expect(payload.delivered).toBe(false);
        expect(payload.reason).toBe('no-live-device');
        expect(mockSent).toHaveLength(0);
    });

    it('reports undelivered rather than throwing when the token is unknown to us', async () => {
        mockTokenDocs = [];

        const { code, payload } = await call({
            token: 'stale-token',
            title: 'T',
            body: 'B',
        });

        expect(code).toBe(200);
        expect(payload.delivered).toBe(false);
        expect(payload.reason).toBe('token-unregistered');
    });
});

describe('POST /api/notification/send otherwise', () => {
    it('sends straight through on a live token', async () => {
        const { code, payload } = await call({
            token: 'live-token',
            title: 'T',
            body: 'B',
        });

        expect(code).toBe(200);
        expect(payload.delivered).toBe(true);
        expect(payload.usedFallbackToken).toBeUndefined();
        expect(mockSent[0].token).toBe('live-token');
    });

    it('keeps the 500 for a real server fault', async () => {
        const { sendNotification: fresh } = require('../controllers/notificationController');
        const admin = require('firebase-admin');
        const original = admin.messaging;
        admin.messaging = () => ({
            send: async () => {
                const err = new Error('credential is not valid');
                err.code = 'app/invalid-credential';
                throw err;
            },
        });

        let code;
        let payload;
        await fresh(
            { body: { token: 'live-token', title: 'T', body: 'B' } },
            {
                status(c) {
                    code = c;
                    return this;
                },
                json(p) {
                    payload = p;
                    return this;
                },
            }
        );

        admin.messaging = original;
        expect(code).toBe(500);
        expect(payload.success).toBe(false);
    });
});
