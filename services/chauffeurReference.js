/**
 * Reference competitor estimate ("the most we can with A") — OPTIONAL.
 *
 * getReferenceCompetitorCents() returns a LIVE Uber/Lyft fare estimate in cents,
 * or null. It is a REFERENCE DATA POINT ONLY: used for calibrating our base
 * rate over time and (optionally) showing the rider a comparison. It NEVER
 * feeds the charged price — pricing is our base-rate equation + surge, and the
 * real price is the matched driver's bid.
 *
 * REALITY CHECK: Uber and Lyft both retired their public fare-estimate APIs, so
 * a live value needs either a headless session against their web booking flow
 * or a third-party pricing-data vendor — brittle and arguably against ToS. So
 * this is a SEAM: cfg.reference.enabled gates it, fetchScrapedEstimateCents()
 * does the actual fetch (return null until wired), results are time-limited +
 * cached, and any failure simply yields null. Nothing depends on it.
 */

const cfg = require('../config/chauffeurPricing');

// --- tiny in-memory TTL cache (route + time bucket) -------------------------
const _cache = new Map(); // key -> { cents, expiresAt }

const _bucket = (n, step) => Math.round(n / step) * step;

function _cacheKey({ pickup, dropoff }) {
  const d = cfg.reference.routeBucketDeg;
  const t = Math.floor(Date.now() / 1000 / cfg.reference.timeBucketSec);
  const p = pickup ? `${_bucket(pickup.lat, d)},${_bucket(pickup.lng, d)}` : 'na';
  const q = dropoff ? `${_bucket(dropoff.lat, d)},${_bucket(dropoff.lng, d)}` : 'na';
  return `${cfg.reference.provider}|${p}|${q}|${t}`;
}

function _cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) { _cache.delete(key); return null; }
  return hit.cents;
}

function _cacheSet(key, cents) {
  if (_cache.size >= cfg.reference.cacheMaxEntries) {
    const first = _cache.keys().next().value;
    if (first !== undefined) _cache.delete(first);
  }
  _cache.set(key, { cents, expiresAt: Date.now() + cfg.reference.cacheTtlSec * 1000 });
}

function _withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); })
           .catch(() => { clearTimeout(t); resolve(null); });
  });
}

/**
 * INTEGRATION SEAM — wire a real live Uber/Lyft estimate here. Return cents
 * (surge included) or null. Called through module.exports so it's mockable.
 * @returns {Promise<number|null>}
 */
async function fetchScrapedEstimateCents(_params) {
  return null; // not wired — reference simply unavailable
}

/**
 * @returns {Promise<number|null>} live competitor estimate in cents, or null.
 */
async function getReferenceCompetitorCents(params) {
  if (!cfg.reference.enabled) return null;
  const { pickup, dropoff, miles, minutes } = params || {};

  const key = _cacheKey({ pickup, dropoff });
  const cached = _cacheGet(key);
  if (cached != null) return cached;

  const live = await _withTimeout(
    module.exports.fetchScrapedEstimateCents({ pickup, dropoff, miles, minutes }),
    cfg.reference.timeoutMs,
  );
  if (live != null && live > 0) {
    _cacheSet(key, live);
    return live;
  }
  return null;
}

module.exports = {
  getReferenceCompetitorCents,
  fetchScrapedEstimateCents, // exported so it can be wired/mocked
  _cache,                    // exported for tests
};
