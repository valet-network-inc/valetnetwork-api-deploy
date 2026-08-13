const mongoose = require('mongoose');

/**
 * StreetSegmentReport — a valet flag that an aggregated segment's
 * verified data is wrong. Reports are keyed by the canonical segment
 * identity (street + cs1 + cs2 + side), so a single report applies to
 * the entire block-side regardless of how many StreetParkingMark rows
 * it covers.
 *
 * Rules:
 *   - One report per valet per segment (dedupe by (valet, key))
 *   - Threshold to flip a verified segment → unverified: 2 distinct
 *     reports. Single-report would let one bad actor sabotage the
 *     verified dataset.
 */

const StreetSegmentReportSchema = new mongoose.Schema(
    {
        valet: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        // Canonical segment identity. Keep names normalized lowercase
        // to avoid "5th Avenue" vs "5th avenue" duplicates.
        segmentKey: {
            type: String,
            required: true,
            index: true,
        },
        // Optional since the pin redesign — pin reports address the
        // segment purely by segmentKey and may have no street name.
        street: { type: String, default: '' },
        crossStreet1: { type: String, default: '' },
        crossStreet2: { type: String, default: '' },
        side: { type: String, required: true },
        reason: { type: String, default: '' },
    },
    { timestamps: true }
);

// One report per valet per segment.
StreetSegmentReportSchema.index({ valet: 1, segmentKey: 1 }, { unique: true });

module.exports = mongoose.model('StreetSegmentReport', StreetSegmentReportSchema);
