/**
 * The street-cleaning schedule: the free alarm, and the thing a subscription
 * books against.
 *
 * The interesting part is `suggestFromOrders`. Anyone who has ever booked a
 * street-cleaning move has already told us their block, their day and roughly
 * their time — asking them to type it again is asking a question we know the
 * answer to. So we derive a schedule from their own order history and show it
 * as one line with a confirm button, and once confirmed (or waved away) it
 * never asks again.
 */

const Order = require('../models/Order');
const User = require('../models/User');
const { nycDateKey, listRange, getSuspension, NYC_TZ } = require('./aspSuspensions');

/* ------------------------- time helpers ------------------------------- */

/** Weekday (0=Sun) and wall-clock time of a Date, read in New York. */
function nycParts(date) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: NYC_TZ,
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
        hour12: false,
    });
    const parts = Object.fromEntries(
        fmt.formatToParts(date).map((p) => [p.type, p.value])
    );
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
        weekday: weekdayMap[parts.weekday],
        hour: Number(parts.hour) % 24,
        minute: Number(parts.minute),
    };
}

/** Round to the nearest half hour — sweep signs are never posted at 9:07. */
function roundToHalfHour(hour, minute) {
    const total = hour * 60 + minute;
    const rounded = Math.round(total / 30) * 30;
    return { hour: Math.floor(rounded / 60) % 24, minute: rounded % 60 };
}

/**
 * The next N occurrences of a schedule, as UTC Dates, skipping nothing.
 * Suspension filtering happens above this so callers can show a suspended day
 * struck through rather than have it silently vanish from the calendar.
 */
function nextOccurrences(schedule, count = 8, from = new Date()) {
    const days = (schedule && schedule.days) || [];
    if (!days.length) return [];

    const out = [];
    // Walk forward day by day. 120 days is far more than any caller needs and
    // bounds the loop even if `days` is somehow empty of valid weekdays.
    for (let offset = 0; offset < 120 && out.length < count; offset += 1) {
        const probe = new Date(from.getTime() + offset * 24 * 60 * 60 * 1000);
        const key = nycDateKey(probe);
        const { weekday } = nycParts(probe);
        const match = days.find((d) => d.weekday === weekday);
        if (!match) continue;

        // Build the occurrence at the scheduled wall-clock time in New York.
        const at = nycWallClockToDate(key, match.hour ?? 9, match.minute ?? 0);
        if (at.getTime() <= from.getTime()) continue;
        out.push({ at, dateKey: key, hour: match.hour ?? 9, minute: match.minute ?? 0 });
    }
    return out;
}

/**
 * 'YYYY-MM-DD' + wall-clock time in New York → a real Date.
 * Done by probing the offset rather than hardcoding -04:00/-05:00, so it stays
 * correct across both daylight-saving transitions.
 */
function nycWallClockToDate(dateKey, hour, minute) {
    const [y, m, d] = dateKey.split('-').map(Number);
    // Start from the UTC instant with those wall-clock numbers, then correct by
    // whatever offset New York was actually on at that moment.
    const guess = new Date(Date.UTC(y, m - 1, d, hour, minute, 0));
    const asNyc = new Intl.DateTimeFormat('en-US', {
        timeZone: NYC_TZ,
        hour: 'numeric',
        hour12: false,
    }).format(guess);
    const offsetHours = hour - (Number(asNyc) % 24);
    return new Date(guess.getTime() + offsetHours * 60 * 60 * 1000);
}

/* ------------------------- suggestion --------------------------------- */

/**
 * Build a schedule proposal out of what the customer has already done.
 *
 * Returns null when there is nothing to go on — the app then shows the plain
 * "set my days" empty state rather than a half-guess.
 */
async function suggestFromOrders(userId) {
    const user = await User.findById(userId)
        .select('cleaningSchedule cleaningScheduleSuggestionDismissedAt')
        .lean();
    if (!user) return null;

    // Already answered, either way. Never ask twice.
    if (user.cleaningSchedule && (user.cleaningSchedule.days || []).length) return null;
    if (user.cleaningScheduleSuggestionDismissedAt) return null;

    // Street-cleaning bookings only, and never the auto-created return leg —
    // that fires at the END of the sweep and would teach us the wrong time.
    const aspOrders = await Order.find({
        customer: userId,
        aspMode: true,
        orderType: { $ne: 'retrieval' },
    })
        .select('customerLocation pickUpTime createdAt awayMode')
        .sort({ pickUpTime: -1 })
        .limit(25)
        .lean();

    if (!aspOrders.length) return null;

    // Which weekdays did they actually book? Most frequent wins; a tie is
    // broken by recency, because a block's sweep days change when people move.
    const byWeekday = new Map();
    aspOrders.forEach((o, index) => {
        if (!o.pickUpTime) return;
        const { weekday, hour, minute } = nycParts(new Date(o.pickUpTime));
        const entry = byWeekday.get(weekday) || {
            weekday,
            count: 0,
            recencyRank: index,
            times: [],
        };
        entry.count += 1;
        entry.recencyRank = Math.min(entry.recencyRank, index);
        entry.times.push(hour * 60 + minute);
        byWeekday.set(weekday, entry);
    });

    if (!byWeekday.size) return null;

    const ranked = [...byWeekday.values()].sort(
        (a, b) => b.count - a.count || a.recencyRank - b.recencyRank
    );
    // Two days is the New York norm — both sides of the street get swept.
    const chosen = ranked.slice(0, 2).sort((a, b) => a.weekday - b.weekday);

    const days = chosen.map((entry) => {
        // Median rather than mean: one 7am outlier should not drag a 9am block.
        const sorted = [...entry.times].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const { hour, minute } = roundToHalfHour(
            Math.floor(median / 60),
            median % 60
        );
        return { weekday: entry.weekday, hour, minute };
    });

    // Where. Their most recent street-cleaning pickup is the best answer — it
    // is literally the curb they said the car sits on. Failing that, the last
    // place WE parked the car, which is where it is right now.
    let address = null;
    const withLocation = aspOrders.find(
        (o) => o.customerLocation && typeof o.customerLocation.lat === 'number'
    );
    if (withLocation) {
        address = {
            streetAddress: withLocation.customerLocation.streetAddress,
            lat: withLocation.customerLocation.lat,
            lng: withLocation.customerLocation.lng,
        };
    } else {
        const parked = await Order.findOne({
            customer: userId,
            'parkingLocation.lat': { $type: 'number' },
        })
            .select('parkingLocation')
            .sort({ updatedAt: -1 })
            .lean();
        if (parked) {
            address = {
                streetAddress: parked.parkingLocation.streetAddress,
                lat: parked.parkingLocation.lat,
                lng: parked.parkingLocation.lng,
            };
        }
    }

    if (!address || !days.length) return null;

    return {
        address,
        days,
        reminderLeadMin: 60,
        basedOn: {
            orderCount: aspOrders.length,
            lastBookedAt: aspOrders[0].pickUpTime || aspOrders[0].createdAt,
            includedAwayMode: aspOrders.some((o) => o.awayMode),
        },
    };
}

/* ------------------------- reading ------------------------------------ */

/** Is this schedule live right now, accounting for a pause that has expired? */
function isActive(schedule, now = new Date()) {
    if (!schedule || !(schedule.days || []).length) return false;
    if (schedule.status !== 'paused') return true;
    // A pause with a date on it lapses on its own; one without runs until the
    // customer resumes it.
    if (schedule.pausedUntil && new Date(schedule.pausedUntil) <= now) return true;
    return false;
}

/**
 * The next occurrence a customer actually needs to act on, with the suspended
 * ones marked rather than removed.
 */
async function nextMove(schedule, { count = 4, from = new Date() } = {}) {
    const occurrences = nextOccurrences(schedule, count + 4, from);
    if (!occurrences.length) return { next: null, upcoming: [] };

    const upcoming = [];
    for (const occ of occurrences) {
        const suspension = await getSuspension(occ.dateKey);
        upcoming.push({
            at: occ.at,
            dateKey: occ.dateKey,
            suspended: !!suspension,
            reason: suspension ? suspension.reason : null,
        });
        if (upcoming.length >= count) break;
    }
    return { next: upcoming.find((u) => !u.suspended) || null, upcoming };
}

/** The month grid the app draws when the headline is tapped. */
async function monthView(schedule, monthKey) {
    const [y, m] = monthKey.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const first = `${monthKey}-01`;
    const last = `${monthKey}-${String(daysInMonth).padStart(2, '0')}`;

    const suspensions = await listRange(first, last);
    const suspendedByDate = new Map(suspensions.map((s) => [s.date, s]));
    const scheduleDays = new Set(((schedule && schedule.days) || []).map((d) => d.weekday));

    const cells = [];
    for (let day = 1; day <= daysInMonth; day += 1) {
        const dateKey = `${monthKey}-${String(day).padStart(2, '0')}`;
        // Noon avoids any chance of the date rolling either way on a DST day.
        const weekday = nycParts(nycWallClockToDate(dateKey, 12, 0)).weekday;
        const suspension = suspendedByDate.get(dateKey) || null;
        cells.push({
            date: dateKey,
            weekday,
            isCleaningDay: scheduleDays.has(weekday),
            suspended: !!suspension,
            reason: suspension ? suspension.reason : null,
        });
    }
    return { month: monthKey, cells, todayKey: nycDateKey() };
}

/* ------------------------- describing --------------------------------- */

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_PLURAL = [
    'Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays',
];

/** 11, 30 -> '11:30 AM'. The console is read by people, not parsers. */
function clockLabel(hour, minute) {
    const h = Number.isFinite(hour) ? hour : 9;
    const m = Number.isFinite(minute) ? minute : 0;
    const suffix = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** Days in week order, Sunday first, so two customers never read differently. */
function orderedDays(schedule) {
    return [...((schedule && schedule.days) || [])]
        .filter((d) => d && Number.isFinite(d.weekday))
        .sort((a, b) => a.weekday - b.weekday || (a.hour || 0) - (b.hour || 0));
}

/**
 * The schedule as a sentence — 'Tuesdays at 11:30 AM'.
 *
 * Every day carries its own time on purpose: sweep signs routinely differ
 * between a block's two days, so collapsing them to one time would be a lie
 * the operator could act on.
 */
function describe(schedule) {
    const days = orderedDays(schedule);
    if (!days.length) return null;
    const parts = days.map((d) => `${WEEKDAY_PLURAL[d.weekday]} at ${clockLabel(d.hour, d.minute)}`);
    if (parts.length === 1) return parts[0];
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The same thing sized for a table cell — 'Tue 11:30 AM · Thu 9:00 AM'. */
function describeShort(schedule) {
    const days = orderedDays(schedule);
    if (!days.length) return null;
    return days
        .map((d) => `${WEEKDAY_SHORT[d.weekday]} ${clockLabel(d.hour, d.minute)}`)
        .join(' · ');
}

/* ------------------------- admin summaries ---------------------------- */

/**
 * One schedule, flattened for a list view.
 *
 * Takes the suspension calendar as a map rather than querying it, so a page
 * showing a hundred customers costs one range query instead of a hundred
 * point lookups. `summarizeMany` below is the thing to call.
 */
function summarize(schedule, { from = new Date(), suspendedByDate = new Map(), lookahead = 4 } = {}) {
    const days = orderedDays(schedule);
    if (!days.length) {
        return { hasSchedule: false, active: false, label: null, shortLabel: null, days: [], next: null, upcoming: [] };
    }

    const active = isActive(schedule, from);
    const upcoming = nextOccurrences(schedule, lookahead + 4, from)
        .map((occ) => {
            const suspension = suspendedByDate.get(occ.dateKey) || null;
            return {
                at: occ.at,
                dateKey: occ.dateKey,
                suspended: !!suspension,
                reason: suspension ? suspension.reason : null,
                timeLabel: clockLabel(occ.hour, occ.minute),
            };
        })
        .slice(0, lookahead);

    return {
        hasSchedule: true,
        active,
        // The stored word, which is not the same question as `active`: a pause
        // with a date on it lapses on its own and reads active again.
        status: (schedule && schedule.status) || 'active',
        pausedUntil: (schedule && schedule.pausedUntil) || null,
        days: days.map((d) => ({
            weekday: d.weekday,
            hour: Number.isFinite(d.hour) ? d.hour : 9,
            minute: Number.isFinite(d.minute) ? d.minute : 0,
        })),
        daysPerWeek: days.length,
        label: describe(schedule),
        shortLabel: describeShort(schedule),
        address: (schedule && schedule.address && schedule.address.streetAddress) || null,
        reminderLeadMin: (schedule && schedule.reminderLeadMin) || null,
        source: (schedule && schedule.source) || null,
        updatedAt: (schedule && schedule.updatedAt) || null,
        next: upcoming.find((u) => !u.suspended) || null,
        upcoming,
    };
}

/**
 * Summaries for a whole list, in one suspension query.
 *
 * `entries` is [{ key, schedule }]; the returned Map is keyed the same way.
 */
async function summarizeMany(entries, { from = new Date(), lookahead = 4 } = {}) {
    const out = new Map();
    if (!entries.length) return out;

    // 60 days covers four occurrences of even a once-a-week schedule with room
    // for a run of suspended days.
    const fromKey = nycDateKey(from);
    const toKey = nycDateKey(new Date(from.getTime() + 60 * 24 * 60 * 60 * 1000));
    const suspensions = await listRange(fromKey, toKey);
    const suspendedByDate = new Map(suspensions.map((s) => [s.date, s]));

    entries.forEach(({ key, schedule }) => {
        out.set(key, summarize(schedule, { from, suspendedByDate, lookahead }));
    });
    return out;
}

module.exports = {
    nycParts,
    nycWallClockToDate,
    nextOccurrences,
    suggestFromOrders,
    isActive,
    nextMove,
    monthView,
    describe,
    describeShort,
    clockLabel,
    summarize,
    summarizeMany,
};

/**
 * Write a subscription's schedule back onto the user.
 *
 * The two surfaces must never disagree, and a customer can reach either one
 * first: they might set the free alarm on the home screen and then subscribe,
 * or go straight to the subscription page and never touch the home screen at
 * all. The home screen writes down into the subscription (see
 * cleaningScheduleController.mirrorToSubscription); this is the other
 * direction, so whichever they used, `User.cleaningSchedule` ends up correct
 * and the free reminder keeps firing after they cancel.
 *
 * Never throws: failing to mirror must not fail a purchase.
 */
async function adoptFromSubscription(userId, aspSchedule, { reminderLeadMin } = {}) {
    try {
        if (!aspSchedule || !Array.isArray(aspSchedule.days) || !aspSchedule.days.length) {
            return false;
        }
        const user = await User.findById(userId).select(
            'cleaningSchedule cleaningScheduleSuggestionDismissedAt'
        );
        if (!user) return false;

        const existingLead = user.cleaningSchedule?.reminderLeadMin;

        user.cleaningSchedule = {
            address: aspSchedule.address,
            days: aspSchedule.days
                .map((d) => ({
                    weekday: Number(d.weekday),
                    hour: Number(d.hour),
                    minute: Number(d.minute),
                }))
                .sort((a, b) => a.weekday - b.weekday),
            // Keep whatever lead time they already chose; a subscription has no
            // opinion about when someone likes to be woken.
            reminderLeadMin: Number.isFinite(Number(reminderLeadMin))
                ? Number(reminderLeadMin)
                : (existingLead ?? 60),
            status: 'active',
            pausedUntil: null,
            source: 'subscription',
            updatedAt: new Date(),
        };
        user.cleaningScheduleSuggestionDismissedAt =
            user.cleaningScheduleSuggestionDismissedAt || new Date();
        await user.save();
        return true;
    } catch (err) {
        console.error('adoptFromSubscription failed:', err.message);
        return false;
    }
}

module.exports.adoptFromSubscription = adoptFromSubscription;
