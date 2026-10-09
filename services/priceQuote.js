// The price card a client renders before a customer subscribes
// (POST /api/subscription/price, 2026-10-09).
//
// The app and the web both draw the review screen from `lines`, `note`,
// `info` (the ⓘ box) and `cta` (the Subscribe button) exactly as they come
// back, so how a price is built — the address, the
// neighborhood, a percent or dollar code, a free trial — can change here
// without an app update. A plan that cannot be bought as asked (not offered
// at the address, no longer sold, no address yet) is still a 200 with
// `available: false` and the sentence to show; only a request that names no
// real plan is a 400.

const { getTable, contactSalesOf } = require('./neighborhoodPricing');
const { quotePlan, dollars } = require('./planPricing');
const {
    findPromo,
    promoRedemptionBlock,
    planMismatch,
    applyToFor,
    describe,
    discountRefusal,
    isDiscount,
} = require('./subscriptionPromos');

function shortDate(date) {
    return new Date(date).toLocaleDateString('en-US', {
        timeZone: 'America/New_York',
        month: 'short',
        day: 'numeric',
    });
}

function perUnit(interval) {
    return interval === 'week' ? '/wk' : '/mo';
}

// "Permanent valet in Chelsea", "Street cleaning moves · 2 moves a week".
// The plan's own row above it already says monthly or weekly.
function priceLineLabel(quote) {
    if (quote.plan.pricedByAddress && quote.area) return `${quote.plan.name} in ${quote.area.label}`;
    if (quote.plan.perMove) {
        return `${quote.plan.name} · ${quote.quantity} move${quote.quantity === 1 ? '' : 's'} a week`;
    }
    return quote.plan.name;
}

// The minus sign the review card prints in front of a discount.
const MINUS = '\u2212';

function line(label, amountCents, kind, amount) {
    return { label, amountCents, amount: amount || dollars(amountCents), kind };
}

/**
 * Build the /price response.
 *   { tier, interval, movesPerWeek?, address?, promoCode?, userId? }
 * `waitlistFor(quote)` answers whether the quote's neighborhood is still
 * locked (the controller passes the unlock service's; tests pass their own).
 * Returns { status, body }.
 */
async function buildPriceQuote({
    tier,
    interval,
    movesPerWeek,
    address,
    promoCode,
    userId,
    waitlistFor = null,
    now = new Date(),
} = {}) {
    const table = await getTable();
    const contactSales = contactSalesOf(table);
    const choice = { tier, interval, movesPerWeek };

    let promo = null;
    let promoError;
    if (promoCode && String(promoCode).trim()) {
        const candidate = await findPromo(promoCode);
        if (!candidate) {
            promoError = 'That code is not valid.';
        } else {
            const blocked = await promoRedemptionBlock(candidate, userId);
            if (blocked) promoError = blocked;
            else promo = candidate;
        }
    }

    let applyTo = promo ? applyToFor(promo, choice) : null;
    let target = applyTo || choice;
    let quote = quotePlan(table, { ...target, homeAddress: address });

    // A dollar code bigger than the bill is refused here rather than at
    // checkout, and the customer keeps the plan they picked.
    if (promo && !quote.error) {
        const refusal = discountRefusal(promo, quote.amountCents);
        if (refusal) {
            promoError = refusal;
            promo = null;
            applyTo = null;
            target = choice;
            quote = quotePlan(table, { ...target, homeAddress: address });
        }
    }

    if (quote.error && quote.code === 'UNKNOWN_PLAN') {
        return { status: 400, body: { success: false, message: quote.error } };
    }

    const base = {
        success: true,
        tier: target.tier,
        interval: target.interval,
        applyTo,
        contactSales,
        ...(promoError ? { promoError } : {}),
    };
    if (quote.error) {
        return {
            status: 200,
            body: {
                ...base,
                available: false,
                message: quote.error,
                amountCents: null,
                area: null,
                promo: null,
                dueTodayCents: null,
                thenCents: null,
                lines: [],
            },
        };
    }

    const amountCents = quote.amountCents;
    const unit = perUnit(quote.interval);
    const lines = [line(priceLineLabel(quote), amountCents, 'price', `${dollars(amountCents)}${unit}`)];
    let dueTodayCents = amountCents;
    let thenCents = amountCents;
    let thenFrom;
    const notes = [];

    const mismatch = promo ? planMismatch(promo, choice) : null;
    if (mismatch) notes.push(mismatch);

    let described = null;
    if (promo) {
        described = describe(promo, { amountCents, interval: quote.interval, now });
        // "SAVE20 · 20% off your first month": the discount row, and the chip
        // under it with Remove.
        described.label = `${promo.code} · ${described.headline}`;
        if (promo.kind === 'free_trial') {
            lines.push(line(described.label, -amountCents, 'discount', `${MINUS}${dollars(amountCents)}`));
            dueTodayCents = 0;
            thenFrom = described.trialEndsAt;
            notes.push(
                `Your card is saved now and charged ${dollars(amountCents)}${unit} from ${shortDate(thenFrom)}. Cancel before then and you are never charged.`
            );
        } else if (isDiscount(promo)) {
            lines.push(
                line(described.label, -described.discountCents, 'discount', `${MINUS}${dollars(described.discountCents)}`)
            );
            dueTodayCents = described.dueTodayCents;
            thenCents = described.thenCents;
            if (described.thenFrom) {
                thenFrom = described.thenFrom;
                notes.push(
                    promo.duration === 'repeating'
                        ? `${dollars(described.dueTodayCents)}${unit} until ${shortDate(thenFrom)}, then ${dollars(amountCents)}${unit}.`
                        : `Then ${dollars(amountCents)}${unit} from ${shortDate(thenFrom)}.`
                );
            }
        } else if (promo.kind === 'coupon' && described.detail) {
            // The older env-configured coupons: Stripe knows the discount, we
            // do not, so say it is applied rather than invent a number.
            notes.push(described.detail);
        }
    }

    // A neighborhood that has not unlocked takes the card and charges
    // nothing until it does (services/neighborhoodUnlocks.js).
    const waitlist = waitlistFor ? await waitlistFor(quote) : null;
    if (waitlist) {
        dueTodayCents = 0;
        thenFrom = undefined;
        notes.length = 0;
        if (mismatch) notes.push(mismatch);
    }
    lines.push(line('Due today', dueTodayCents, 'total'));

    return {
        status: 200,
        body: {
            ...base,
            available: true,
            tier: quote.tier,
            interval: quote.interval,
            movesPerWeek: quote.plan.perMove ? quote.quantity : undefined,
            amountCents,
            area: quote.area,
            promo: described,
            dueTodayCents,
            thenCents,
            ...(thenFrom ? { thenFrom: new Date(thenFrom).toISOString() } : {}),
            lines,
            ...(notes.length ? { note: notes.join(' ') } : {}),
            // The ⓘ box above Subscribe.
            ...(waitlist ? { waitlist, info: waitlist.note } : {}),
            cta:
                dueTodayCents === amountCents || waitlist
                    ? `Subscribe · ${dollars(amountCents)}${unit}`
                    : `Subscribe · ${dollars(dueTodayCents)} today`,
        },
    };
}

module.exports = { buildPriceQuote, shortDate, perUnit };
