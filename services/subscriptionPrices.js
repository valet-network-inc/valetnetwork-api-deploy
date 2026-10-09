// Stripe price ids for every plan we bill (2026-10-09).
//
// The flat catalog (street cleaning, the $250 Permanent valet that existing
// subscribers keep, Valet anywhere) is minted once by
// scripts/ensureSubscriptionCatalog.js and found here by lookup_key.
//
// Permanent valet at the new prices is different: the price is whatever the
// live table says for the address, and the admin can change the table
// without a deploy. So those prices are minted on demand, one per amount,
// with a lookup key that names the amount — vn_home_garage_month_c52500 is
// $525 a month. Stripe prices are immutable, so an amount always maps to the
// same price, a new amount simply mints a new one, and nothing that already
// bills at an old amount is touched.

const stripeClient = require('./stripeClient');

// lookup_key → price id for the life of the process. A price's amount never
// changes, so the only way this goes stale is a test→live key switch, which
// restarts the process anyway.
const priceIdCache = new Map();
// Two quotes for the same new amount at the same moment should mint one
// price, not race each other to Stripe.
const inFlight = new Map();
let garageProductId = null;

// The lookup key the old $250/$75 Permanent valet prices are filed under. Their
// product is the one every new-pricing amount is minted on, so a customer's
// invoices say "Permanent valet" whichever price they are on.
const GARAGE_ANCHOR_LOOKUP_KEY = 'vn_home_garage_monthly';

function garageLookupKey(interval, amountCents) {
    return `vn_home_garage_${interval === 'week' ? 'week' : 'month'}_c${amountCents}`;
}

function requireStripe() {
    const stripe = stripeClient.get();
    if (!stripe) throw new Error('Stripe API key not configured');
    return stripe;
}

async function findActivePrice(stripe, lookupKey) {
    const prices = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
    const found = prices.data && prices.data[0];
    return found && found.active ? found : null;
}

/** A catalog price by lookup key. Throws when it was never minted. */
async function resolvePriceId(lookupKey) {
    if (priceIdCache.has(lookupKey)) return priceIdCache.get(lookupKey);
    const found = await findActivePrice(requireStripe(), lookupKey);
    if (!found) throw new Error(`Stripe price not found for lookup key ${lookupKey}`);
    priceIdCache.set(lookupKey, found.id);
    return found.id;
}

async function homeGarageProductId(stripe) {
    if (garageProductId) return garageProductId;
    const prices = await stripe.prices.list({
        lookup_keys: [GARAGE_ANCHOR_LOOKUP_KEY],
        limit: 1,
    });
    const anchor = prices.data && prices.data[0];
    if (!anchor) {
        throw new Error(
            `Stripe price ${GARAGE_ANCHOR_LOOKUP_KEY} not found — run scripts/ensureSubscriptionCatalog.js`
        );
    }
    garageProductId = typeof anchor.product === 'string' ? anchor.product : anchor.product.id;
    return garageProductId;
}

async function mintGaragePrice(interval, amountCents) {
    const stripe = requireStripe();
    const lookupKey = garageLookupKey(interval, amountCents);
    const existing = await findActivePrice(stripe, lookupKey);
    if (existing) return existing.id;

    const product = await homeGarageProductId(stripe);
    try {
        const created = await stripe.prices.create({
            product,
            unit_amount: amountCents,
            currency: 'usd',
            recurring: { interval },
            lookup_key: lookupKey,
            nickname: `Permanent valet $${(amountCents / 100).toFixed(2)}/${interval}`,
            metadata: { lookupKey, tier: 'home_garage', pricedByAddress: 'true' },
        });
        console.log(`Minted Stripe price ${lookupKey} -> ${created.id}`);
        return created.id;
    } catch (err) {
        // Another process (or the catalog script) minted it between our list
        // and our create, and Stripe refuses a second price on the same
        // lookup key. Theirs is the same amount, so use it.
        const raced = await findActivePrice(stripe, lookupKey);
        if (raced) return raced.id;
        throw err;
    }
}

/** The Stripe price for Permanent valet at this amount, minted the first time it is asked for. */
async function ensureGaragePriceId(interval, amountCents) {
    if (interval !== 'week' && interval !== 'month') throw new Error(`Bad interval ${interval}`);
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error(`Bad amount ${amountCents}`);
    const lookupKey = garageLookupKey(interval, amountCents);
    if (priceIdCache.has(lookupKey)) return priceIdCache.get(lookupKey);
    if (!inFlight.has(lookupKey)) {
        inFlight.set(
            lookupKey,
            mintGaragePrice(interval, amountCents)
                .then((id) => {
                    priceIdCache.set(lookupKey, id);
                    return id;
                })
                .finally(() => inFlight.delete(lookupKey))
        );
    }
    return inFlight.get(lookupKey);
}

/** Tests: forget every resolved price. */
function clearPriceCache() {
    priceIdCache.clear();
    inFlight.clear();
    garageProductId = null;
}

module.exports = {
    resolvePriceId,
    ensureGaragePriceId,
    garageLookupKey,
    clearPriceCache,
    GARAGE_ANCHOR_LOOKUP_KEY,
};
