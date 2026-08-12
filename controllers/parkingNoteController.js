/**
 * parkingNoteController
 *
 * Required structured capture of parking rules at the moment a valet
 * completes a park. Pairs with a sign photo in Firebase Storage. The
 * dataset accumulated here is what build 12's smart-placement algorithm
 * queries to refuse (or warn about) parking that would conflict with a
 * customer's stated duration.
 *
 * Endpoints:
 *   POST /api/order/:orderId/parking-note
 *     multipart "signPhoto" + JSON-encoded "rules" field shaped like:
 *       {
 *         streetCleaning: [{ day, startTime, endTime }],
 *         meterMaxMinutes: number | null,
 *         noParkWindows:   [{ day, startTime, endTime }],
 *         notes:           string,
 *       }
 *
 *   GET /api/order/:orderId/parking-note
 *     Returns the saved note for the order (or null), with a fresh
 *     signed URL for the sign photo.
 *
 *   GET /api/parking-notes/near?lat=X&lng=Y&radiusMeters=120
 *     Build 12 placement queries. Returns notes whose lat/lng falls in
 *     a coarse bounding box around the requested point, then app-side
 *     haversine filters to the exact radius.
 */

const path = require('path');
const crypto = require('crypto');

const Order = require('../models/Order');
const ParkingNote = require('../models/ParkingNote');
const firebaseStorage = require('../services/firebaseStorage');

const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/heic'];
const MAX_BYTES = 12 * 1024 * 1024;
const SIGNED_URL_MINUTES = 60 * 24 * 7;

const buildSignStoragePath = (orderId, mimeType, originalFilename) => {
    const ext =
        path.extname(originalFilename || '').toLowerCase() ||
        (mimeType === 'image/png' ? '.png' : '.jpg');
    const random = crypto.randomBytes(6).toString('hex');
    return `parking-notes/${orderId}/${Date.now()}-${random}${ext}`;
};

// Tolerate either a JSON-string or already-parsed object on the multipart
// "rules" field — multer doesn't auto-parse JSON form fields.
const parseRules = (raw) => {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
};

const sanitizeWindowList = (list) => {
    if (!Array.isArray(list)) return [];
    return list
        .filter(
            (w) =>
                w &&
                typeof w.day === 'number' &&
                w.day >= 0 &&
                w.day <= 6 &&
                typeof w.startTime === 'string' &&
                typeof w.endTime === 'string'
        )
        .map((w) => ({
            day: w.day,
            startTime: w.startTime,
            endTime: w.endTime,
        }));
};

/**
 * POST /api/order/:orderId/parking-note
 */
exports.createParkingNote = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { valetId, rules: rawRules } = req.body;
        const file = req.file;

        if (!orderId || !valetId || !file) {
            return res.status(400).json({
                success: false,
                message: 'orderId, valetId, and a sign-photo file are required.',
            });
        }
        if (!ACCEPTED_MIME_TYPES.includes((file.mimetype || '').toLowerCase())) {
            return res.status(400).json({
                success: false,
                message: 'Unsupported file type. Accepted: JPEG, PNG, HEIC.',
            });
        }
        if ((file.size || 0) > MAX_BYTES) {
            return res.status(400).json({
                success: false,
                message: `Sign photo too large. Max ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`,
            });
        }

        const order = await Order.findById(orderId);
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }
        // The valet recording the note must be the order's assigned valet.
        const orderValetId = order.valet?._id?.toString() || order.valet?.toString();
        if (orderValetId && orderValetId !== valetId) {
            return res.status(403).json({
                success: false,
                message: 'Only the assigned valet on this order may record parking notes.',
            });
        }

        const rules = parseRules(rawRules);
        const streetCleaning = sanitizeWindowList(rules.streetCleaning);
        const noParkWindows = sanitizeWindowList(rules.noParkWindows);
        const meterMaxMinutes =
            typeof rules.meterMaxMinutes === 'number' && rules.meterMaxMinutes >= 0
                ? rules.meterMaxMinutes
                : undefined;
        const notes = typeof rules.notes === 'string' ? rules.notes.trim() : '';

        // Mirror the parked location off the order so this dataset is
        // independently queryable by geo without a join.
        const parkingLocation = order.parkingLocation || {};
        if (
            typeof parkingLocation.lat !== 'number' ||
            typeof parkingLocation.lng !== 'number'
        ) {
            return res.status(400).json({
                success: false,
                message:
                    'Parking location must be set on the order before recording a parking note.',
            });
        }

        const storagePath = buildSignStoragePath(orderId, file.mimetype, file.originalname);
        const { bucket } = await firebaseStorage.uploadFile(
            file.buffer,
            storagePath,
            file.mimetype
        );

        // Upsert: re-recording on the same order overwrites the previous
        // note. Cheaper than versioning for the build-11 use case; if we
        // ever need an audit trail we'll add a `ParkingNoteHistory` table.
        const note = await ParkingNote.findOneAndUpdate(
            { order: orderId },
            {
                order: orderId,
                valet: valetId,
                location: {
                    lat: parkingLocation.lat,
                    lng: parkingLocation.lng,
                    streetAddress: parkingLocation.streetAddress,
                },
                signPhotoBucket: bucket,
                signPhotoStoragePath: storagePath,
                signPhotoMimeType: file.mimetype,
                streetCleaning,
                meterMaxMinutes,
                noParkWindows,
                notes,
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        const signPhotoUrl = await firebaseStorage.getSignedUrl(
            storagePath,
            SIGNED_URL_MINUTES
        );

        return res.json({
            success: true,
            parkingNote: {
                id: note._id,
                location: note.location,
                signPhotoUrl,
                streetCleaning: note.streetCleaning,
                meterMaxMinutes: note.meterMaxMinutes,
                noParkWindows: note.noParkWindows,
                notes: note.notes,
                createdAt: note.createdAt,
                updatedAt: note.updatedAt,
            },
        });
    } catch (err) {
        console.error('createParkingNote error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to save parking note.',
        });
    }
};

/**
 * GET /api/order/:orderId/parking-note
 */
exports.getParkingNoteForOrder = async (req, res) => {
    try {
        const { orderId } = req.params;
        const note = await ParkingNote.findOne({ order: orderId }).lean();
        if (!note) {
            return res.json({ success: true, parkingNote: null });
        }

        const signPhotoUrl = await firebaseStorage.getSignedUrl(
            note.signPhotoStoragePath,
            SIGNED_URL_MINUTES
        );

        return res.json({
            success: true,
            parkingNote: {
                id: note._id,
                location: note.location,
                signPhotoUrl,
                streetCleaning: note.streetCleaning,
                meterMaxMinutes: note.meterMaxMinutes,
                noParkWindows: note.noParkWindows,
                notes: note.notes,
                createdAt: note.createdAt,
                updatedAt: note.updatedAt,
            },
        });
    } catch (err) {
        console.error('getParkingNoteForOrder error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to load parking note.',
        });
    }
};

/**
 * GET /api/parking-notes/near?lat=X&lng=Y&radiusMeters=N
 *
 * Used by build 12 placement logic. We use a coarse bounding-box prefilter
 * on the indexed lat/lng pair, then an app-side haversine to enforce the
 * exact radius.
 */
exports.getParkingNotesNear = async (req, res) => {
    try {
        const lat = parseFloat(req.query.lat);
        const lng = parseFloat(req.query.lng);
        const radiusMeters = Math.min(
            parseFloat(req.query.radiusMeters) || 150,
            1000  // cap: this isn't a discovery API, it's a placement-context lookup
        );

        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return res.status(400).json({
                success: false,
                message: 'Valid lat and lng query params are required.',
            });
        }

        // Bounding box ~ radius. 1 degree latitude ≈ 111 km. Longitude
        // shrinks with latitude — for NYC (≈40.75°) cos(lat) ≈ 0.756.
        const dLat = radiusMeters / 111000;
        const dLng = radiusMeters / (111000 * Math.cos((lat * Math.PI) / 180));
        const candidates = await ParkingNote.find({
            'location.lat': { $gte: lat - dLat, $lte: lat + dLat },
            'location.lng': { $gte: lng - dLng, $lte: lng + dLng },
        }).lean();

        // Haversine to enforce true distance and sort nearest-first.
        const haversine = (a, b) => {
            const R = 6371000;
            const toRad = (d) => (d * Math.PI) / 180;
            const dLatR = toRad(b.lat - a.lat);
            const dLngR = toRad(b.lng - a.lng);
            const aa =
                Math.sin(dLatR / 2) ** 2 +
                Math.cos(toRad(a.lat)) *
                    Math.cos(toRad(b.lat)) *
                    Math.sin(dLngR / 2) ** 2;
            return 2 * R * Math.asin(Math.min(1, Math.sqrt(aa)));
        };

        const enriched = candidates
            .map((n) => ({
                note: n,
                distanceMeters: haversine(
                    { lat, lng },
                    { lat: n.location.lat, lng: n.location.lng }
                ),
            }))
            .filter((x) => x.distanceMeters <= radiusMeters)
            .sort((a, b) => a.distanceMeters - b.distanceMeters);

        return res.json({
            success: true,
            count: enriched.length,
            parkingNotes: enriched.map((x) => ({
                id: x.note._id,
                distanceMeters: Math.round(x.distanceMeters),
                location: x.note.location,
                streetCleaning: x.note.streetCleaning,
                meterMaxMinutes: x.note.meterMaxMinutes,
                noParkWindows: x.note.noParkWindows,
                notes: x.note.notes,
                createdAt: x.note.createdAt,
            })),
        });
    } catch (err) {
        console.error('getParkingNotesNear error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to query parking notes.',
        });
    }
};

/**
 * Admin: list all parking-rule sign photos for the dashboard "Street
 * parking rules" tab. Returns one row per ParkingNote with a photo,
 * including location + signed URL + days-until-expiry.
 *
 * GET /api/admin/parking-rule-photos?limit=&skip=
 */
exports.adminListParkingRulePhotos = async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const skip = parseInt(req.query.skip, 10) || 0;

        const notes = await ParkingNote.find({
            signPhotoStoragePath: { $exists: true, $ne: null },
        })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('valet', 'firstName lastName')
            .lean();

        const SIGNED_MIN = 60 * 24 * 7;
        const rows = await Promise.all(
            notes.map(async (n) => ({
                id: n._id,
                source: 'parking-note',
                location: n.location,
                streetAddress: n.location?.streetAddress || '',
                valetName: `${n.valet?.firstName || ''} ${n.valet?.lastName || ''}`.trim(),
                streetCleaning: n.streetCleaning,
                meterMaxMinutes: n.meterMaxMinutes,
                noParkWindows: n.noParkWindows,
                notes: n.notes,
                viewUrl: await firebaseStorage.getSignedUrl(
                    n.signPhotoStoragePath,
                    SIGNED_MIN
                ),
                capturedAt: n.createdAt,
                expiresAt: n.signPhotoExpiresAt,
            }))
        );

        return res.json({ success: true, rows, count: rows.length });
    } catch (err) {
        console.error('adminListParkingRulePhotos error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to list parking-rule photos.',
        });
    }
};

/**
 * Admin: delete a single ParkingNote's sign photo immediately.
 * Keeps the rule data (street cleaning, meter, etc.) intact — just
 * wipes the photo bytes + pointer.
 *
 * DELETE /api/admin/parking-rule-photo/:id
 */
exports.adminDeleteParkingRulePhoto = async (req, res) => {
    try {
        const { id } = req.params;
        const note = await ParkingNote.findById(id);
        if (!note || !note.signPhotoStoragePath) {
            return res
                .status(404)
                .json({ success: false, message: 'Photo not found.' });
        }
        try {
            await firebaseStorage.deleteFile(note.signPhotoStoragePath);
        } catch (storageErr) {
            console.warn(
                `adminDeleteParkingRulePhoto: storage delete failed for ${note.signPhotoStoragePath}: ${storageErr.message}`
            );
        }
        note.signPhotoBucket = undefined;
        note.signPhotoStoragePath = undefined;
        note.signPhotoMimeType = undefined;
        note.signPhotoExpiresAt = undefined;
        await note.save();
        return res.json({ success: true });
    } catch (err) {
        console.error('adminDeleteParkingRulePhoto error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to delete parking-rule photo.',
        });
    }
};
