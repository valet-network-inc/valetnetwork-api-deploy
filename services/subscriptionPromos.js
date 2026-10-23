// Subscription promo codes (2026-08-20).
//
// HANDSFREE is the trial code: the first month of the $50 street-cleaning
// plan is on us, and the plan renews at the normal price after it.
// HANDSFREE2 is the same offer for the block that is swept twice a week —
// the $100 two-move plan.
//
// It runs as a real Stripe TRIAL rather than a 100%-off coupon, because a
// coupon that zeroes the first invoice settles with no PaymentIntent — the
// customer never enters a card, so month two has nothing to charge and the
// plan lapses at the exact moment it was supposed to convert. A trial keeps
// the card on file from day one and bills itself when the free month ends,
// which is the only version of a free trial that is worth running.
//
// The customer-facing promise: free for 30 days, cancel before it ends and
// nothing is ever charged.
//
// Codes made without a deploy (2026-10-09) live in Mongo (models/PromoCode.js)
// and are read first: percent off or dollars off, a free trial, or a rep's
// code that only credits the sale. findPromo became async for them.

const mongoose = require('mongoose');
const { phoneCode, findPhonePromo } = require('./phoneCodes');
const { getPlan, priceFor } = require('./subscriptionPlans');
const Subscription = require('../models/Subscription');
const PromoCode = require('../models/PromoCode');
const stripeClient = require('./stripeClient');

const PROMOS = {
    HANDSFREE: {
        code: 'HANDSFREE',
        kind: 'free_trial',
        trialDays: 30,
        headline: 'First month free',
        detail:
            'Your first month of street-cleaning moves is on us. Cancel any time before it ends and you are never charged.',
        // Locked to the $50/mo plan: street cleaning, monthly, one move a
        // week. The two-move plan has its own code, HANDSFREE2.
        appliesTo: { tier: 'street_cleaning', interval: 'month', movesPerWeek: 1 },
        // A trial is for people who have not tried it. One per customer,
        // and only before their first plan ever starts.
        firstTimeOnly: true,
        active: true,
    },

    // The same free month for a block that is swept twice a week: two covered
    // moves instead of one, $100/mo instead of $50.
    //
    // It is a second code rather than a widening of HANDSFREE. A promo whose
    // appliesTo leaves movesPerWeek open has nothing to snap the customer
    // onto — `applyTo` goes back to the app with movesPerWeek undefined, the
    // review screen falls through to a quantity of one, and the customer is
    // shown $50 for a plan that will bill $100 the month the trial ends. A
    // code that lies about the price it converts to is worse than no code.
    HANDSFREE2: {
        code: 'HANDSFREE2',
        kind: 'free_trial',
        trialDays: 30,
        headline: 'First month free',
        detail:
            'Your first month of street-cleaning moves is on us — both days a week. Cancel any time before it ends and you are never charged.',
        appliesTo: { tier: 'street_cleaning', interval: 'month', movesPerWeek: 2 },
        firstTimeOnly: true,
        active: true,
    },

    // The same free month on the Fixed garage plan, where the covered moves
    // come with a free park and retrieval every day at one spot. Since
    // 2026-10-09 it converts at the price of the customer's fixed address.
    //
    // It exists because the plan is the hardest of the three to buy on faith:
    // $250 was four times the street-cleaning plan, and the part that justifies
    // it is the daily park, which nobody believes until they have used it for a
    // few weeks. A month of actually living with it is the argument.
    //
    // Fixed garage is not a per-move plan (subscriptionPlans.js), so quantity
    // is always 1 and `movesPerWeek` is deliberately absent from appliesTo —
    // pinning it would make the code refuse the only plan it is for.
    LOLGARAGE: {
        code: 'LOLGARAGE',
        kind: 'free_trial',
        trialDays: 30,
        headline: 'First month free',
        detail:
            'Your first month of Permanent valet is on us — the street-cleaning moves and a free park and retrieval every day at your spot. Cancel any time before it ends and you are never charged.',
        appliesTo: { tier: 'home_garage', interval: 'month' },
        firstTimeOnly: true,
        active: true,
    },

    // A week of Fixed garage instead of a month — the code to hand one
    // customer who wants to try the daily park before paying for it.
    // Same plan, same card up front, same first-plan-only rule as LOLGARAGE;
    // it just bills on day 7.
    LMAOGARAGE: {
        code: 'LMAOGARAGE',
        kind: 'free_trial',
        trialDays: 7,
        // Every other code runs a month, and the server's own sentences
        // used to say "free month" for all of them.
        trialLabel: 'free week',
        headline: 'First week free',
        detail:
            'Your first week of Permanent valet is on us — the street-cleaning moves and a free park and retrieval every day at your spot. Cancel any time before it ends and you are never charged.',
        appliesTo: { tier: 'home_garage', interval: 'month' },
        firstTimeOnly: true,
        active: true,
    },
};

// What to call a code's free stretch in a sentence: "free week" for
// LMAOGARAGE, "free month" for the rest. Takes the promo or the code stamped
// on a subscription.
function trialLabel(promoOrCode) {
    const promo = typeof promoOrCode === 'string' ? PROMOS[normalizeCode(promoOrCode)] : promoOrCode;
    return (promo && promo.trialLabel) || 'free month';
}

// Codes are typed by hand on a phone. Inner spaces and dashes are the
// customer's, not the code's — "hands free 2" and "HANDSFREE-2" are both
// HANDSFREE2, and a code that turns those away only generates a support text.
// Punctuation goes the same way, so FREEWEEK! is FREEWEEK.
function normalizeCode(code) {
    return String(code || '')
        .replace(/[^A-Za-z0-9]+/g, '')
        .toUpperCase();
}

// Codes configured in the environment as CODE:couponId. This is the older
// hook, kept because E2E runs against live mode lean on it to zero out a
// purchase; it attaches a Stripe coupon and collects a card the normal way.
function envCouponPromos() {
    return (process.env.SUB_PROMO_CODES || '')
        .split(',')
        .map((pair) => pair.trim().split(':'))
        .filter((pair) => pair.length === 2 && pair[0] && pair[1])
        .map(([code, couponId]) => ({
            code: normalizeCode(code),
            kind: 'coupon',
            couponId,
            headline: 'Code applied',
            detail: 'Your discount is applied at checkout.',
            appliesTo: null,
            firstTimeOnly: false,
            active: true,
        }));
}

// The built-in table and the env codes, no database. Kept separate so the
// admin endpoint can refuse a new code that would shadow a built-in one.
function findStaticPromo(code) {
    const c = normalizeCode(code);
    if (!c) return null;
    const promo = PROMOS[c];
    if (promo && promo.active) return promo;
    return envCouponPromos().find((p) => p.code === c) || null;
}

// A PromoCode document in the shape the rest of this file works with.
function fromDoc(doc) {
    const a = doc.appliesTo || {};
    const appliesTo =
        a.tier || a.interval || a.movesPerWeek
            ? { tier: a.tier || undefined, interval: a.interval || undefined, movesPerWeek: a.movesPerWeek || undefined }
            : null;
    return {
        code: doc.code,
        kind: doc.kind,
        percentOff: doc.percentOff,
        amountOffCents: doc.amountOffCents,
        duration: doc.duration || 'once',
        durationInMonths: doc.durationInMonths,
        trialDays: doc.trialDays,
        appliesTo,
        firstTimeOnly: !!doc.firstTimeOnly,
        headline: doc.headline || null,
        detail: doc.detail || null,
        rep: doc.rep || null,
        stripeCouponId: doc.stripeCouponId || null,
        promoCodeId: doc._id,
        active: true,
        source: 'db',
    };
}

// A code from the database, if one is live under this name. A code that is
// switched off, expired or used up reads as no code at all, so a built-in
// code of the same name (there should never be one) is the fallback.
async function findDbPromo(c) {
    // No connection means no admin codes to find. Without this a script or
    // test that never connected would wait out Mongoose's buffering timeout
    // on every lookup.
    if (mongoose.connection.readyState !== 1) return null;
    const doc = await PromoCode.findOne({ code: c, active: true }).lean();
    if (!doc) return null;
    if (doc.expiresAt && new Date(doc.expiresAt).getTime() <= Date.now()) return null;
    if (doc.maxRedemptions && (doc.redemptions || 0) >= doc.maxRedemptions) return null;
    return fromDoc(doc);
}

// Admin-made codes first, then the built-in table, then the env coupons.
async function findPromo(code) {
    // A phone number is a rep's or a customer's referral code.
    if (phoneCode(code)) return findPhonePromo(code);
    const c = normalizeCode(code);
    if (!c) return null;
    const fromDb = await findDbPromo(c);
    if (fromDb) return fromDb;
    return findStaticPromo(c);
}

// Does the promo cover the plan the customer picked? Returns null when it
// does, or the sentence to show them when it does not.
function planMismatch(promo, { tier, interval, movesPerWeek }) {
    const wants = promo && promo.appliesTo;
    if (!wants) return null;
    const fits =
        (!wants.tier || tier === wants.tier) &&
        (!wants.interval || interval === wants.interval) &&
        (!wants.movesPerWeek || Number(movesPerWeek) === wants.movesPerWeek);
    if (fits) return null;

    const plan = wants.tier ? getPlan(wants.tier) : null;
    const unit = wants.interval === 'week' ? 'week' : 'month';
    // An admin's code can pin the interval alone.
    if (!plan) {
        return wants.interval
            ? `${promo.code} covers plans billed by the ${unit}.`
            : `${promo.code} does not cover this plan.`;
    }
    const name = plan.name;
    const billed = wants.interval ? `, billed by the ${unit}` : '';
    // Permanent valet is priced by its address, so there is no one number to
    // quote for it here. Naming one would be wrong for most of Manhattan.
    if (plan.pricedByAddress || !wants.interval) {
        return `${promo.code} covers the ${name} plan${billed}.`;
    }
    // Describe the plan the code actually covers. This sentence used to be
    // written for HANDSFREE alone and said "one move a week, billed monthly"
    // no matter which promo produced it — with a second code in the table it
    // would have told a two-move customer the wrong thing about their own
    // offer.
    const price = priceFor(wants.tier, wants.interval);
    // Only a per-move plan is bought by the move. Spelling a weekly cadence on
    // a flat plan describes a product we do not sell.
    const perMove = plan && plan.perMove;
    if (!perMove) {
        return `${promo.code} covers the ${name} plan at $${Math.round(price.amountCents / 100)} a ${unit}.`;
    }
    if (!wants.movesPerWeek) {
        return `${promo.code} covers the ${name} plan${billed}.`;
    }
    const moves = wants.movesPerWeek;
    const dollars = Math.round((price.amountCents * moves) / 100);
    const spelled = ['', 'one', 'two', 'three', 'four'][moves] || String(moves);
    const cadence = `${spelled} move${moves === 1 ? '' : 's'} a week`;
    return `${promo.code} covers the ${name} plan at $${dollars} a ${unit} — ${cadence}.`;
}

// The plan a code puts the customer on. A code locked to one plan snaps the
// customer onto it rather than turning them away at the last screen; a field
// the code leaves open keeps the customer's own choice. Null when the code
// covers any plan.
function applyToFor(promo, choice = {}) {
    const wants = promo && promo.appliesTo;
    if (!wants) return null;
    const tier = wants.tier || choice.tier;
    return {
        tier,
        interval: wants.interval || choice.interval,
        // Moves a week only mean something on the plan the customer picked.
        movesPerWeek: wants.movesPerWeek ?? (tier === choice.tier ? choice.movesPerWeek : undefined),
    };
}

// Has this customer already had their free month? Trial codes are for a
// first plan, so a customer whose plan has ever started is past it.
async function promoRedemptionBlock(promo, userId) {
    if (!promo || !promo.firstTimeOnly || !userId) return null;
    // Only a plan that actually STARTED counts as a plan they have had. A
    // purchase abandoned at the payment sheet leaves a voided doc behind,
    // and that must not lock the customer out of their own free month when
    // they come back and try again.
    const prior = await Subscription.findOne({
        user: userId,
        $or: [{ activatedAt: { $exists: true, $ne: null } }, { 'payments.0': { $exists: true } }],
    })
        .select('_id promoCode')
        .lean();
    if (!prior) return null;
    return prior.promoCode === promo.code
        ? `You have already used ${promo.code}.`
        : `${promo.code} is for a first plan, and yours has already started once.`;
}

// ---------------------------------------------------------------------------
// Percent and amount codes
// ---------------------------------------------------------------------------

const UNUSABLE_MESSAGE = "That code can't be used on this plan.";

// Stripe's floor is 50 cents; a dollar is the same nominal line the trial
// card check uses. Below it, a first invoice can settle with no
// PaymentIntent and no card, and the plan lapses on the second bill.
const MIN_FIRST_INVOICE_CENTS = 100;

function isDiscount(promo) {
    return !!promo && (promo.kind === 'percent_off' || promo.kind === 'amount_off' || !!promo.friendDiscount);
}

// ---------------------------------------------------------------------------
// A friend's referral code on a Permanent valet pass
// ---------------------------------------------------------------------------
//
// The friend gets $50 off their first month; the referrer is still paid as
// before. The promo keeps kind 'referral' so the referral credit paths are
// untouched. Not `appliesTo`: planMismatch would then refuse the code on a
// street-cleaning plan and the referrer would lose the credit.

const FRIEND_DISCOUNT = { amountOffCents: 5000, duration: 'once', tier: 'home_garage', couponId: 'FRIEND50' };

/**
 * The promo with the friend's $50 on it when it is a friend's code on a
 * Permanent valet pass and this customer has never started a plan; otherwise
 * the promo unchanged. With no userId (the public price card) it is shown.
 */
async function withFriendDiscount(promo, tier, userId) {
    if (!promo || promo.kind !== 'referral' || tier !== FRIEND_DISCOUNT.tier) return promo;
    if (userId && mongoose.isValidObjectId(userId)) {
        const prior = await Subscription.findOne({
            user: userId,
            $or: [{ activatedAt: { $exists: true, $ne: null } }, { 'payments.0': { $exists: true } }],
        })
            .select('_id')
            .lean();
        if (prior) return promo;
    }
    return {
        ...promo,
        friendDiscount: true,
        amountOffCents: FRIEND_DISCOUNT.amountOffCents,
        duration: FRIEND_DISCOUNT.duration,
        headline: '$50 off your first month',
    };
}

function money(cents) {
    const n = (cents || 0) / 100;
    return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** One bill at `amountCents` with the code's discount taken off. */
function discountedCents(promo, amountCents) {
    if (promo.kind === 'percent_off') {
        return Math.round((amountCents * (100 - promo.percentOff)) / 100);
    }
    if (promo.kind === 'amount_off' || promo.friendDiscount) return Math.max(0, amountCents - promo.amountOffCents);
    return amountCents;
}

/**
 * A percent/amount code that would leave the first bill under $1 is refused.
 * A free first period has to be a free_trial code — for the card-on-file
 * reason at the top of this file. Returns the sentence, or null.
 */
function discountRefusal(promo, amountCents) {
    if (!isDiscount(promo) || typeof amountCents !== 'number') return null;
    return discountedCents(promo, amountCents) < MIN_FIRST_INVOICE_CENTS ? UNUSABLE_MESSAGE : null;
}

function discountHeadline(promo, interval) {
    const off = promo.kind === 'percent_off' ? `${promo.percentOff}% off` : `${money(promo.amountOffCents)} off`;
    if (promo.duration === 'forever') return off;
    if (promo.duration === 'repeating') {
        const n = promo.durationInMonths || 1;
        return `${off} for ${n} month${n === 1 ? '' : 's'}`;
    }
    return `${off} your first ${interval === 'week' ? 'week' : 'month'}`;
}

function addMonths(date, n) {
    const d = new Date(date.getTime());
    d.setUTCMonth(d.getUTCMonth() + n);
    return d;
}

// When full price starts again, or null when it never does.
function discountEndsAt(promo, interval, now) {
    if (promo.duration === 'forever') return null;
    if (promo.duration === 'repeating') return addMonths(now, promo.durationInMonths || 1);
    return interval === 'week' ? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) : addMonths(now, 1);
}

// What the customer is shown before they subscribe.
function describe(promo, { amountCents, interval, now = new Date() } = {}) {
    const thenInterval = interval || (promo.appliesTo && promo.appliesTo.interval) || 'month';
    const base = {
        code: promo.code,
        kind: promo.kind,
        headline: promo.headline,
        detail: promo.detail,
    };
    if (isDiscount(promo)) {
        const hasAmount = typeof amountCents === 'number';
        const due = hasAmount ? discountedCents(promo, amountCents) : null;
        const endsAt = discountEndsAt(promo, thenInterval, now);
        return {
            ...base,
            headline: promo.headline || discountHeadline(promo, thenInterval),
            detail:
                promo.detail ||
                (promo.duration === 'forever'
                    ? 'Taken off every bill.'
                    : promo.duration === 'repeating'
                    ? `Taken off every bill for ${promo.durationInMonths || 1} month${(promo.durationInMonths || 1) === 1 ? '' : 's'}.`
                    : 'Taken off your first bill.'),
            percentOff: promo.kind === 'percent_off' ? promo.percentOff : null,
            amountOffCents: promo.kind === 'amount_off' || promo.friendDiscount ? promo.amountOffCents : null,
            duration: promo.duration,
            durationInMonths: promo.duration === 'repeating' ? promo.durationInMonths : null,
            dueTodayCents: due,
            discountCents: hasAmount ? amountCents - due : null,
            // After the discount runs out; a forever discount never does.
            thenCents: hasAmount ? (promo.duration === 'forever' ? due : amountCents) : null,
            thenFrom: endsAt,
            thenInterval,
            requiresCard: true,
        };
    }
    if (promo.kind === 'rep' || promo.kind === 'referral') {
        // A rep's or a referrer's code is credit, not a discount. The
        // customer pays the price.
        return {
            ...base,
            headline: promo.headline || 'Code applied',
            detail: promo.detail || null,
            dueTodayCents: amountCents ?? null,
            discountCents: 0,
            thenCents: amountCents ?? null,
            thenInterval,
            requiresCard: true,
        };
    }
    if (promo.kind !== 'free_trial') {
        return { ...base, dueTodayCents: null, requiresCard: true };
    }
    const endsAt = new Date(now.getTime() + promo.trialDays * 24 * 60 * 60 * 1000);
    return {
        ...base,
        headline: promo.headline || `First ${promo.trialDays} days free`,
        detail:
            promo.detail ||
            'Your card is saved now and charged when the free time ends. Cancel before then and you are never charged.',
        trialDays: promo.trialDays,
        trialEndsAt: endsAt,
        dueTodayCents: 0,
        // What lands on the card when the free month ends.
        thenCents: amountCents ?? null,
        thenInterval,
        // A card is taken up front so the plan converts instead of lapsing.
        requiresCard: true,
    };
}

/**
 * The Stripe coupon behind a percent/amount code, minted the first time the
 * code is used and stored on it. The idempotency key makes two first uses
 * at the same moment get the same coupon back.
 */
async function ensureStripeCoupon(promo) {
    if (!isDiscount(promo)) return null;
    if (promo.stripeCouponId) return promo.stripeCouponId;
    const stripe = stripeClient.get();
    if (!stripe) throw new Error('Stripe API key not configured');
    if (promo.friendDiscount) {
        // One shared coupon with a fixed id, so it never doubles up.
        const id = FRIEND_DISCOUNT.couponId;
        try {
            await stripe.coupons.retrieve(id);
        } catch (err) {
            if (err.statusCode !== 404 && err.code !== 'resource_missing') throw err;
            await stripe.coupons.create({
                id,
                amount_off: FRIEND_DISCOUNT.amountOffCents,
                currency: 'usd',
                duration: FRIEND_DISCOUNT.duration,
                name: "$50 off your first month (a friend's code)",
                metadata: { kind: 'friend_referral' },
            });
        }
        return id;
    }
    const id = String(promo.promoCodeId || promo.code);
    const coupon = await stripe.coupons.create(
        {
            ...(promo.kind === 'percent_off'
                ? { percent_off: promo.percentOff }
                : { amount_off: promo.amountOffCents, currency: 'usd' }),
            duration: promo.duration || 'once',
            ...(promo.duration === 'repeating' ? { duration_in_months: promo.durationInMonths || 1 } : {}),
            name: promo.code,
            metadata: { promoCode: promo.code, promoCodeId: id },
        },
        { idempotencyKey: `promo-coupon-${id}` }
    );
    if (promo.promoCodeId) {
        await PromoCode.updateOne(
            { _id: promo.promoCodeId, stripeCouponId: { $exists: false } },
            { $set: { stripeCouponId: coupon.id } }
        );
    }
    promo.stripeCouponId = coupon.id;
    return coupon.id;
}

/**
 * Count the subscription's code against the code's redemptions — once, when
 * the plan activates. The guard field makes a replayed webhook a no-op.
 * Built-in codes have no document, so for them this only stamps the guard.
 */
async function countRedemption(sub) {
    if (!sub || !sub.promoCode || sub.promoRedemptionCountedAt) return false;
    const now = new Date();
    const claimed = await Subscription.updateOne(
        { _id: sub._id, promoRedemptionCountedAt: { $exists: false } },
        { $set: { promoRedemptionCountedAt: now } }
    );
    if (!claimed.modifiedCount) return false;
    sub.promoRedemptionCountedAt = now;
    await PromoCode.updateOne({ code: normalizeCode(sub.promoCode) }, { $inc: { redemptions: 1 } });
    return true;
}

// ---------------------------------------------------------------------------
// Admin: making and editing codes
// ---------------------------------------------------------------------------

const DURATIONS = ['once', 'repeating', 'forever'];

/**
 * Check an admin's new code and save it. Returns { code } or { error }.
 *   { code, kind, percentOff?, amountOffCents?, duration?, durationInMonths?,
 *     trialDays?, appliesTo?, firstTimeOnly?, maxRedemptions?, expiresAt?,
 *     rep?, headline?, detail? }
 * A name that a built-in or env code already uses is refused: the customer
 * would type one and get the other.
 */
async function createCode(input = {}, createdBy = 'admin') {
    const code = normalizeCode(input.code);
    if (!/^[A-Z0-9]{3,24}$/.test(code)) return { error: 'A code is 3 to 24 letters or digits.' };
    if (findStaticPromo(code)) return { error: `${code} is a built-in code.` };
    if (await PromoCode.exists({ code })) return { error: `${code} already exists.` };

    const kind = input.kind;
    const doc = { code, kind, createdBy };
    if (kind === 'percent_off') {
        const pct = Number(input.percentOff);
        // 100% would make the first bill $0, which only a trial may do.
        if (!Number.isInteger(pct) || pct < 1 || pct > 99) return { error: 'Percent off is 1 to 99.' };
        doc.percentOff = pct;
    } else if (kind === 'amount_off') {
        const cents = Number(input.amountOffCents);
        if (!Number.isInteger(cents) || cents < 100) return { error: 'Amount off is at least $1, in cents.' };
        doc.amountOffCents = cents;
    } else if (kind === 'free_trial') {
        const days = Number(input.trialDays);
        if (!Number.isInteger(days) || days < 1 || days > 90) return { error: 'A free trial is 1 to 90 days.' };
        doc.trialDays = days;
    } else if (kind === 'rep') {
        if (!input.rep || !mongoose.isValidObjectId(input.rep)) return { error: 'A rep code needs the rep.' };
    } else {
        return { error: 'kind is percent_off, amount_off, free_trial or rep.' };
    }
    if (input.rep !== undefined && input.rep !== null && input.rep !== '') {
        if (!mongoose.isValidObjectId(input.rep)) return { error: 'rep must be a rep id.' };
        doc.rep = input.rep;
    }
    if (isDiscount(doc)) {
        const duration = input.duration || 'once';
        if (!DURATIONS.includes(duration)) return { error: 'duration is once, repeating or forever.' };
        doc.duration = duration;
        if (duration === 'repeating') {
            const months = Number(input.durationInMonths);
            if (!Number.isInteger(months) || months < 1 || months > 24) {
                return { error: 'A repeating discount lasts 1 to 24 months.' };
            }
            doc.durationInMonths = months;
        }
    }
    const a = input.appliesTo || {};
    if (a.tier && !getPlan(a.tier)) return { error: `${a.tier} is not a plan.` };
    if (a.interval && !['week', 'month'].includes(a.interval)) return { error: 'interval is week or month.' };
    if (a.tier || a.interval || a.movesPerWeek) {
        doc.appliesTo = {
            ...(a.tier ? { tier: a.tier } : {}),
            ...(a.interval ? { interval: a.interval } : {}),
            ...(a.movesPerWeek ? { movesPerWeek: Number(a.movesPerWeek) } : {}),
        };
    }
    doc.firstTimeOnly = !!input.firstTimeOnly;
    if (input.maxRedemptions) {
        const max = Number(input.maxRedemptions);
        if (!Number.isInteger(max) || max < 1) return { error: 'maxRedemptions is a whole number.' };
        doc.maxRedemptions = max;
    }
    if (input.expiresAt) {
        const at = new Date(input.expiresAt);
        if (!Number.isFinite(at.getTime())) return { error: 'expiresAt is not a date.' };
        doc.expiresAt = at;
    }
    if (input.headline) doc.headline = String(input.headline).trim();
    if (input.detail) doc.detail = String(input.detail).trim();
    try {
        return { code: (await PromoCode.create(doc)).toObject() };
    } catch (err) {
        if (err && err.code === 11000) return { error: `${code} already exists.` };
        throw err;
    }
}

/**
 * Switch a code on or off, or change its cap, expiry or wording. Its terms
 * (kind, amount, duration) do not change once made: a customer may already
 * hold a Stripe coupon minted from them. Returns { code } or { error }.
 */
async function updateCode(rawCode, patch = {}) {
    const code = normalizeCode(rawCode);
    const set = {};
    const unset = {};
    if (patch.active !== undefined) set.active = !!patch.active;
    if (patch.maxRedemptions !== undefined) {
        if (patch.maxRedemptions === null) unset.maxRedemptions = 1;
        else if (!Number.isInteger(Number(patch.maxRedemptions)) || Number(patch.maxRedemptions) < 1) {
            return { error: 'maxRedemptions is a whole number.' };
        } else set.maxRedemptions = Number(patch.maxRedemptions);
    }
    if (patch.expiresAt !== undefined) {
        if (patch.expiresAt === null) unset.expiresAt = 1;
        else {
            const at = new Date(patch.expiresAt);
            if (!Number.isFinite(at.getTime())) return { error: 'expiresAt is not a date.' };
            set.expiresAt = at;
        }
    }
    for (const field of ['headline', 'detail']) {
        if (patch[field] !== undefined) set[field] = String(patch[field] || '').trim();
    }
    const updated = await PromoCode.findOneAndUpdate(
        { code },
        { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
        { new: true }
    ).lean();
    if (!updated) return { error: `No code named ${code}.` };
    return { code: updated };
}

/** Every admin code, newest first, and the built-in ones for reference. */
async function listCodes() {
    const codes = await PromoCode.find({}).sort({ createdAt: -1 }).lean();
    const builtIn = Object.values(PROMOS)
        .filter((p) => p.active)
        .map((p) => ({ code: p.code, kind: p.kind, trialDays: p.trialDays, appliesTo: p.appliesTo, builtIn: true }));
    return { codes, builtIn };
}

module.exports = {
    PROMOS,
    UNUSABLE_MESSAGE,
    normalizeCode,
    findPromo,
    findStaticPromo,
    planMismatch,
    applyToFor,
    promoRedemptionBlock,
    describe,
    trialLabel,
    isDiscount,
    discountedCents,
    discountRefusal,
    ensureStripeCoupon,
    withFriendDiscount,
    FRIEND_DISCOUNT,
    countRedemption,
    createCode,
    updateCode,
    listCodes,
};
