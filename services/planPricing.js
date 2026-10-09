// What a plan costs a particular customer, and the checks that keep the price
// they were shown and the price they are charged the same (2026-10-09).
//
// Three kinds of price come out of here:
//   - Permanent valet for a new subscription: the live neighborhood table at the
//     fixed address (services/neighborhoodPricing.js).
//   - Street cleaning: the flat per-move catalog, as before.
//   - A locked, pre-October subscription changing interval within its own
//     tier: the old catalog price it was sold at ($250/$75 Permanent valet,
//     Valet anywhere). Existing subscribers are locked in until further
//     notice, and an interval change is not a reason to reprice them.
//
// Nothing here talks to Stripe except resolveStripePrice, so the quote
// endpoint can price a plan without minting anything.

const { getPlan, priceFor, OFF_SALE_MESSAGE } = require('./subscriptionPlans');
const {
    garagePriceAt,
    basePrice,
    NOT_OFFERED_MESSAGE,
} = require('./neighborhoodPricing');
const { resolvePriceId, ensureGaragePriceId } = require('./subscriptionPrices');

const PRICING_MODEL = 'neighborhood_v1';

const ADDRESS_NEEDED_MESSAGE =
    'Permanent valet is priced by the address where the car is picked up and dropped off. Add that address first.';

function hasPoint(address) {
    return (
        !!address &&
        typeof address.lat === 'number' && Number.isFinite(address.lat) &&
        typeof address.lng === 'number' && Number.isFinite(address.lng)
    );
}

/** "$525" for whole dollars, "$12.50" otherwise. */
function dollars(cents) {
    const n = (cents || 0) / 100;
    return Number.isInteger(n) ? `$${n.toLocaleString('en-US')}` : `$${n.toFixed(2)}`;
}

/** A subscription bought before neighborhood pricing has no `pricing` on it, and keeps its price. */
function isLocked(sub) {
    return !(sub && sub.pricing && sub.pricing.model);
}

/**
 * Price one plan choice.
 *   legacy: true prices it from the old catalog (a locked subscription's
 *   interval change); otherwise new prices apply.
 *
 * Returns { plan, tier, interval, quantity, movesPerWeek, unitAmountCents,
 * amountCents, area, commissionCents, legacy, garage | lookupKey }, or
 * { error, code, status } when the plan cannot be bought as asked.
 */
function quotePlan(table, { tier, interval, movesPerWeek, homeAddress, legacy = false } = {}) {
    const plan = getPlan(tier);
    const catalog = priceFor(tier, interval);
    if (!plan || !catalog) {
        return { error: 'Unknown tier or interval', code: 'UNKNOWN_PLAN', status: 400 };
    }
    const quantity = plan.perMove ? (Number(movesPerWeek) === 1 ? 1 : 2) : 1;
    const base = {
        plan,
        tier,
        interval,
        quantity,
        movesPerWeek: plan.perMove ? quantity : 2,
    };

    if (legacy) {
        return {
            ...base,
            unitAmountCents: catalog.amountCents,
            amountCents: catalog.amountCents * quantity,
            lookupKey: catalog.lookupKey,
            area: null,
            commissionCents: null,
            legacy: true,
        };
    }
    if (plan.onSale === false) {
        return { error: OFF_SALE_MESSAGE, code: 'NOT_ON_SALE', status: 400 };
    }
    if (plan.pricedByAddress) {
        if (!hasPoint(homeAddress)) {
            return { error: ADDRESS_NEEDED_MESSAGE, code: 'ADDRESS_REQUIRED', status: 400 };
        }
        const price = garagePriceAt(table, homeAddress, interval);
        if (!price) return { error: NOT_OFFERED_MESSAGE, code: 'NOT_OFFERED', status: 400 };
        return {
            ...base,
            unitAmountCents: price.amountCents,
            amountCents: price.amountCents,
            garage: true,
            area: { borough: price.borough, neighborhood: price.neighborhood, key: price.key, label: price.label },
            commissionCents: price.commissionCents,
            legacy: false,
        };
    }
    return {
        ...base,
        unitAmountCents: catalog.amountCents,
        amountCents: catalog.amountCents * quantity,
        lookupKey: catalog.lookupKey,
        area: null,
        commissionCents: null,
        legacy: false,
    };
}

/** What GET /plans shows for this choice — the number a shipped app put on screen. */
function advertisedAmountCents(table, tier, interval, quantity = 1) {
    const plan = getPlan(tier);
    if (!plan) return null;
    if (plan.pricedByAddress) return basePrice(table, interval);
    const catalog = priceFor(tier, interval);
    return catalog ? catalog.amountCents * (plan.perMove ? quantity : 1) : null;
}

/** "Permanent valet at this address is $525 a month." */
function priceSentence(quote) {
    const unit = quote.interval === 'week' ? 'week' : 'month';
    const amount = dollars(quote.amountCents);
    if (quote.plan.pricedByAddress) return `${quote.plan.name} at this address is ${amount} a ${unit}.`;
    return `The ${quote.plan.name} plan is ${amount} a ${unit}.`;
}

/**
 * The guard between what the customer saw and what we are about to charge.
 *
 * A client built for neighborhood pricing sends the recurring amount it
 * displayed as expectedAmountCents. If the price moved underneath it (an
 * admin edit, a different address) the purchase stops with 409 and the
 * right number, and the client re-quotes.
 *
 * A shipped app sends nothing and shows the /plans price — $300 for Fixed
 * garage, right for Brooklyn and Queens. If the address costs something else,
 * that app cannot show it, so the purchase is refused with UPDATE_REQUIRED
 * rather than charging a number the customer never saw.
 *
 * A locked subscription's interval change bills the old catalog price, which
 * is never more than /plans shows, so an old app is not turned away from it.
 *
 * `requireExpected` is for a price change that /plans never advertised (a
 * fixed-address move): without expectedAmountCents it is UPDATE_REQUIRED.
 *
 * Returns null to go ahead, or { status, body } to send back.
 */
function checkExpectedAmount(
    table,
    quote,
    expectedAmountCents,
    { action = 'subscribe', requireExpected = false } = {}
) {
    const sentence = priceSentence(quote);
    const sent = expectedAmountCents !== undefined && expectedAmountCents !== null && expectedAmountCents !== '';
    if (sent) {
        if (Number(expectedAmountCents) !== quote.amountCents) {
            return {
                status: 409,
                body: {
                    success: false,
                    code: 'PRICE_CHANGED',
                    message: sentence,
                    amountCents: quote.amountCents,
                },
            };
        }
        return null;
    }
    if (quote.legacy) return null;
    // An address move that changes the price has no /plans number to fall
    // back on: a client that cannot say what it showed cannot have shown it.
    const advertised = advertisedAmountCents(table, quote.tier, quote.interval, quote.quantity);
    if (requireExpected || quote.amountCents !== advertised) {
        return {
            status: 400,
            body: {
                success: false,
                code: 'UPDATE_REQUIRED',
                message: `${sentence} Update the Valet Network app to ${action}.`,
                amountCents: quote.amountCents,
            },
        };
    }
    return null;
}

/** The Stripe price id for a quote, minting a Permanent valet amount the first time. */
async function resolveStripePrice(quote) {
    if (quote.garage) return ensureGaragePriceId(quote.interval, quote.unitAmountCents);
    return resolvePriceId(quote.lookupKey);
}

/** What Subscription.pricing records about a new-price sale. */
function pricingSnapshot(quote, now = new Date()) {
    return {
        model: PRICING_MODEL,
        borough: (quote.area && quote.area.borough) || null,
        neighborhood: (quote.area && quote.area.neighborhood) || null,
        neighborhoodKey: (quote.area && quote.area.key) || null,
        label: (quote.area && quote.area.label) || null,
        listAmountCents: quote.amountCents,
        commissionCents: quote.commissionCents ?? null,
        pricedAt: now,
    };
}

module.exports = {
    PRICING_MODEL,
    ADDRESS_NEEDED_MESSAGE,
    hasPoint,
    dollars,
    isLocked,
    quotePlan,
    advertisedAmountCents,
    priceSentence,
    checkExpectedAmount,
    resolveStripePrice,
    pricingSnapshot,
};
