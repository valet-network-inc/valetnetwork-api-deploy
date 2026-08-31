/**
 * The Firestore `users/{firebaseUid}` document, as a push channel.
 *
 * The apps keep a copy of the FCM token there (`NotificationService
 * .updateUserFCMToken` writes `{ fcmToken, createdAt }`), and several places
 * read it: `notifyClosestValets` falls back to it when Mongo has no active
 * token, and `sendNotification` reads it to resolve a recipient.
 *
 * Only the phone apps ever create that document. A customer who signs up on
 * the WEB therefore has no document at all — and the shipped valet build reads
 * the token as `userDoc.data().fcmToken`, unguarded. On a missing document
 * `.data()` is `undefined`, so that line throws a TypeError. In the valet's
 * accept flow the throw escapes into the one catch that wraps BOTH the accept
 * call and the notification, and the valet is told "Failed to accept order"
 * for a job the server accepted 120ms earlier. Confirmed live on order
 * 6a95821dbea3d616e27aa833, 2026-08-31.
 *
 * The app-side fix is a `?.` and a separate try/catch, and it is written — but
 * it only helps once a build ships. Making sure the document EXISTS fixes the
 * builds already on phones, because the shipped code then reads
 * `fcmToken: null`, posts a tokenless payload to `/api/notification/send`,
 * and that endpoint already answers a missing token with 200 /
 * `delivered: false` rather than an error. Nothing is sent, and nothing throws.
 *
 * A placeholder is exactly that: `fcmToken: null` means "no push channel", and
 * `updateUserFCMToken` overwrites it the moment a real device registers.
 */

const admin = require('firebase-admin');

const PLACEHOLDER_SOURCE = 'backend-compat-shim';

/**
 * Make sure `users/{firebaseUid}` exists. Never overwrites a live token, never
 * throws — a push channel that can't be prepared must not fail the caller's
 * real work (login, in practice).
 *
 * Returns 'created' | 'exists' | 'skipped' | 'failed' for the caller to log.
 */
const ensurePushChannelDoc = async (firebaseUid) => {
    if (!firebaseUid || typeof firebaseUid !== 'string') return 'skipped';

    try {
        const ref = admin.firestore().collection('users').doc(firebaseUid);
        const snap = await ref.get();
        if (snap.exists) return 'exists';

        // `create` rather than `set`: if a device registered a real token
        // between the read and here, let it lose the race loudly and keep the
        // token instead of quietly stamping null over it.
        await ref.create({
            fcmToken: null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdBy: PLACEHOLDER_SOURCE,
        });
        return 'created';
    } catch (err) {
        // ALREADY_EXISTS (code 6) is the race above, and it is the good
        // outcome — someone else wrote the document first.
        if (err && (err.code === 6 || err.code === 'already-exists')) {
            return 'exists';
        }
        console.error(
            'ensurePushChannelDoc failed for',
            firebaseUid,
            '-',
            err.message
        );
        return 'failed';
    }
};

module.exports = { ensurePushChannelDoc, PLACEHOLDER_SOURCE };
