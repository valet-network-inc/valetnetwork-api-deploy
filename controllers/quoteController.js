/**
 * quoteController — "what will this booking actually cost me?"
 *
 * POST /api/subscription/quote
 *
 * Both clients price a booking locally off GET /api/pricing, and neither of
 * them knows anything about plans. So the review screen showed a customer on
 * the $250 plan a button reading "Pay & park · $10.00" for a park their plan
 * covers. They were not over-charged — createOrder asks
 * `evaluateParkCoverage`, gets a yes, and returns paymentStatus 'paid' — but
 * being told you owe $10 to use the thing you pay $250 a month for is a reason
 * not to park at all.
 *
 * This endpoint answers the question before the customer commits, using the
 * same functions the booking path uses:
 *
 *   services/subscriptionService.evaluateParkCoverage  — is it covered
 *   services/orderPricing.priceOrderCents              — what it costs
 *
 * Nothing here re-implements either. That is the whole point: a quote computed
 * a second way is a quote that can disagree with the charge, and a customer
 * promised free and then charged is worse than the bug this closes.
 *
 * The wording is server-side on purpose. Three clients writing their own copy
 * for eight reason codes is three chances to word a refusal as an approval.
 *
 * What it deliberately does NOT price: event codes. Their validation (scope,
 * allowedPhones, once-per-customer) lives in createOrder and mirroring it here
 * would be exactly the second implementation this file exists to avoid. A
 * customer holding a code still sees whatever their client shows them today.
 *
 * Exposure: this reads a plan by userId, the same as GET /api/subscription/
 * status/:userId, which already returns the customer's home address outright.
 * It adds no field that endpoint does not already hand out.
 */

const User = require('../models/User');
const subscriptionService = require('../services/subscriptionService');
const orderPricing = require('../services/orderPricing');
const { HOME_RADIUS_METERS, getPlan } = require('../services/subscriptionPlans');

// $10 rather than $10.00 when there are no cents. Rishi's rule for any number a
// customer reads: as few characters as carry the meaning.
const money = (cents) => {
    const dollars = (Number(cents) || 0) / 100;
    return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
};

// Distances read as blocks. A Brooklyn block is about 80 m — the same figure
// services/subscriptionPlans.js cites where HOME_RADIUS_METERS is set — and
// "5 blocks from home" is something a person standing on a corner can picture.
// Distance rounds up and the radius rounds down so the two can never print as
// the same number in one sentence.
const BLOCK_METERS = 80;
const blocksAway = (meters) => Math.max(1, Math.ceil(meters / BLOCK_METERS));
const blocksWithin = (meters) => Math.max(1, Math.floor(meters / BLOCK_METERS));

/**
 * Plain words for one reason code.
 *
 * `label` is the short line a client prints next to the button. `detail` is one
 * sentence that says what happened and ends with what to do about it — the
 * customer clicks, they do not hover, so nothing important hides behind a
 * tooltip.
 *
 * Every refusal names its cause. A customer four blocks from their fixed
 * address has to be told that is why, before they commit, or they learn it from
 * a charge.
 */
function describe(reason, ctx) {
    const price = money(ctx.priceCents);

    switch (reason) {
        // --- covered -------------------------------------------------------
        case 'daily_free_park':
            return {
                label: 'Free with your plan',
                detail: 'This is your free park for today. Tap Park — nothing to pay.',
            };
        case 'asp_move_covered':
            return {
                label: 'Free with your plan',
                detail:
                    'Your plan pays for this street cleaning move. Tap Park — nothing to pay.',
            };

        // --- already paid for, without a plan ------------------------------
        case 'retrieval_included_with_park':
            return {
                label: 'Already paid',
                detail: 'You paid for the ride back when you parked. Tap to get your car.',
            };

        // --- refusals ------------------------------------------------------
        case 'no_active_subscription':
            return {
                label: `${price} to park`,
                detail: `You do not have a plan, so this park is ${price}. Tap Pay & park.`,
            };
        case 'weekly_asp_limit_reached': {
            const n = ctx.movesPerWeek;
            const moves = n === 1 ? 'move' : 'moves';
            return {
                label: `Not covered — this week's ${moves} are used`,
                detail: `Your plan pays for ${n} street cleaning ${moves} a week and this week's are used. This one is ${price}. Tap Pay & park, or wait for Monday.`,
            };
        }
        case 'tier_has_no_free_park':
            return {
                label: 'Not covered — your plan is street cleaning',
                detail: `Your plan pays for street cleaning moves. Other parks are ${price}. Tap Pay & park.`,
            };
        case 'daily_free_park_used':
            return {
                label: "Not covered — today's free park is used",
                detail: `Your plan gives one free park a day and today's is used. This one is ${price}. Tap Pay & park, or park free tomorrow.`,
            };
        case 'no_home_address_on_file':
            return {
                label: 'Not covered — no home spot saved',
                detail: `Your free park works at your home spot and none is saved. Add your home spot in your plan, or pay ${price} for this park.`,
            };
        case 'order_location_missing':
            return {
                label: "Not covered — we can't see your spot",
                detail:
                    'We need your map pin to check it against your home spot. Drop the pin again.',
            };
        case 'not_at_home_address':
            return {
                label: `Not covered — about ${blocksAway(ctx.distanceMeters)} blocks from home`,
                detail: `Your free park works about ${blocksWithin(
                    HOME_RADIUS_METERS
                )} blocks from your home spot and this is about ${blocksAway(
                    ctx.distanceMeters
                )} blocks away. Park here for ${price}, or move the pin closer to home.`,
            };
        case 'car_watch_not_covered':
            return {
                label: 'Not covered — Car Watch is an add-on',
                detail: `Car Watch is extra, so this booking is ${price}. Turn Car Watch off to use your free park.`,
            };
        case 'away_not_covered':
            return {
                label: 'Not covered — away trips are priced by the trip',
                detail: `An away trip is priced by the days and moves you picked, so it is ${price}. Tap Pay & park.`,
            };
        case 'retrieval_not_covered':
            return {
                label: `${price} to bring it back`,
                detail: `Plans pay for parking, so a trip to bring your car back on its own is ${price}. Tap Pay.`,
            };
        default:
            // Unreachable unless evaluateParkCoverage grows a reason code. Say
            // the price and nothing about coverage — inventing an approval here
            // is how a customer gets promised free and charged anyway.
            return {
                label: `${price} to park`,
                detail: `This booking is ${price}. Tap Pay & park.`,
            };
    }
}

/**
 * POST /api/subscription/quote
 *
 * Body: { userId, orderType?, aspMode?, lat?, lng?, serviceType?,
 *         carWatch?, duration?, originalOrderId?,
 *         awayMode?, awayService?, awayDays?, pickUpTime?, awayEndTime? }
 *
 * The first six are what a booking screen has. The rest are forwarded to the
 * same pricer createOrder uses so the number comes back right for the bookings
 * that carry them — a Car Watch add-on or an away trip quoted at the plain park
 * price would be the same lie in the other direction.
 *
 * Response: { success, covered, reason, label, detail, priceCents,
 *             listPriceCents, savedCents, plan }
 *
 * `priceCents` is the only number to render, and 0 means there is no payment
 * step. `covered` says whether a plan is the reason it is 0 — a pre-paid
 * retrieval is 0 and not covered.
 */
exports.quoteOrder = async (req, res) => {
    const {
        // The iOS client spells this `customer`, matching what createOrder
        // passes into evaluateParkCoverage; web spells it `userId`. Accept both
        // — a name mismatch here fails silently as "no plan", which reads to the
        // customer as an ordinary full-price quote and hides the whole fix.
        userId: userIdRaw,
        customer: customerRaw,
        orderType,
        aspMode,
        lat,
        lng,
        serviceType,
        carWatch,
        duration,
        originalOrderId,
        awayMode,
        awayService,
        awayDays,
        pickUpTime,
        awayEndTime,
    } = req.body || {};
    const userId = userIdRaw || customerRaw;

    try {
        if (!userId) {
            return res.status(400).json({ success: false, message: 'userId is required' });
        }
        const user = await User.findById(userId).select('_id');
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const finalOrderType = orderType || 'parking';
        const finalServiceType = serviceType || 'standard';

        // What this booking costs with no plan involved. Same call, same
        // arguments, same order of precedence as createOrder — so the number on
        // the review screen is the number that reaches Stripe.
        const quote = await orderPricing.priceOrderCents({
            orderType: finalOrderType,
            serviceType: finalServiceType,
            aspMode,
            carWatch,
            duration,
            awayMode,
            awayService,
            awayDays,
            pickUpTime,
            awayEndTime,
        });
        const listPriceCents = quote.amountCents;

        const sub = await subscriptionService.getActiveSubscription(userId);
        const plan = sub ? getPlan(sub.tier) : null;

        let covered = false;
        let reason;
        let priceCents = listPriceCents;
        let distanceMeters = 0;

        if (finalOrderType === 'retrieval') {
            // Coverage never runs on a retrieval — createOrder gates it on
            // orderType 'parking' — so asking evaluateParkCoverage here would be
            // inventing an answer the booking path will not honour.
            //
            // A retrieval booked against a park is already paid for:
            // createRetrievalOrder zeroes every linked leg (the park-and-hold
            // portion was collected at parking time). Only a standalone one
            // costs the $5.
            if (originalOrderId) {
                reason = 'retrieval_included_with_park';
                priceCents = 0;
            } else if (!sub) {
                reason = 'no_active_subscription';
            } else {
                reason = 'retrieval_not_covered';
            }
        } else if (!sub) {
            // Checked before the add-on gates below so a per-use customer is
            // told they have no plan rather than that something is "not
            // covered" — the same precedence isEntitled has inside
            // evaluateParkCoverage.
            reason = 'no_active_subscription';
        } else if (awayMode) {
            // createOrder refuses coverage on away bookings: the weekly cap
            // means nothing across a multi-week hold.
            reason = 'away_not_covered';
        } else if (carWatch) {
            // createOrder refuses coverage on a Car Watch booking too — zeroing
            // the order would hand over the paid add-on with it.
            reason = 'car_watch_not_covered';
        } else {
            const coverage = await subscriptionService.evaluateParkCoverage(sub, {
                aspMode: !!aspMode,
                lat,
                lng,
                // Same server-priced figure createOrder stamps on the order, so
                // the value indicator and this quote cannot drift.
                listPriceCents: await subscriptionService.parkListPriceCents({
                    aspMode: !!aspMode,
                    serviceType: finalServiceType,
                }),
            });
            covered = !!coverage.covered;
            reason = coverage.reason;
            if (covered) priceCents = 0;

            if (reason === 'not_at_home_address') {
                distanceMeters = subscriptionService.haversineMeters(
                    { lat, lng },
                    { lat: sub.homeAddress.lat, lng: sub.homeAddress.lng }
                );
            }
        }

        const words = describe(reason, {
            priceCents,
            listPriceCents,
            distanceMeters,
            movesPerWeek: sub ? sub.movesPerWeek || 2 : 2,
        });

        return res.status(200).json({
            success: true,
            covered,
            reason,
            label: words.label,
            detail: words.detail,
            priceCents,
            listPriceCents,
            // For "you saved" copy. Only a plan saves anything here; a pre-paid
            // retrieval was paid for at the park, so claiming a saving on it
            // would be counting the same dollars twice.
            savedCents: covered ? Math.max(0, listPriceCents - priceCents) : 0,
            // Whether this park has an end time at all. Deliberately NOT tied
            // to `covered`: the second park of a day is charged for and still
            // indefinite. The clients drop the duration step on this, so it has
            // to answer for the paid case too.
            indefinite:
                (orderType || 'parking') === 'parking' &&
                !awayMode &&
                subscriptionService.parkIsIndefinite(sub, { lat, lng }),
            indefiniteLabel: 'Parked until you ask for it back',
            plan: plan
                ? { tier: sub.tier, name: plan.name, movesPerWeek: sub.movesPerWeek || 2 }
                : null,
        });
    } catch (err) {
        console.error('quoteOrder error:', err);
        return res.status(500).json({
            success: false,
            message: 'Could not price that booking',
            error: err.message,
        });
    }
};
