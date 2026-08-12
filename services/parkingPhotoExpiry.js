/**
 * Parking photo expiry sweep.
 *
 * 30-day hard delete policy for:
 *   - OrderPhoto (pre_pickup / post_park) — entire row + bytes
 *   - ParkingNote.signPhoto* — clears the photo fields, keeps the rule row
 *     (we still want the structured parking rules for the heat-map dataset)
 *   - StreetParkingMark.details.signPhoto* — same pattern
 *
 * Idempotent. Safe to re-run. Logs counts.
 */

const OrderPhoto = require('../models/OrderPhoto');
const ParkingNote = require('../models/ParkingNote');
const StreetParkingMark = require('../models/StreetParkingMark');
const firebaseStorage = require('../services/firebaseStorage');

const BATCH_LIMIT = 500;

const deleteStorageQuiet = async (storagePath) => {
    if (!storagePath) return;
    try {
        await firebaseStorage.deleteFile(storagePath);
    } catch (err) {
        // Object-not-found is fine — the row could have been partially
        // cleaned in a prior run. Anything else is worth logging.
        const msg = err?.message || '';
        if (!/No such object|not.*found/i.test(msg)) {
            console.warn(
                `parkingPhotoExpiry: storage delete failed for ${storagePath}: ${msg}`
            );
        }
    }
};

const sweepOrderPhotos = async () => {
    const now = new Date();
    const expired = await OrderPhoto.find({ expiresAt: { $lte: now } })
        .limit(BATCH_LIMIT)
        .lean();
    if (expired.length === 0) return 0;

    for (const p of expired) {
        await deleteStorageQuiet(p.storagePath);
    }
    await OrderPhoto.deleteMany({
        _id: { $in: expired.map((p) => p._id) },
    });
    return expired.length;
};

const sweepParkingNotes = async () => {
    const now = new Date();
    const expired = await ParkingNote.find({
        signPhotoExpiresAt: { $lte: now },
        signPhotoStoragePath: { $exists: true, $ne: null },
    })
        .limit(BATCH_LIMIT)
        .lean();
    if (expired.length === 0) return 0;

    for (const n of expired) {
        await deleteStorageQuiet(n.signPhotoStoragePath);
    }
    await ParkingNote.updateMany(
        { _id: { $in: expired.map((n) => n._id) } },
        {
            $unset: {
                signPhotoBucket: '',
                signPhotoStoragePath: '',
                signPhotoMimeType: '',
                signPhotoExpiresAt: '',
            },
        }
    );
    return expired.length;
};

const sweepStreetParkingMarks = async () => {
    const now = new Date();
    const expired = await StreetParkingMark.find({
        'details.signPhotoExpiresAt': { $lte: now },
        'details.signPhotoStoragePath': { $exists: true, $ne: null },
    })
        .limit(BATCH_LIMIT)
        .lean();
    if (expired.length === 0) return 0;

    for (const m of expired) {
        await deleteStorageQuiet(m.details?.signPhotoStoragePath);
    }
    await StreetParkingMark.updateMany(
        { _id: { $in: expired.map((m) => m._id) } },
        {
            $unset: {
                'details.signPhotoBucket': '',
                'details.signPhotoStoragePath': '',
                'details.signPhotoMimeType': '',
                'details.signPhotoExpiresAt': '',
            },
        }
    );
    return expired.length;
};

/**
 * Run one expiry sweep. Returns counts per source.
 */
exports.runOnce = async () => {
    const [orders, notes, marks] = await Promise.all([
        sweepOrderPhotos(),
        sweepParkingNotes(),
        sweepStreetParkingMarks(),
    ]);
    if (orders + notes + marks > 0) {
        console.log(
            `parkingPhotoExpiry: deleted ${orders} order photos, ${notes} parking-note photos, ${marks} street-mark photos`
        );
    }
    return { orders, notes, marks };
};

/**
 * Register the cron — once per night at ~3am server time. Avoids the
 * heavy-traffic windows. setInterval rather than node-cron to keep
 * dependencies minimal — process restarts re-anchor the schedule, which
 * is fine for a daily sweep.
 */
exports.start = () => {
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    // Fire first run 1 hour after boot so a fresh deploy still gets a
    // sweep without waiting until tomorrow.
    setTimeout(() => {
        exports.runOnce().catch((err) =>
            console.error('parkingPhotoExpiry initial run failed:', err)
        );
        setInterval(() => {
            exports.runOnce().catch((err) =>
                console.error('parkingPhotoExpiry tick failed:', err)
            );
        }, ONE_DAY_MS);
    }, 60 * 60 * 1000);
    console.log('parkingPhotoExpiry cron registered (daily)');
};
