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
 *
 * LINKED ACCOUNTS (2026-09-23). The plan is the HOUSEHOLD's: the customer's
 * own, else the one their linked partner holds (services/accountLinks.js), the
 * same lookup validateSubscriptionForOrder hands createOrder. And a plan covers
 * one park at a time across the pair, so while some other car is riding it the
 * answer is `partner_park_live` — charged at list price and NOT indefinite,
 * which is exactly what createOrder does with that booking. The only new thing
 * this can say about somebody else is the partner's first name, which the pair
 * already see on each other's screens.
 */

const User = require('../models/User');
const Order = require('../models/Order');
const subscriptionService = require('../services/subscriptionService');
const accountLinks = require('../services/accountLinks');
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

// "Sam's", or "their" for an account with no first name on it. firstName is
// optional on User, and "them's plan" is worse than no name at all.
const possessive = (summary) => {
    const name = accountLinks.firstNameOf(summary, '');
    return name ? `${name}'s` : 'their';
};
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

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
 *
 * `ctx.holder` is set only for a linked partner riding the other one's plan
 * (the plan holder's summary). On their screen "your plan" is false — they
 * hold none, cannot change it, and cannot save a home spot on it — so every
 * sentence that says whose plan or whose home spot names the holder instead.
 * The holder, and everyone who is not linked, read exactly what they always
 * have.
 */
function describe(reason, ctx) {
    const price = money(ctx.priceCents);
    const partnersPlan = !!ctx.holder;
    const plan = partnersPlan ? `${possessive(ctx.holder)} plan` : 'your plan';
    const homeSpot = partnersPlan ? `${possessive(ctx.holder)} home spot` : 'your home spot';

    switch (reason) {
        // --- covered -------------------------------------------------------
        case 'daily_free_retrieval':
            return {
                label: `Free with ${plan}`,
                detail: "This is today's free retrieval. Tap Bring it back — nothing to pay.",
            };
        case 'daily_free_park':
            return {
                label: `Free with ${plan}`,
                detail: 'This is your free park for today. Tap Park — nothing to pay.',
            };
        case 'asp_move_covered':
            return {
                label: `Free with ${plan}`,
                detail: `${capitalize(
                    plan
                )} pays for this street cleaning move. Tap Park — nothing to pay.`,
            };

        // --- already paid for, without a plan ------------------------------
        case 'retrieval_included_with_park':
            // Bringing back the park your partner booked: they paid for it,
            // not you, and it is not your car.
            if (ctx.parkedBy) {
                const name = accountLinks.firstNameOf(ctx.parkedBy, '');
                return {
                    label: 'Already paid',
                    detail: name
                        ? `${name} paid for the ride back when they parked. Tap to get the car.`
                        : 'The ride back was paid for when the car was parked. Tap to get the car.',
                };
            }
            return {
                label: 'Already paid',
                detail: 'You paid for the ride back when you parked. Tap to get your car.',
            };

        // --- refusals ------------------------------------------------------
        case 'partner_park_live': {
            // One park at a time across a linked pair. Named only when the park
            // holding the plan is the booker's partner's — quoteOrder leaves
            // `busyName` empty for anyone else, an ex-partner included.
            const who = ctx.busyName;
            return {
                label: who
                    ? `Not covered — ${who}'s park is using the plan`
                    : 'Not covered — another park is using the plan',
                detail: "It's covered again once that park ends.",
            };
        }
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
                detail: `${capitalize(
                    plan
                )} pays for ${n} street cleaning ${moves} a week and this week's are used. This one is ${price}. Tap Pay & park, or wait for Monday.`,
            };
        }
        case 'tier_has_no_free_park':
            return {
                label: `Not covered — ${plan} is street cleaning`,
                detail: `${capitalize(
                    plan
                )} pays for street cleaning moves. Other parks are ${price}. Tap Pay & park.`,
            };
        case 'daily_free_park_used':
            // Across a linked pair this is one free park between them, so the
            // holder's park this morning is why the partner's is not free.
            return {
                label: "Not covered — today's free park is used",
                detail: `${capitalize(
                    plan
                )} gives one free park a day and today's is used. This one is ${price}. Tap Pay & park, or park free tomorrow.`,
            };
        case 'no_home_address_on_file':
            // The partner cannot save one — the plan screen is read-only for
            // them — so they are told who can.
            return {
                label: 'Not covered — no home spot saved',
                detail: partnersPlan
                    ? `The free park works at ${homeSpot} and none is saved. Ask ${
                          accountLinks.firstNameOf(ctx.holder, '') || 'them'
                      } to add it, or pay ${price} for this park.`
                    : `Your free park works at your home spot and none is saved. Add your home spot in your plan, or pay ${price} for this park.`,
            };
        case 'order_location_missing':
            return {
                label: "Not covered — we can't see your spot",
                detail: `We need your map pin to check it against ${homeSpot}. Drop the pin again.`,
            };
        case 'not_at_home_address':
            // The fixed address is the holder's. "From home" would be a guess
            // about where the partner lives.
            if (partnersPlan) {
                return {
                    label: `Not covered — about ${blocksAway(
                        ctx.distanceMeters
                    )} blocks from ${homeSpot}`,
                    detail: `The free park works about ${blocksWithin(
                        HOME_RADIUS_METERS
                    )} blocks from ${homeSpot} and this is about ${blocksAway(
                        ctx.distanceMeters
                    )} blocks away. Park here for ${price}, or move the pin closer to it.`,
                };
            }
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
                detail: `Street-cleaning plans pay for moves, so a trip to bring your car back on its own is ${price}. Tap Pay.`,
            };
        case 'daily_free_retrieval_used':
            return {
                label: `Not covered — today's free retrieval is used`,
                detail: `${plan.charAt(0).toUpperCase()}${plan.slice(1)} brings a car back free once a day, and today's is used. This one is ${price}. Tap Pay.`,
            };
        case 'retrieval_not_at_home_address':
            return {
                label: `Not covered — about ${blocksAway(ctx.distanceMeters)} blocks from ${homeSpot}`,
                detail: `The free retrieval brings the car to ${homeSpot}, and this is about ${blocksAway(
                    ctx.distanceMeters
                )} blocks away. This one is ${price}, or move the pin to ${homeSpot}.`,
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
 * Is another car riding this plan — and may the quote say whose?
 *
 * `false`, or `{ name }`: the booker's partner's first name when the park
 * holding the plan is theirs, '' when it is anyone else's (an ex-partner's park
 * still finishing on the plan) or they have no name on file. The rule itself is
 * accountLinks.coveredParkLiveBy, the one createOrder applies through
 * householdCoveredParkLive; this only decides what may be printed about it.
 */
async function planBusyFor(sub, userId, park) {
    const whose = await accountLinks.coveredParkLiveBy(sub, userId, park);
    if (!whose) return false;
    const partner = await accountLinks.partnerOf(userId);
    const name = partner && partner._id === whose ? accountLinks.firstNameOf(partner, '') : '';
    return { name };
}

/**
 * The partner's summary when the park being brought back is one THEY booked,
 * else null. Only changes the words: a linked retrieval is already paid for
 * whoever taps. Never throws — a bad id costs the sentence, not the quote.
 */
async function partnerWhoBooked(userId, orderId) {
    try {
        const order = await Order.findById(orderId).select('customer').lean();
        if (!order || String(order.customer) === String(userId)) return null;
        const partner = await accountLinks.partnerOf(userId);
        return partner && partner._id === String(order.customer) ? partner : null;
    } catch (err) {
        return null;
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

        // Their own plan, else the one their linked partner holds. `heldBy` is
        // 'self' for their own, the holder's summary for the partner's.
        const { sub, heldBy } = await accountLinks.getHouseholdSubscription(userId);
        const plan = sub ? getPlan(sub.tier) : null;
        const holder = sub && heldBy && heldBy !== 'self' ? heldBy : null;

        let covered = false;
        let reason;
        let priceCents = listPriceCents;
        let distanceMeters = 0;
        // Another car riding the plan (partner_park_live). Also switches off
        // `indefinite` below: createOrder neither covers nor holds that park.
        let planBusy = false;
        let busyName = '';
        let parkedBy = null;

        if (finalOrderType === 'retrieval') {
            // Coverage never runs on a retrieval — createOrder gates it on
            // orderType 'parking' — so asking evaluateParkCoverage here would be
            // inventing an answer the booking path will not honour.
            //
            // A retrieval booked against a park is already paid for:
            // createRetrievalOrder zeroes every linked leg (the park-and-hold
            // portion was collected at parking time). Only a standalone one
            // costs the $5.
            //
            // Never refused by the one-park-at-a-time rule: bringing a car back
            // is how a park ends, and that is what frees the plan.
            if (originalOrderId) {
                reason = 'retrieval_included_with_park';
                priceCents = 0;
                parkedBy = await partnerWhoBooked(userId, originalOrderId);
            } else if (!sub) {
                reason = 'no_active_subscription';
            } else {
                // The day's first one is on the flat plans (Nov 4 2026), the
                // same rule createOrder applies, judged on the day it happens.
                const at = new Date(pickUpTime);
                const rc = await subscriptionService.evaluateRetrievalCoverage(
                    sub,
                    { lat, lng, listPriceCents },
                    Number.isFinite(at.getTime()) ? at : new Date()
                );
                covered = !!rc.covered;
                reason = rc.reason;
                if (covered) priceCents = 0;
                if (reason === 'retrieval_not_at_home_address') {
                    distanceMeters = subscriptionService.haversineMeters(
                        { lat, lng },
                        { lat: sub.homeAddress.lat, lng: sub.homeAddress.lng }
                    );
                }
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
        } else if (
            (planBusy = await planBusyFor(sub, userId, {
                at: pickUpTime,
                durationMinutes: duration,
                indefinite: subscriptionService.parkIsIndefinite(sub, { lat, lng }),
            }))
        ) {
            // One park at a time across a linked pair, the same call createOrder
            // makes. Ahead of the Car Watch gate on purpose: "turn Car Watch off
            // to use your free park" would be a promise the plan cannot keep
            // while another car is on it.
            reason = 'partner_park_live';
            busyName = planBusy.name;
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
            holder,
            busyName,
            parkedBy,
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
            //
            // Except when another car is riding the plan: that park is an
            // ordinary paid one with an end time, not a second car held on it.
            indefinite:
                (orderType || 'parking') === 'parking' &&
                !awayMode &&
                !planBusy &&
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
