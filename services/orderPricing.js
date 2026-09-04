const PricingConfig = require('../models/PricingConfig');
const { nyStartOfDay } = require('./nyTime');

/**
 * The server's price for an order.
 *
 * Both clients quote a price locally off GET /api/pricing, because the customer
 * has to see a number before an order exists. That quote used to be the number
 * that reached Stripe: createOrder stored req.body.totalAmount verbatim and
 * createPaymentIntent charged it, so anyone who could POST an order could name
 * their own price — and the same field feeds valetPayBaseCents, so an inflated
 * one paid a valet 70% of an invented number.
 *
 * This module recomputes the amount from the customer's CHOICES (service,
 * duration, add-ons) using the same formula the clients display, so the quote
 * is now something to check the client against rather than something to trust.
 *
 * Keep in step with:
 *   mobile — screens/customer/OrderPreferencesScreen.js (carWatchCentsFor, amountCents)
 *   web    — src/lib/park/pricing.ts (quote)
 * All three implement one formula; if you change one, change all three.
 */

// An ASP move is a fixed 90-minute round trip on every client, so it prices off
// that rather than the booked duration.
const ASP_DURATION_MINUTES = 90;

// A no-schedule away "moves" booking takes this now — it proves the card and
// saves it — and setAwaySchedule collects the balance once the valet reads the
// sign. Mirrors AWAY_DEPOSIT_CENTS in orderController.
const AWAY_DEPOSIT_CENTS = 100;

// Mirrors PricingConfig's schema defaults, so a database blip prices the order
// instead of failing checkout.
const FALLBACK = {
    parkingCents: 1000,
    parkAndRetrieveCents: 1300,
    aspCents: 1500,
    retrievalCents: 500,
    carWatchPerHourCents: 100,
};

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

async function loadPricing() {
    try {
        const cfg = await PricingConfig.getSingleton();
        return {
            parkingCents: num(cfg.parkingCents, FALLBACK.parkingCents),
            parkAndRetrieveCents: num(cfg.parkAndRetrieveCents, FALLBACK.parkAndRetrieveCents),
            aspCents: num(cfg.aspCents, FALLBACK.aspCents),
            retrievalCents: num(cfg.retrievalCents, FALLBACK.retrievalCents),
            carWatchPerHourCents: num(cfg.carWatchPerHourCents, FALLBACK.carWatchPerHourCents),
        };
    } catch (err) {
        console.error('orderPricing: PricingConfig unavailable, using defaults:', err.message);
        return { ...FALLBACK };
    }
}

// Car Watch bills elapsed minutes at the hourly rate.
function carWatchCentsFor({ aspMode, durationMinutes, perHourCents }) {
    const minutes = aspMode ? ASP_DURATION_MINUTES : num(durationMinutes, 0);
    if (minutes <= 0) return 0;
    return Math.round((minutes / 60) * perHourCents);
}

// Whole NY calendar days between two instants — the client counts away nights
// as a difference of day offsets, so midnight boundaries decide, not elapsed
// hours.
function nyDaySpan(start, end) {
    const a = nyStartOfDay(new Date(start)).getTime();
    const b = nyStartOfDay(new Date(end)).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    return Math.round((b - a) / 86400000);
}

/**
 * Price an order from its choices.
 *
 * Returns { amountCents, carWatchCents, basis, pricing }. `basis` names the
 * branch that priced it, for logs and for the mismatch alert.
 *
 * Callers still own the zeroing rules — subscription coverage, event codes and
 * free service override this afterwards.
 */
async function priceOrderCents(input = {}) {
    const {
        orderType,
        serviceType,
        aspMode,
        carWatch,
        duration,
        awayMode,
        awayService,
        awayDays,
        pickUpTime,
        awayEndTime,
    } = input;

    const pricing = await loadPricing();

    if ((orderType || 'parking') === 'retrieval') {
        return {
            amountCents: pricing.retrievalCents,
            carWatchCents: 0,
            basis: 'retrieval',
            pricing,
        };
    }

    if (awayMode) {
        if (awayService === 'hold') {
            const nights = Math.max(1, nyDaySpan(pickUpTime, awayEndTime));
            return {
                amountCents: nights * pricing.parkingCents,
                carWatchCents: 0,
                basis: `away_hold:${nights}d`,
                pricing,
            };
        }

        // Per-move away booking. countAwayMoves in orderController is the
        // single pricing truth for these — booking here with the same count
        // the reconciler uses means setAwaySchedule finds nothing to true up
        // when the customer's own schedule was already right.
        const { countAwayMoves } = require('../controllers/orderController');
        let moves = 0;
        let counted = false;
        if (Array.isArray(awayDays) && awayDays.length && pickUpTime && awayEndTime) {
            try {
                moves = countAwayMoves(new Date(pickUpTime), new Date(awayEndTime), awayDays);
                counted = true;
            } catch (err) {
                console.error('orderPricing: countAwayMoves failed:', err.message);
                moves = 0;
            }
        }

        // Nobody has given us sweep days yet (or the ones we got would not
        // count): take the deposit and let the valet's schedule set the real
        // price. Charging $0 here would fail at Stripe's 50c minimum anyway.
        //
        // Only THIS case may land here. createOrder stamps
        // awayBilling 'pending_schedule' — the flag that makes the deposit a
        // deposit rather than the whole bill — solely when awayDays is empty,
        // and setAwaySchedule is what later collects the balance.
        if (!counted) {
            return {
                amountCents: AWAY_DEPOSIT_CENTS,
                carWatchCents: 0,
                basis: 'away_deposit',
                pricing,
            };
        }

        // A schedule whose sweeps all fall outside the trip is an ANSWER, not a
        // missing schedule — leave Friday, come back Sunday, sweep is Tuesday.
        // That used to drop into the deposit branch above and charge $1 for
        // parking, holding and returning the car across the whole trip, with
        // nothing to true it up (awayDays was non-empty, so no
        // 'pending_schedule' stamp was written) and the valet paid 70c for the
        // job. The customer never saw a dollar either: the app floors the
        // billed moves at one (OrderPreferencesScreen's Math.max(1, ...)), so
        // the pay button they tapped read $15.00. Charge the one move they
        // agreed to — we still do the park, the hold and the return.
        const billedMoves = Math.max(1, moves);

        return {
            amountCents: billedMoves * pricing.aspCents,
            carWatchCents: 0,
            basis: `away_moves:${billedMoves}`,
            pricing,
        };
    }

    // Ordinary park. aspMode wins over serviceType: both clients send
    // serviceType 'park-and-hold' alongside aspMode, and an ASP move is priced
    // as an ASP move.
    const base = aspMode
        ? pricing.aspCents
        : serviceType === 'park-and-hold'
        ? pricing.parkAndRetrieveCents
        : pricing.parkingCents;

    const carWatchCents = carWatch
        ? carWatchCentsFor({
              aspMode: !!aspMode,
              durationMinutes: duration,
              perHourCents: pricing.carWatchPerHourCents,
          })
        : 0;

    return {
        amountCents: base + carWatchCents,
        carWatchCents,
        basis: aspMode ? 'asp' : serviceType === 'park-and-hold' ? 'park-and-hold' : 'parking',
        pricing,
    };
}

module.exports = {
    priceOrderCents,
    carWatchCentsFor,
    nyDaySpan,
    loadPricing,
    ASP_DURATION_MINUTES,
    AWAY_DEPOSIT_CENTS,
    FALLBACK,
};
