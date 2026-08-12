const mongoose = require('mongoose');

/**
 * Ride — a Chauffeur (ride-hail) trip. Kept SEPARATE from the valet Order
 * model on purpose: chauffeurs and valets are distinct roles for now, and a
 * ride's lifecycle (pickup -> dropoff) differs from a parking order's.
 *
 * Pricing fields are a snapshot of the engine output at request time
 * (services/chauffeurPricing.js) so a later config/CPI change never rewrites
 * the price a rider already saw.
 */

const LocationSchema = new mongoose.Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    streetAddress: { type: String, required: true },
  },
  { _id: false }
);

const RideSchema = new mongoose.Schema(
  {
    rider: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    pickup: { type: LocationSchema, required: true },
    dropoff: { type: LocationSchema, required: true },

    distanceMiles: { type: Number, required: true },
    durationMinutes: { type: Number, required: true },

    // One standard tier at launch; share/black/eco/WAV come later.
    serviceTier: {
      type: String,
      enum: ['standard', 'wav'],
      default: 'standard',
    },

    // Snapshot of the pricing engine output at request time. Cents.
    // `suggestedCents` is our base-rate × surge estimate shown to drivers and
    // to the rider. The real charge is `finalPriceCents` = the matched driver's
    // bid (reverse auction; set on the driver side, never below floorCents).
    pricing: {
      floorCents: { type: Number },
      baseRateCents: { type: Number },
      surgeMultiplier: { type: Number },
      suggestedCents: { type: Number },
      softwareFeeCents: { type: Number },
      driverNetCents: { type: Number },
      feeMode: { type: String, enum: ['per_ride', 'subscription'] },
      // Reference-only competitor estimate (optional, data-gathering). Never
      // affects the charged price.
      referenceCompetitorCents: { type: Number },
    },

    // Final price = the offer the rider picked, set when matched.
    finalPriceCents: { type: Number },

    // Driver bids in the reverse auction. Drivers (driver side, later) push
    // offers while status is 'searching'; the rider sees them (cheapest +
    // fastest headline, plus the full list) and picks one, which assigns the
    // chauffeur. priceCents is validated >= floor on submission.
    offers: [
      {
        chauffeur: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        chauffeurName: { type: String },
        priceCents: { type: Number, required: true },
        etaMinutes: { type: Number }, // driver -> pickup
        distanceMeters: { type: Number },
        status: {
          type: String,
          enum: ['offered', 'selected', 'rejected'],
          default: 'offered',
        },
        createdAt: { type: Date, default: Date.now },
      },
    ],

    status: {
      type: String,
      enum: [
        'requested',  // rider tapped request; quote captured
        'searching',  // looking for a chauffeur
        'accepted',   // chauffeur accepted
        'en_route',   // chauffeur driving to pickup
        'arrived',    // chauffeur at pickup
        'in_trip',    // rider on board
        'completed',
        'cancelled',
      ],
      default: 'requested',
    },

    // Assigned chauffeur (set when the rider picks an offer).
    chauffeur: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Live driver location during an active ride (relayed to the rider).
    driverLocation: {
      lat: { type: Number },
      lng: { type: Number },
      updatedAt: { type: Date },
    },

    // Payment wired in a later increment (Uber-style auth at request, capture
    // at completion).
    paymentIntentId: { type: String },
    paymentStatus: {
      type: String,
      enum: ['unpaid', 'authorized', 'captured', 'refunded', 'failed'],
      default: 'unpaid',
    },

    requestedAt: { type: Date, default: Date.now },
    cancelledAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Ride', RideSchema);
