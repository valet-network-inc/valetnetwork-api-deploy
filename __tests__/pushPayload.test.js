/**
 * The push payload itself.
 *
 * Two bugs lived here and both were invisible from the outside — a push still
 * "sent successfully" while doing the wrong thing on the handset:
 *
 *   1. `content-available: 1` alongside an alert payload woke the app in the
 *      background, and the app drew its OWN banner with notifee on top of the
 *      one iOS had already shown. One send, two notifications, two sounds.
 *   2. adminNotificationController passed `sound` as a sixth argument to a
 *      five-argument function, so the dashboard's sound picker was dropped and
 *      every push used the default chime.
 *
 * These assert the built message rather than the return value, because the
 * return value was always success.
 */

const sent = [];

jest.mock('firebase-admin', () => ({
    messaging: () => ({
        send: async (message) => {
            sent.push(message);
            return 'projects/test/messages/1';
        },
    }),
}));

jest.mock('../models/FCMToken', () => ({
    find: async () => [{ _id: 'tok1', token: 'device-token-1', deviceId: 'd1' }],
    updateOne: async () => ({}),
}));
jest.mock('../models/User', () => ({}));
jest.mock('../models/Order', () => ({}));

const { sendPushNotification } = require('../controllers/notificationController');

const apsOf = (message) => message.apns.payload.aps;

beforeEach(() => {
    sent.length = 0;
});

describe('the APNs payload', () => {
    it('does not ask iOS to wake the app — that is what double-banners it', async () => {
        await sendPushNotification('uid-1', 'Title', 'Body');
        expect(sent).toHaveLength(1);
        expect(apsOf(sent[0])).not.toHaveProperty('content-available');
    });

    it('rings the valet bell instead of the system chime', async () => {
        await sendPushNotification('uid-1', 'Title', 'Body');
        expect(apsOf(sent[0]).sound).toBe('valet-bell.caf');
    });

    it('honours a sound passed as the sixth argument', async () => {
        await sendPushNotification('uid-1', 'Title', 'Body', {}, null, 'default');
        expect(apsOf(sent[0]).sound).toBe('default');
    });

    it('still carries the alert so iOS displays it with the app closed', async () => {
        await sendPushNotification('uid-1', 'Title', 'Body');
        expect(sent[0].notification).toEqual({ title: 'Title', body: 'Body' });
        expect(apsOf(sent[0]).alert).toEqual({ title: 'Title', body: 'Body' });
    });

    it('passes data through as strings so deep links survive', async () => {
        await sendPushNotification('uid-1', 'T', 'B', {
            screen_name: 'ProfileScreen',
            view: 'subscription',
        });
        expect(sent[0].data).toEqual({
            screen_name: 'ProfileScreen',
            view: 'subscription',
        });
    });
});
