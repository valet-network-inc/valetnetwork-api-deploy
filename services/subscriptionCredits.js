/**
 * What one street-cleaning move is worth on a plan.
 *
 * This file used to credit a subscriber for every day the city suspended
 * street cleaning. That credit is discontinued (see creditSuspendedDay below);
 * the per-move maths stays because it is still the honest value of a move.
 *
 * It is not a flat $12.50. A month contains four OR five of any given
 * weekday — 4.33 on average — so a plan billed at $50/month for one move a
 * week is worth $12.50 a move in a four-move month and $10.00 in a five-move
 * one. So the value of a move is always `period price ÷ moves actually
 * scheduled in that period`.
 */

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
 * Discontinued (Rishi, 2026-10-09): "there aren't any refunds for if the city
 * suspends a street cleaning day. no credit back either." That holds on every
 * plan, for subscribers who signed up under the old promise as well as new
 * ones. The scheduler no longer calls this. It stays as a no-op rather than
 * being deleted so nothing that still imports it can post a credit, and the
 * AspCredit ledger keeps the credits that were already posted.
 */
async function creditSuspendedDay() {
    return { credited: false, reason: 'discontinued' };
}

module.exports = {
    scheduledMovesInPeriod,
    perMoveCents,
    creditSuspendedDay,
};
