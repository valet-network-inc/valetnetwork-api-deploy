/**
 * Crediting a subscriber for a street-cleaning day the city suspended.
 *
 * If the sweep does not happen, no valet moves the car and the customer has
 * paid for a move they did not get. That day comes back.
 *
 * TWO THINGS WORTH KNOWING ABOUT THE MATH
 *
 * 1. It is not a flat $12.50. A month contains four OR five of any given
 *    weekday — 4.33 on average — so a plan billed at $50/month for one move a
 *    week is worth $12.50 a move in a four-move month and $10.00 in a
 *    five-move one. Hardcoding $12.50 quietly over-refunds every five-move
 *    month, and that error grows with the subscriber count. So the value of a
 *    move is always `period price ÷ moves actually scheduled in that period`.
 *
 * 2. It is a Stripe customer balance credit, not a card refund. Refunds cost
 *    the processing fee again, take days, and give the customer's bank a
 *    reason to ask questions. A credit lands on the next invoice as a line
 *    that says what it was for, and costs nothing.
 */

const Stripe = require('stripe');
const AspCredit = require('../models/AspCredit');
const { nyDateKey } = require('./nyTime');

const stripe = process.env.STRIPE_API_KEY
    ? new Stripe(process.env.STRIPE_API_KEY)
    : null;

/**
 * How many scheduled moves fall inside this billing period.
 * Counted rather than assumed, which is the whole point.
 */
function scheduledMovesInPeriod(days, periodStart, periodEnd) {
    if (!Array.isArray(days) || !days.length) return 0;
    if (!periodStart || !periodEnd) return 0;

    const weekdays = new Set(days.map((d) => Number(d.weekday)));
    let count = 0;

    const cursor = new Date(periodStart);
    const end = new Date(periodEnd);
    // Walk day by day. Periods are a month at most, so this is ~31 iterations;
    // the 400 bound is only there so a corrupt period can never spin forever.
    for (let i = 0; i < 400 && cursor < end; i += 1) {
        // getUTCDay is safe here: we only need the count of matching weekdays
        // across the span, and a whole period contains whole weeks plus a
        // remainder that a timezone shift cannot change the size of.
        if (weekdays.has(cursor.getUTCDay())) count += 1;
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return count;
}

/** What one covered move is worth on this plan, in cents. */
function perMoveCents(sub) {
    const days = (sub._resolvedSchedule || sub.aspSchedule || {}).days || [];
    const moves = scheduledMovesInPeriod(
        days,
        sub.currentPeriodStart,
        sub.currentPeriodEnd
    );
    if (!moves || !sub.amountCents) return 0;
    return Math.round(sub.amountCents / moves);
}

/**
 * Credit one suspended day, once.
 *
 * Idempotent on (subscription, date): the scheduler retries an occurrence
 * every minute across its window, and a customer must not be credited
 * forty times for one holiday. The unique index on AspCredit is what actually
 * guarantees that; the pre-check is only there to save the round trip.
 */
async function creditSuspendedDay(sub, occurrence, suspension) {
    const dateKey = nyDateKey(occurrence);

    try {
        const already = await AspCredit.findOne({
            subscription: sub._id,
            date: dateKey,
        }).lean();
        if (already) return { credited: false, reason: 'already_credited' };

        const amountCents = perMoveCents(sub);
        if (amountCents <= 0) {
            console.warn(
                `Auto-ASP credit: could not price a move for subscription ${sub._id} — skipping credit for ${dateKey}`
            );
            return { credited: false, reason: 'unpriceable' };
        }

        // Write the ledger row FIRST. If Stripe then fails we retry the
        // transfer, not the decision — the alternative is a duplicate credit
        // whenever Stripe times out after succeeding.
        const record = await AspCredit.create({
            subscription: sub._id,
            user: sub.user,
            date: dateKey,
            amountCents,
            reason: suspension.reason,
            stripeStatus: 'pending',
        });

        if (!stripe || !sub.stripeCustomerId) {
            await AspCredit.updateOne(
                { _id: record._id },
                { $set: { stripeStatus: 'skipped', note: 'No Stripe customer on file' } }
            );
            return { credited: true, amountCents, stripe: false };
        }

        const tx = await stripe.customers.createBalanceTransaction(
            sub.stripeCustomerId,
            {
                // Negative reduces what they owe. Stripe's sign convention here
                // is the opposite of what it reads like.
                amount: -amountCents,
                currency: 'usd',
                description: `Street cleaning suspended ${dateKey} — ${suspension.reason}`,
                metadata: {
                    subscriptionId: String(sub._id),
                    date: dateKey,
                    reason: suspension.reason,
                },
            }
        );

        await AspCredit.updateOne(
            { _id: record._id },
            { $set: { stripeStatus: 'applied', stripeTransactionId: tx.id } }
        );

        console.log(
            `Auto-ASP: credited ${(amountCents / 100).toFixed(2)} to subscription ${sub._id} for suspended ${dateKey} (${suspension.reason})`
        );
        return { credited: true, amountCents, stripe: true };
    } catch (err) {
        // E11000 means another tick won the race — the correct outcome.
        if (err && err.code === 11000) return { credited: false, reason: 'already_credited' };
        console.error(`Auto-ASP credit failed for ${dateKey}:`, err.message);
        return { credited: false, reason: 'error', error: err.message };
    }
}

module.exports = {
    scheduledMovesInPeriod,
    perMoveCents,
    creditSuspendedDay,
};
