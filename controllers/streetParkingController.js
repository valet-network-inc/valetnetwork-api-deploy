/**
 * Street parking heat-map controller.
 *
 * Endpoints:
 *   GET    /api/street-parking?minLat=&maxLat=&minLng=&maxLng=
 *     Marks whose midpoint falls in the viewport bbox. Cap 500.
 *   POST   /api/street-parking
 *     Create a new mark. Body: { valetId, street, crossStreet1?,
 *     crossStreet2?, side, endpoint1, endpoint2, level, details? }.
 *   PUT    /api/street-parking/:id
 *     Patch the mark (typically used to attach details after creation).
 *   DELETE /api/street-parking/:id
 *
 * No JWT yet — mirrors the existing trust model on other valet-write
 * routes. Caller must supply valetId.
 */

const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

const StreetParkingMark = require('../models/StreetParkingMark');
const StreetSegmentReport = require('../models/StreetSegmentReport');
const firebaseStorage = require('../services/firebaseStorage');
const streetSegmentResolver = require('../services/streetSegmentResolver');

// Consensus thresholds for the verified-segment tier.
//   - 5+ marks at the same (street, cs1, cs2, side, level) → verified
//   - 2+ distinct reports → flips verified back to false
// Tweak in one place if business rules change.
const VERIFY_THRESHOLD = 5;
const UNVERIFY_REPORT_THRESHOLD = 2;

// Canonical segment key — used to dedupe marks + report rows.
// Lowercased + trimmed to absorb minor naming differences ("5th Ave" vs
// "5th avenue") that Overpass + reverse-geocoding might emit.
const segmentKeyOf = ({ street, crossStreet1, crossStreet2, side }) => {
    const norm = (s) => (s || '').trim().toLowerCase();
    // Cross-streets are unordered (a block's two ends are symmetric), so
    // sort to make {A, B} and {B, A} map to the same key.
    const [c1, c2] = [norm(crossStreet1), norm(crossStreet2)].sort();
    return `${norm(street)}|${c1}|${c2}|${norm(side)}`;
};

const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/heic'];
const MAX_BYTES = 12 * 1024 * 1024;
const SIGNED_URL_MINUTES = 60 * 24 * 7;

const isFiniteCoord = (n) => Number.isFinite(n) && n >= -180 && n <= 180;

const midpointOf = (a, b) => ({
    lat: (a.lat + b.lat) / 2,
    lng: (a.lng + b.lng) / 2,
});

// Translate the segment perpendicular to the street so each side is
// visually distinct on the map. We use the valet's picked cardinal side
// rather than computing perpendicular geometrically — the cardinal label
// is what the valet meant, even if the street isn't axis-aligned.
const SIDE_OFFSET_METERS = 6;
const SIDE_VECTORS = {
    north: { dLat: 1, dLng: 0 },
    south: { dLat: -1, dLng: 0 },
    east: { dLat: 0, dLng: 1 },
    west: { dLat: 0, dLng: -1 },
    both: { dLat: 0, dLng: 0 },
};
const applySideOffset = (ep1, ep2, side) => {
    const v = SIDE_VECTORS[side] || SIDE_VECTORS.both;
    const dLat = (v.dLat * SIDE_OFFSET_METERS) / 111000;
    const dLng =
        (v.dLng * SIDE_OFFSET_METERS) /
        (111000 * Math.cos((ep1.lat * Math.PI) / 180));
    return {
        endpoint1: { lat: ep1.lat + dLat, lng: ep1.lng + dLng },
        endpoint2: { lat: ep2.lat + dLat, lng: ep2.lng + dLng },
    };
};

const parseDetails = (raw) => {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
};

/**
 * GET /api/street-parking/segments-near?lat=&lng=&radiusMeters=
 *
 * Returns the full set of tappable block-side polylines around a coord,
 * with current consensus level + verified status joined onto each from
 * the StreetParkingMark collection. This drives the new "tap a line"
 * UX — the valet sees every street side as a thin gray line, taps the
 * one they want to mark, and we already know which segment + side that
 * is (no more cardinal-direction picker).
 */
exports.segmentsNear = async (req, res) => {
    try {
        const lat = parseFloat(req.query.lat);
        const lng = parseFloat(req.query.lng);
        const radiusMeters = Math.min(
            parseFloat(req.query.radiusMeters) || 200,
            600
        );
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return res.status(400).json({
                success: false,
                message: 'lat and lng query params required',
            });
        }

        const segments = await streetSegmentResolver.resolveAreaSegments(
            { lat, lng },
            radiusMeters
        );

        // Attach segmentKey so mobile + backend share the same identity.
        const enriched = segments.map((s) => ({
            ...s,
            segmentKey: segmentKeyOf(s),
        }));

        // Fetch any marks whose segmentKey matches one of these segments.
        // Bbox-prefilter to keep the Mongo query cheap, then JS-filter on
        // the canonical segmentKey so we don't depend on string-case match
        // in Mongo.
        const wantedKeys = new Set(enriched.map((s) => s.segmentKey));
        const padding = (radiusMeters + 100) / 111000;
        const candidateMarks = await StreetParkingMark.find({
            'midpoint.lat': { $gte: lat - padding, $lte: lat + padding },
            'midpoint.lng': { $gte: lng - padding, $lte: lng + padding },
        })
            .limit(3000)
            .lean();
        const marksByKey = new Map();
        for (const m of candidateMarks) {
            const key = segmentKeyOf(m);
            if (!wantedKeys.has(key)) continue;
            if (!marksByKey.has(key)) marksByKey.set(key, []);
            marksByKey.get(key).push(m);
        }

        // Pull report counts for the segment keys we have marks for.
        const keysWithMarks = Array.from(marksByKey.keys());
        const reportAgg = keysWithMarks.length
            ? await StreetSegmentReport.aggregate([
                  { $match: { segmentKey: { $in: keysWithMarks } } },
                  { $group: { _id: { k: '$segmentKey', v: '$valet' } } },
                  { $group: { _id: '$_id.k', distinctReporters: { $sum: 1 } } },
              ])
            : [];
        const reportCountByKey = new Map(
            reportAgg.map((r) => [r._id, r.distinctReporters])
        );

        const result = enriched.map((s) => {
            const marks = marksByKey.get(s.segmentKey) || [];
            if (marks.length === 0) {
                return {
                    ...s,
                    level: null,
                    levelCounts: { easy: 0, moderate: 0, hard: 0, no_parking: 0 },
                    totalMarks: 0,
                    verified: false,
                    reportCount: 0,
                };
            }
            const levelCounts = { easy: 0, moderate: 0, hard: 0, no_parking: 0 };
            for (const m of marks) {
                if (levelCounts[m.level] !== undefined) levelCounts[m.level] += 1;
            }
            const majorityLevel = [
                'easy',
                'moderate',
                'hard',
                'no_parking',
            ].reduce(
                (best, lvl) =>
                    levelCounts[lvl] > levelCounts[best] ? lvl : best,
                'moderate'
            );
            const majorityCount = levelCounts[majorityLevel];
            const reportCount = reportCountByKey.get(s.segmentKey) || 0;
            const verified =
                majorityCount >= VERIFY_THRESHOLD &&
                reportCount < UNVERIFY_REPORT_THRESHOLD;
            return {
                ...s,
                level: majorityLevel,
                levelCounts,
                totalMarks: marks.length,
                verified,
                reportCount,
            };
        });

        return res.json({
            success: true,
            count: result.length,
            sideSegments: result,
        });
    } catch (err) {
        console.error('segmentsNear error:', err);
        return res
            .status(500)
            .json({ success: false, message: err.message || 'segmentsNear failed' });
    }
};

exports.listInBbox = async (req, res) => {
    try {
        const minLat = parseFloat(req.query.minLat);
        const maxLat = parseFloat(req.query.maxLat);
        const minLng = parseFloat(req.query.minLng);
        const maxLng = parseFloat(req.query.maxLng);

        if (![minLat, maxLat, minLng, maxLng].every(isFiniteCoord)) {
            return res.status(400).json({
                success: false,
                message: 'minLat, maxLat, minLng, maxLng query params required',
            });
        }
        if (minLat > maxLat || minLng > maxLng) {
            return res.status(400).json({
                success: false,
                message: 'min coords must be <= max coords',
            });
        }

        const marks = await StreetParkingMark.find({
            'midpoint.lat': { $gte: minLat, $lte: maxLat },
            'midpoint.lng': { $gte: minLng, $lte: maxLng },
        })
            .sort({ updatedAt: -1 })
            .limit(2000)
            .lean();

        // Aggregate raw marks → one "segment summary" per (street, cs1,
        // cs2, side). For each segment we pick the majority level and
        // attach verified status based on consensus count + report count.
        const segmentMap = new Map();
        for (const m of marks) {
            const key = segmentKeyOf(m);
            if (!segmentMap.has(key)) {
                segmentMap.set(key, {
                    key,
                    street: m.street,
                    crossStreet1: m.crossStreet1,
                    crossStreet2: m.crossStreet2,
                    side: m.side,
                    levelCounts: { easy: 0, moderate: 0, hard: 0, no_parking: 0 },
                    // Use the most-recent mark's geometry/details as the
                    // representative (marks were sorted updatedAt desc).
                    path:
                        Array.isArray(m.path) && m.path.length >= 2
                            ? m.path
                            : [m.endpoint1, m.endpoint2],
                    endpoint1: m.endpoint1,
                    endpoint2: m.endpoint2,
                    details: m.details,
                    representativeId: m._id,
                    latestAt: m.updatedAt,
                });
            }
            const seg = segmentMap.get(key);
            if (seg.levelCounts[m.level] !== undefined) {
                seg.levelCounts[m.level] += 1;
            }
        }

        // Bulk-fetch report counts for the segments we found.
        const segmentKeys = Array.from(segmentMap.keys());
        const reportAgg = segmentKeys.length
            ? await StreetSegmentReport.aggregate([
                  { $match: { segmentKey: { $in: segmentKeys } } },
                  // Distinct valets per segment (one report per valet).
                  { $group: { _id: { k: '$segmentKey', v: '$valet' } } },
                  { $group: { _id: '$_id.k', distinctReporters: { $sum: 1 } } },
              ])
            : [];
        const reportCountByKey = new Map(
            reportAgg.map((r) => [r._id, r.distinctReporters])
        );

        const segments = Array.from(segmentMap.values()).map((seg) => {
            const { levelCounts } = seg;
            const total =
                levelCounts.easy +
                levelCounts.moderate +
                levelCounts.hard +
                levelCounts.no_parking;
            const majorityLevel = ['easy', 'moderate', 'hard', 'no_parking'].reduce(
                (best, lvl) =>
                    levelCounts[lvl] > levelCounts[best] ? lvl : best,
                'moderate'
            );
            const majorityCount = levelCounts[majorityLevel];
            const reportCount = reportCountByKey.get(seg.key) || 0;
            const verified =
                majorityCount >= VERIFY_THRESHOLD &&
                reportCount < UNVERIFY_REPORT_THRESHOLD;
            return {
                segmentKey: seg.key,
                street: seg.street,
                crossStreet1: seg.crossStreet1,
                crossStreet2: seg.crossStreet2,
                side: seg.side,
                level: majorityLevel,
                levelCounts,
                totalMarks: total,
                verified,
                reportCount,
                path: seg.path,
                endpoint1: seg.endpoint1,
                endpoint2: seg.endpoint2,
                details: seg.details,
                representativeId: seg.representativeId,
                latestAt: seg.latestAt,
            };
        });

        return res.json({
            success: true,
            // Legacy clients reading `marks` get the unaggregated rows;
            // new clients reading `segments` get the aggregated view.
            count: marks.length,
            segments,
            marks: marks.map((m) => ({
                id: m._id,
                street: m.street,
                crossStreet1: m.crossStreet1,
                crossStreet2: m.crossStreet2,
                side: m.side,
                endpoint1: m.endpoint1,
                endpoint2: m.endpoint2,
                level: m.level,
                details: m.details,
                updatedAt: m.updatedAt,
            })),
        });
    } catch (err) {
        console.error('listInBbox error:', err);
        return res
            .status(500)
            .json({ success: false, message: err.message || 'List failed' });
    }
};

exports.create = async (req, res) => {
    try {
        const {
            valetId,
            street,
            crossStreet1 = '',
            crossStreet2 = '',
            side = 'both',
            endpoint1,
            endpoint2,
            level,
            details,
            tap,           // optional { lat, lng } — resolve via Overpass
            path: clientPath, // optional pre-computed polyline (from segments-near)
        } = req.body || {};

        if (!valetId || !mongoose.Types.ObjectId.isValid(valetId)) {
            return res
                .status(400)
                .json({ success: false, message: 'valid valetId required' });
        }
        if (!street || typeof street !== 'string') {
            return res
                .status(400)
                .json({ success: false, message: 'street required' });
        }
        if (!['easy', 'moderate', 'hard', 'no_parking'].includes(level)) {
            return res.status(400).json({
                success: false,
                message: 'level must be easy | moderate | hard | no_parking',
            });
        }
        if (!['side1', 'side2', 'both', 'north', 'south', 'east', 'west'].includes(side)) {
            return res.status(400).json({
                success: false,
                message: 'invalid side',
            });
        }

        // Three creation paths:
        //   1. New tap-on-line UX: client passes `path` directly (pulled
        //      from /segments-near, already perpendicular-offset). Skip
        //      Overpass entirely.
        //   2. Legacy tap-anywhere UX: client passes only `tap`; we
        //      resolve geometry server-side via Overpass.
        //   3. Hard fallback: client passes endpoint1/2 only.
        let resolvedPath = null;
        let resolvedStreet = (street || '').trim();
        let resolvedEp1 = endpoint1;
        let resolvedEp2 = endpoint2;
        let resolvedCross1 = crossStreet1;
        let resolvedCross2 = crossStreet2;
        let geometrySource = 'client';

        if (Array.isArray(clientPath) && clientPath.length >= 2) {
            resolvedPath = clientPath;
            resolvedEp1 = clientPath[0];
            resolvedEp2 = clientPath[clientPath.length - 1];
            geometrySource = 'client-path';
        }

        if (
            !resolvedPath &&
            tap &&
            isFiniteCoord(tap.lat) &&
            isFiniteCoord(tap.lng)
        ) {
            const resolved = await streetSegmentResolver.resolveBlockSegment(
                { lat: tap.lat, lng: tap.lng },
                resolvedStreet
            );
            if (resolved && Array.isArray(resolved.path) && resolved.path.length >= 2) {
                resolvedPath = resolved.path;
                resolvedEp1 = resolved.endpoint1;
                resolvedEp2 = resolved.endpoint2;
                resolvedCross1 = resolved.crossStreet1 || crossStreet1;
                resolvedCross2 = resolved.crossStreet2 || crossStreet2;
                // Trust OSM's canonical name over whatever the client's
                // reverse-geocoder said — they disagree often enough that
                // overriding here gives the cleanest segment grouping.
                if (resolved.streetName) resolvedStreet = resolved.streetName;
                geometrySource = 'overpass';
            }
        }

        if (
            !resolvedEp1 ||
            !resolvedEp2 ||
            !isFiniteCoord(resolvedEp1.lat) ||
            !isFiniteCoord(resolvedEp1.lng) ||
            !isFiniteCoord(resolvedEp2.lat) ||
            !isFiniteCoord(resolvedEp2.lng)
        ) {
            return res.status(400).json({
                success: false,
                message:
                    'either tap{lat,lng} or endpoint1/endpoint2 required',
            });
        }

        // Fallback when Overpass didn't resolve: synthesize a 2-point path
        // from the client-supplied endpoints. Side is captured as metadata
        // (no cardinal offset — that produced lines drawn diagonally
        // across unrelated streets).
        const finalPath = resolvedPath || [resolvedEp1, resolvedEp2];

        const mark = await StreetParkingMark.create({
            valet: valetId,
            street: resolvedStreet,
            crossStreet1: (resolvedCross1 || '').trim(),
            crossStreet2: (resolvedCross2 || '').trim(),
            side,
            path: finalPath,
            endpoint1: finalPath[0],
            endpoint2: finalPath[finalPath.length - 1],
            midpoint: midpointOf(finalPath[0], finalPath[finalPath.length - 1]),
            level,
            details: parseDetails(details),
        });

        return res.status(201).json({
            success: true,
            geometrySource,
            mark: { id: mark._id, ...mark.toObject() },
        });
    } catch (err) {
        console.error('create street-parking mark error:', err);
        return res
            .status(500)
            .json({ success: false, message: err.message || 'Create failed' });
    }
};

exports.update = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'invalid id' });
        }
        const patch = {};
        const body = req.body || {};
        if (body.level && ['easy', 'moderate', 'hard'].includes(body.level)) {
            patch.level = body.level;
        }
        if (
            body.side &&
            ['north', 'south', 'east', 'west', 'both'].includes(body.side)
        ) {
            patch.side = body.side;
        }
        if (body.details !== undefined) {
            patch.details = parseDetails(body.details);
        }
        if (typeof body.street === 'string') patch.street = body.street.trim();
        if (typeof body.crossStreet1 === 'string')
            patch.crossStreet1 = body.crossStreet1.trim();
        if (typeof body.crossStreet2 === 'string')
            patch.crossStreet2 = body.crossStreet2.trim();

        const mark = await StreetParkingMark.findByIdAndUpdate(id, patch, {
            new: true,
        });
        if (!mark) {
            return res
                .status(404)
                .json({ success: false, message: 'mark not found' });
        }
        return res.json({ success: true, mark });
    } catch (err) {
        console.error('update street-parking mark error:', err);
        return res
            .status(500)
            .json({ success: false, message: err.message || 'Update failed' });
    }
};

/**
 * POST /api/street-parking/report
 * A valet flags a verified segment as incorrect. Two distinct reports
 * un-verify the segment automatically; further dispute resolution is
 * by admin review.
 *
 * Body: { valetId, street, crossStreet1?, crossStreet2?, side, reason? }
 *
 * Idempotent per (valet, segment) — a second submission from the same
 * valet for the same segment just updates the reason.
 */
exports.reportSegment = async (req, res) => {
    try {
        const {
            valetId,
            street,
            crossStreet1 = '',
            crossStreet2 = '',
            side,
            reason = '',
        } = req.body || {};

        if (!valetId || !mongoose.Types.ObjectId.isValid(valetId)) {
            return res
                .status(400)
                .json({ success: false, message: 'valid valetId required' });
        }
        if (!street || !side) {
            return res
                .status(400)
                .json({ success: false, message: 'street + side required' });
        }
        if (!['north', 'south', 'east', 'west', 'both'].includes(side)) {
            return res.status(400).json({
                success: false,
                message: 'invalid side',
            });
        }

        const segmentKey = segmentKeyOf({
            street,
            crossStreet1,
            crossStreet2,
            side,
        });

        const report = await StreetSegmentReport.findOneAndUpdate(
            { valet: valetId, segmentKey },
            {
                valet: valetId,
                segmentKey,
                street: street.trim(),
                crossStreet1: (crossStreet1 || '').trim(),
                crossStreet2: (crossStreet2 || '').trim(),
                side,
                reason: (reason || '').trim(),
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        const totalReports = await StreetSegmentReport.countDocuments({
            segmentKey,
        });

        return res.json({
            success: true,
            reportId: report._id,
            totalReports,
            // Same threshold as listInBbox uses.
            wouldUnverify: totalReports >= UNVERIFY_REPORT_THRESHOLD,
        });
    } catch (err) {
        console.error('reportSegment error:', err);
        return res
            .status(500)
            .json({ success: false, message: err.message || 'Report failed' });
    }
};

exports.remove = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'invalid id' });
        }
        const out = await StreetParkingMark.findByIdAndDelete(id);
        if (!out) {
            return res
                .status(404)
                .json({ success: false, message: 'mark not found' });
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('delete street-parking mark error:', err);
        return res
            .status(500)
            .json({ success: false, message: err.message || 'Delete failed' });
    }
};

/**
 * POST /api/street-parking/:id/photo — multipart upload to attach an
 * optional sign photo to an existing mark. Mirrors the ParkingNote sign
 * photo pattern (same Firebase Storage bucket layout).
 */
exports.uploadPhoto = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: 'invalid id' });
        }
        if (!req.file) {
            return res
                .status(400)
                .json({ success: false, message: 'photo file required' });
        }
        if (!ACCEPTED_MIME_TYPES.includes(req.file.mimetype)) {
            return res
                .status(400)
                .json({ success: false, message: 'unsupported mime type' });
        }
        if (req.file.size > MAX_BYTES) {
            return res
                .status(400)
                .json({ success: false, message: 'photo too large' });
        }

        const mark = await StreetParkingMark.findById(id);
        if (!mark) {
            return res
                .status(404)
                .json({ success: false, message: 'mark not found' });
        }

        const ext =
            path.extname(req.file.originalname || '').toLowerCase() ||
            (req.file.mimetype === 'image/png' ? '.png' : '.jpg');
        const random = crypto.randomBytes(6).toString('hex');
        const storagePath = `street-parking/${id}/${Date.now()}-${random}${ext}`;

        const { bucket } = await firebaseStorage.uploadFile(
            req.file.buffer,
            storagePath,
            req.file.mimetype
        );

        mark.details = mark.details || {};
        mark.details.signPhotoBucket = bucket;
        mark.details.signPhotoStoragePath = storagePath;
        mark.details.signPhotoMimeType = req.file.mimetype;
        await mark.save();

        const signedUrl = await firebaseStorage.getSignedUrl(
            storagePath,
            SIGNED_URL_MINUTES
        );

        return res.json({ success: true, signedUrl });
    } catch (err) {
        console.error('upload street-parking photo error:', err);
        return res
            .status(500)
            .json({ success: false, message: err.message || 'Upload failed' });
    }
};
