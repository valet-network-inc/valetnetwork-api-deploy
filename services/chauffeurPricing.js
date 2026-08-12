/**
 * Chauffeur pricing engine.
 *
 * Pure, deterministic functions over config/chauffeurPricing.js. No DB, no
 * Stripe, no side effects — so the rider's estimate and the (later) driver
 * accept/modify screen consume IDENTICAL math, and it's unit-testable.
 *
 * All money is integer CENTS.
 *
 * The engine produces ONE number: the suggested price = base-rate × surge,
 * floored. That's the starting anchor a driver adjusts ± from (down to the
 * floor); the matched driver's bid is the real price (reverse auction, driver
 * side). No Uber anchoring — a live competitor estimate is reference-only and
 * lives in chauffeurReference.js, not here.
 *
 *   computeFloorCents       hard floor (standard / WAV / out-of-NYC variants)
 *   computeBaseRateCents    our base-rate equation
 *   computeSurgeMultiplier  clamp(1, (rho/rhoTarget)^gamma, mMax)
 *   computeSuggestedCents   max(floor, baseRate * surge)
 *   computeSoftwareFeeCents actual cost-to-serve; per_ride | subscription
 *   resolveFeeMode          per-driver subscription override
 *   validateQuote           floor + fee-fits invariants
 *   quoteRide               orchestrator returning the full breakdown
 */

const cfg = require('../config/chauffeurPricing');

const toCents = (dollars) => Math.round(dollars * 100);
const clamp = (lo, x, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Floor. A trip may be partly outside NYC: pass an `outOfNyc` portion and those
 * miles/minutes price at the out-of-NYC rate, the remainder at standard (or WAV).
 *
 * @param {Object} p
 * @param {number}  p.miles
 * @param {number}  p.minutes
 * @param {boolean} [p.wav]
 * @param {Object}  [p.outOfNyc]  { miles, minutes } portion outside NYC
 * @returns {number} floor in cents
 */
function computeFloorCents({ miles = 0, minutes = 0, wav = false, outOfNyc = null } = {}) {
  const inRate = wav ? cfg.floor.wav : cfg.floor.standard;

  const outMiles = outOfNyc ? Math.min(Math.max(outOfNyc.miles || 0, 0), miles) : 0;
  const outMins  = outOfNyc ? Math.min(Math.max(outOfNyc.minutes || 0, 0), minutes) : 0;
  const inMiles  = Math.max(0, miles - outMiles);
  const inMins   = Math.max(0, minutes - outMins);

  const dollars =
    inRate.perMile * inMiles + inRate.perMinute * inMins +
    cfg.floor.outOfNyc.perMile * outMiles + cfg.floor.outOfNyc.perMinute * outMins;

  return toCents(dollars);
}

/**
 * Base-rate fare = base + per_mile*miles + per_min*minutes (our own equation).
 * @returns {number} cents
 */
function computeBaseRateCents({ miles = 0, minutes = 0 } = {}) {
  const r = cfg.baseRate;
  return toCents(r.base + r.perMile * miles + r.perMinute * minutes);
}

/**
 * Surge multiplier from live local supply/demand.
 * rho = openRequests / availableDrivers; clamp(1,(rho/target)^gamma,mMax).
 * Degenerate supply (0 drivers) caps at mMax when there is demand, else 1.
 * @returns {number} multiplier in [1, mMax]
 */
function computeSurgeMultiplier({ openRequests = 0, availableDrivers = 0 } = {}) {
  const { rhoTarget, gamma, mMax } = cfg.surge;
  if (availableDrivers <= 0) return openRequests > 0 ? mMax : 1;
  const rho = openRequests / availableDrivers;
  return clamp(1, Math.pow(rho / rhoTarget, gamma), mMax);
}

/**
 * Suggested price = max(floor, baseRate * surge). Floor always wins.
 * @returns {number} cents
 */
function computeSuggestedCents({ floorCents, baseRateCents, surgeMultiplier }) {
  return Math.max(floorCents, Math.round(baseRateCents * surgeMultiplier));
}

/**
 * Resolve fee mode for a driver. Subscription is a PER-DRIVER opt-in (driver
 * profile), so a subscriber pays $0/ride; everyone else pays the per-ride fee.
 * Falls back to the global default when there's no driver context (e.g. the
 * rider's pre-dispatch estimate).
 * @param {Object} [driver] reads driver.chauffeurSubscription.active
 * @returns {'per_ride'|'subscription'}
 */
function resolveFeeMode(driver) {
  if (driver && driver.chauffeurSubscription && driver.chauffeurSubscription.active) {
    return 'subscription';
  }
  return cfg.softwareFee.mode;
}

/**
 * Software fee = actual cost-to-serve (NOT a margin). per_ride = Stripe
 * processing on the rider charge + amortized infra; subscription = 0 per ride.
 * @returns {number} cents
 */
function computeSoftwareFeeCents({ riderPriceCents, feeMode } = {}) {
  const f = cfg.softwareFee;
  const mode = feeMode || f.mode;
  if (mode === 'subscription') return 0;
  return Math.round(riderPriceCents * f.stripePct) + f.stripeFixedCents + f.infraPerRideCents;
}

/**
 * Invariants on a price (suggested OR a driver bid):
 *   - price >= floor          (a driver can never go below break-even)
 *   - fee <= price - floor    (the fee never pushes the driver below floor)
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateQuote({ priceCents, floorCents, softwareFeeCents }) {
  const errors = [];
  if (priceCents < floorCents) errors.push('below_floor');
  if (softwareFeeCents > priceCents - floorCents) errors.push('fee_exceeds_budget');
  return { valid: errors.length === 0, errors };
}

/**
 * Orchestrator. Trip geometry + live supply/demand -> full quote breakdown.
 * `suggestedCents` is the price shown to drivers (and the rider's estimate);
 * the matched driver's bid becomes the real charge (reverse auction).
 *
 * @returns {{
 *   floorCents:number, baseRateCents:number, surgeMultiplier:number,
 *   suggestedCents:number, softwareFeeCents:number, feeMode:string,
 *   driverNetCents:number, validation:{valid:boolean,errors:string[]}
 * }}
 */
function quoteRide({
  miles, minutes, wav = false, outOfNyc = null,
  openRequests = 0, availableDrivers = 0, feeMode,
} = {}) {
  const floorCents = computeFloorCents({ miles, minutes, wav, outOfNyc });
  const baseRateCents = computeBaseRateCents({ miles, minutes });
  const surgeMultiplier = computeSurgeMultiplier({ openRequests, availableDrivers });
  const suggestedCents = computeSuggestedCents({ floorCents, baseRateCents, surgeMultiplier });
  const softwareFeeCents = computeSoftwareFeeCents({ riderPriceCents: suggestedCents, feeMode });
  const validation = validateQuote({ priceCents: suggestedCents, floorCents, softwareFeeCents });

  return {
    floorCents,
    baseRateCents,
    surgeMultiplier: Number(surgeMultiplier.toFixed(4)),
    suggestedCents,
    softwareFeeCents,
    feeMode: feeMode || cfg.softwareFee.mode,
    driverNetCents: suggestedCents - softwareFeeCents,
    validation,
  };
}

module.exports = {
  computeFloorCents,
  computeBaseRateCents,
  computeSurgeMultiplier,
  computeSuggestedCents,
  computeSoftwareFeeCents,
  resolveFeeMode,
  validateQuote,
  quoteRide,
  _config: cfg,
};
