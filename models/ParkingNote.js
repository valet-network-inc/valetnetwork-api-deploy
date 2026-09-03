const mongoose = require('mongoose');

/**
 * ParkingNote — structured parking-rules log captured by the valet at the
 * moment they park a customer's car. This is the data layer that makes
 * conflict-aware placement possible later: build 12's smart-placement
 * algorithm queries these by geo-radius to learn "what restrictions
 * apply on this block?" without paying for a Google/MapBox parking-rules
 * API.
 *
 * Fields prioritize machine-queryable structure over free text. The
 * `notes` field is the escape hatch for anything the structured fields
 * can't capture (loading-zone hours, snow emergency rules, garage-only
 * zones, etc.). A free-text-only entry is still useful — a future LLM
 * pass can normalize them into structured rules retroactively.
 *
 * Sign photo:
 *   - Stored in Firebase Storage, same bucket as order-photos.
 *   - Path:  `parking-notes/<orderId>/<timestamp>-<random>.jpg`
 *   - Bucket is private; reads via short-lived signed URLs (admin
 *     dashboard + valet app).
 */

const TimeWindowSchema = new mongoose.Schema(
    {
        // Day of week, 0 = Sunday … 6 = Saturday (matches JS Date.getDay()).
        // Stored as number rather than string so range queries are easy.
        day: { type: Number, min: 0, max: 6, required: true },
        // 'HH:MM' (24h). Strings let us round-trip iOS time pickers
        // without timezone foot-guns; placement logic parses these on read.
        startTime: { type: String, required: true },
        endTime: { type: String, required: true },
    },
    { _id: false }
);

const ParkingNoteSchema = new mongoose.Schema(
    {
        order: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Order',
            required: true,
            index: true,
        },
        valet: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },

        // Geo where the car was parked. Mirrored from order.parkingLocation
        // at create-time so the parking-rules dataset is queryable
        // independent of the order doc (future block-level queries).
        location: {
            lat: { type: Number, required: true },
            lng: { type: Number, required: true },
            streetAddress: { type: String },
        },

        // Sign photo — bucket + storage path; UI gets fresh signed URLs.
        signPhotoBucket: { type: String, required: true },
        signPhotoStoragePath: { type: String, required: true },
        signPhotoMimeType: { type: String },

        // Structured rules
        streetCleaning: { type: [TimeWindowSchema], default: [] },

        /**
         * What an EMPTY `streetCleaning` actually means.
         *
         * Until this field existed, `[]` meant both "I read the sign and there
         * is no street cleaning on this block" and "I skipped the field", and
         * nothing could tell them apart. That ambiguity is fatal to the managed
         * plans: read as "no sweep" it silently abandons a car on a swept block,
         * and read as "unknown" it pages a human every day about a driveway.
         *
         *   'captured'     — at least one window was entered
         *   'none_on_sign' — the valet read the sign; no street cleaning here
         *   'off_street'   — garage, driveway, private lot; sweeps do not apply
         *   'skipped'      — could not read it (dark, no sign, obstructed)
         *
         * Only 'none_on_sign' and 'off_street' legitimately silence the alarm.
         * A legacy note with no value here stays UNKNOWN forever — backfilling
         * it would be a lie that permanently silences the alarm on that block.
         */
        sweepDataStatus: {
            type: String,
            enum: ['captured', 'none_on_sign', 'off_street', 'skipped'],
        },

        // The phone's UTC offset when the times were typed. The valet app writes
        // `date.getHours()` — the DEVICE's local hour — and nothing else can
        // tell whether that clock agreed with New York. A phone in the wrong
        // timezone turns a correctly-read sign into a wrong dispatch instant
        // that looks completely ordinary.
        tzOffsetMinutes: { type: Number },
        // Meter limit in minutes (e.g., 60 for 1-hour meter). null/undefined
        // means no metered limit — plain free parking up to other windows.
        meterMaxMinutes: { type: Number, min: 0 },
        noParkWindows: { type: [TimeWindowSchema], default: [] },

        // Free-text escape hatch
        notes: { type: String, default: '' },

        // Hard 30-day expiry on the sign photo (privacy policy parity with
        // OrderPhoto). The cron at services/parkingPhotoExpiry.js wipes
        // the storage bytes + clears the signPhoto* fields when this
        // passes — the rule data itself stays for the heat-map dataset.
        signPhotoExpiresAt: {
            type: Date,
            default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            index: true,
        },
    },
    { timestamps: true }
);

// Geo-ish index for the build 12 nearby query. Mongo's 2dsphere needs
// GeoJSON, but for a simple lat/lng we get adequate filtering with a
// compound (lat, lng) index plus app-side haversine. Upgrade to 2dsphere
// once the dataset grows beyond ~10k rows.
ParkingNoteSchema.index({ 'location.lat': 1, 'location.lng': 1 });

module.exports = mongoose.model('ParkingNote', ParkingNoteSchema);
