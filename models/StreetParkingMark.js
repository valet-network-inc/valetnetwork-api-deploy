const mongoose = require('mongoose');

/**
 * StreetParkingMark — valet-curated map of how easy parking is on each
 * street segment + side. Distinct from ParkingNote (which records rules
 * at a specific parking event, tied to an Order). These are free-form
 * observations a valet can drop anywhere on the city map.
 *
 * One mark = one street segment + one side.
 * Examples:
 *   5th Ave between 23rd & 24th, east side → hard
 *   Lex Ave between 70th & 71st, both sides → easy
 *
 * Built for the build-12 valet parking heat-map.
 */

const TimeWindowSchema = new mongoose.Schema(
    {
        day: { type: Number, min: 0, max: 6, required: true },
        startTime: { type: String, required: true },
        endTime: { type: String, required: true },
    },
    { _id: false }
);

const PointSchema = new mongoose.Schema(
    {
        lat: { type: Number, required: true },
        lng: { type: Number, required: true },
    },
    { _id: false }
);

const StreetParkingMarkSchema = new mongoose.Schema(
    {
        valet: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },

        // Segment identity — street name + two cross-streets bounding it.
        // Cross-streets may be empty strings if the geocoder couldn't
        // resolve them; the endpoint coords are still authoritative.
        // Street became optional with the pin redesign: a pin is a pure
        // location, the name is best-effort reverse-geocoded on the phone.
        street: { type: String, default: '' },
        crossStreet1: { type: String, default: '' },
        crossStreet2: { type: String, default: '' },

        // How the mark was created:
        //   'segment' — legacy tap-a-line UX (Overpass polyline geometry)
        //   'pin'     — pin UX: one dropped point, grouped by tileKey
        origin: {
            type: String,
            enum: ['segment', 'pin'],
            default: 'segment',
            index: true,
        },

        // ~1-block grid cell of the midpoint (lat/lng each rounded to
        // 0.001°). Pin marks on the same street + tile share identity, so
        // the existing consensus math keeps working without street-segment
        // geometry.
        tileKey: { type: String, default: '', index: true },

        // Which side of the street the mark applies to.
        // 'side1' / 'side2' are the current valet-facing labels — they
        // map to the two pre-rendered offset polylines we draw next to
        // the curb. The legacy cardinal values are kept so old data
        // doesn't fail validation, but new marks always come in as
        // side1/side2. 'both' covers single-sided streets / blanket marks.
        side: {
            type: String,
            enum: ['side1', 'side2', 'both', 'north', 'south', 'east', 'west'],
            default: 'both',
        },

        // Geometry — `path` is the full street-segment polyline returned
        // by Overpass (every node between the bounding cross-streets), so
        // the line we render traces the actual street curves instead of
        // a straight diagonal. `endpoint1` / `endpoint2` are the first +
        // last point of `path` (kept for backward compat). `midpoint` is
        // denormalized for fast bbox queries.
        path: { type: [PointSchema], default: [] },
        endpoint1: { type: PointSchema, required: true },
        endpoint2: { type: PointSchema, required: true },
        midpoint: { type: PointSchema, required: true },

        // Parking availability level.
        // 'no_parking' is a hard veto — distinct from 'hard' (which means
        // "tough but legal"). Visualized as a black-striped line so it
        // can't be confused with 'hard' (red).
        level: {
            type: String,
            enum: ['easy', 'moderate', 'hard', 'no_parking'],
            required: true,
        },

        // Optional structured details — same shape family as ParkingNote
        // so any future cross-reference between the two datasets is easy.
        details: {
            // 'metered' / 'free' / null when unspecified
            paymentType: {
                type: String,
                enum: ['free', 'metered', null],
                default: null,
            },
            streetCleaning: { type: [TimeWindowSchema], default: [] },
            meterMaxMinutes: { type: Number, min: 0 },
            noParkWindows: { type: [TimeWindowSchema], default: [] },
            notes: { type: String, default: '' },
            // Optional sign photo — same storage pattern as ParkingNote.
            // Hard 30-day expiry mirroring OrderPhoto / ParkingNote.
            signPhotoBucket: { type: String },
            signPhotoStoragePath: { type: String },
            signPhotoMimeType: { type: String },
            signPhotoExpiresAt: { type: Date },
        },
    },
    { timestamps: true }
);

// Bbox queries hit the midpoint. Compound index gives adequate filtering
// for our scale; upgrade to 2dsphere once the dataset crosses ~10k rows.
StreetParkingMarkSchema.index({ 'midpoint.lat': 1, 'midpoint.lng': 1 });

module.exports = mongoose.model('StreetParkingMark', StreetParkingMarkSchema);
