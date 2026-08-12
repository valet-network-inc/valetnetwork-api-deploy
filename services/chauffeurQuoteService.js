/**
 * Chauffeur quote orchestrator (async).
 *
 * Pricing is ALWAYS our own base-rate equation + surge (pure engine in
 * chauffeurPricing.js). This layer just adds two impure inputs:
 *   - per-driver fee mode (subscription override), and
 *   - an OPTIONAL live competitor estimate (reference only — never changes the
 *     price; attached as `referenceCompetitorCents` for calibration/display).
 *
 * The returned `suggestedCents` is the price shown to drivers and the rider's
 * estimate; the matched driver's bid (reverse auction, driver side) is the
 * real charge.
 */

const { quoteRide, resolveFeeMode } = require('./chauffeurPricing');
const { getReferenceCompetitorCents } = require('./chauffeurReference');

/**
 * @param {Object} params
 * @param {number} params.miles
 * @param {number} params.minutes
 * @param {boolean} [params.wav]
 * @param {{miles:number,minutes:number}} [params.outOfNyc]
 * @param {{lat,lng}} [params.pickup]
 * @param {{lat,lng}} [params.dropoff]
 * @param {number} [params.openRequests]
 * @param {number} [params.availableDrivers]
 * @param {Object} [params.driver]  assigned/candidate driver (per-driver fee mode)
 * @returns {Promise<Object>} quote breakdown + referenceCompetitorCents (nullable)
 */
async function getRideQuote(params) {
  const {
    miles, minutes, wav = false, outOfNyc = null,
    pickup, dropoff, openRequests = 0, availableDrivers = 0, driver,
  } = params;

  const feeMode = resolveFeeMode(driver);
  const quote = quoteRide({ miles, minutes, wav, outOfNyc, openRequests, availableDrivers, feeMode });

  // Reference only — does NOT affect the price. Null unless a live source is wired.
  const referenceCompetitorCents = await getReferenceCompetitorCents({ miles, minutes, pickup, dropoff });

  return { ...quote, referenceCompetitorCents };
}

module.exports = { getRideQuote };
