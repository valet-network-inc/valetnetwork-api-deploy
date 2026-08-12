/**
 * Chauffeur pricing configuration.
 *
 * ALL constants live here — never hardcoded in logic — so they can be re-tuned
 * and CPI re-indexed every March 1 without touching the engine. Dollar rates
 * below convert to integer CENTS inside services/chauffeurPricing.js.
 *
 * THE MODEL (simple by design):
 *   1. We compute ONE suggested price = base-rate equation × surge, floored.
 *   2. Drivers see it and adjust ± down to the floor — they set the price.
 *   3. We match the rider to the LOWEST driver bid. The market prices the ride.
 *
 * There is no Uber-anchored formula. The optimal suggested price is refined
 * over time from our own data. A live competitor estimate (see `reference`) is
 * captured ONLY as an optional data point — it never feeds the charged price.
 */

module.exports = {
  // §1 — PRICE FLOOR. Hard floor; a driver can never bid below this. Driver
  // break-even proxy = TLC cost-based rates. NOT a legal minimum at our scale
  // (<10k dispatched trips/day). Re-index to CPI March 1.
  floor: {
    cpiReindexDate: '03-01',
    standard: { perMile: 1.283, perMinute: 0.681 },
    wav:      { perMile: 1.601, perMinute: 0.681 }, // wheelchair-accessible vehicle
    outOfNyc: { perMile: 1.757, perMinute: 0.725 }, // portion of trip outside NYC
  },

  // SUGGESTED BASE RATE — our own equation for the suggested price shown to
  // drivers (the starting anchor they adjust ± from). Calibrated on our data
  // over time; these are PLACEHOLDERS pending the feedback loop.
  baseRate: {
    base:      3.00, // dollars
    perMile:   2.10, // dollars
    perMinute: 0.45, // dollars
  },

  // SURGE — the only multiplier in the system, and the only real pricing
  // concern. multiplier = clamp(1, (rho / rhoTarget)^gamma, mMax),
  // rho = local open_requests / available_drivers.
  surge: {
    rhoTarget: 1.0, // requests-per-driver treated as "balanced"
    gamma:     0.5, // responsiveness exponent
    mMax:      2.0, // hard cap on surge
  },

  // SOFTWARE FEE (monetization) — kept OUT of price logic, applied as a strategy
  // so per_ride <-> subscription flips without touching pricing. Launch =
  // per_ride at ACTUAL cost-to-serve (Stripe + infra), NOT a margin. Constraint
  // (validateQuote): fee <= price - floor, so the fee never pushes a driver
  // below the floor. Subscription is a PER-DRIVER opt-in (driver profile).
  softwareFee: {
    mode: 'per_ride',          // global default; per-driver subscription overrides
    stripePct:         0.029,  // Stripe: 2.9% ...
    stripeFixedCents:  30,     // ... + 30c per charge
    infraPerRideCents: 5,      // AWS / infra amortized per ride
  },

  // REFERENCE COMPETITOR ESTIMATE (optional, "do the most we can with A").
  // A live Uber/Lyft price captured ONLY as a reference data point — for
  // calibration and optional rider-facing comparison. It NEVER feeds the
  // charged price. Off by default; a live source is brittle / ToS-gray to wire.
  reference: {
    enabled: false,
    provider: 'uber',
    timeoutMs: 2500,
    cacheTtlSec: 120,
    cacheMaxEntries: 1000,
    routeBucketDeg: 0.002, // ~200m pickup/dropoff rounding for cache keys
    timeBucketSec: 300,    // 5-min time buckets for cache keys
  },
};
