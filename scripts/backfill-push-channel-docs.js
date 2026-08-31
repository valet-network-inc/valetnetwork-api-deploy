/**
 * Give every existing account a Firestore `users/{firebaseUid}` document.
 *
 * `loginUser` now prepares one on every login, but that only reaches an account
 * the next time somebody signs in. Until then, the shipped valet build still
 * reads `userDoc.data().fcmToken` unguarded against a missing document and
 * throws — which surfaces to the valet as "Failed to accept order" on a job the
 * server has already accepted. See `services/pushChannel.js` for the full
 * story; this closes the gap for accounts already in the database.
 *
 * Creates only where nothing exists. A live token is never touched: the write
 * is `create`, so an account that gained a real token between the read and the
 * write loses the race and keeps its token.
 *
 *   MONGO_URI=... FIREBASE_SERVICE_ACCOUNT_JSON=... node scripts/backfill-push-channel-docs.js --dry-run
 *   MONGO_URI=... FIREBASE_SERVICE_ACCOUNT_JSON=... node scripts/backfill-push-channel-docs.js
 */

const dotenv = require('dotenv');
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });
const mongoose = require('mongoose');
const admin = require('firebase-admin');

const DRY_RUN = process.argv.includes('--dry-run');

(async () => {
    const uri = process.env.MONGO_URI;
    if (!uri) {
        console.error('MONGO_URI missing');
        process.exit(1);
    }
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(
                JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
            ),
        });
    }

    await mongoose.connect(uri);
    const User = require('../models/User');
    const { ensurePushChannelDoc } = require('../services/pushChannel');

    const users = await User.find({
        firebaseUid: { $exists: true, $ne: null, $ne: '' },
    })
        .select('firebaseUid phone signupPlatform isValet')
        .lean();

    console.log(`${users.length} accounts carry a firebaseUid`);

    const tally = { created: 0, exists: 0, failed: 0, skipped: 0 };
    for (const u of users) {
        if (DRY_RUN) {
            const snap = await admin
                .firestore()
                .collection('users')
                .doc(u.firebaseUid)
                .get();
            const outcome = snap.exists ? 'exists' : 'created';
            tally[outcome] += 1;
            if (!snap.exists) {
                console.log(
                    `  would create for ${u.firebaseUid} (${u.phone}, ${u.signupPlatform || 'unknown'})`
                );
            }
            continue;
        }
        const outcome = await ensurePushChannelDoc(u.firebaseUid);
        tally[outcome] += 1;
        if (outcome === 'created') {
            console.log(
                `  created for ${u.firebaseUid} (${u.phone}, ${u.signupPlatform || 'unknown'})`
            );
        }
    }

    console.log(DRY_RUN ? 'DRY RUN —' : 'Done —', JSON.stringify(tally));
    await mongoose.disconnect();
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
