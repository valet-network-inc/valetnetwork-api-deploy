/**
 * sweepWindows — the arithmetic behind "when is the next street sweeper
 * coming down the block this car is sitting on RIGHT NOW?"
 *
 * On the $250 and $300 plans nobody ever types a cleaning schedule. The valet
 * is standing at the sign when they park, so the schedule is a property of the
 * block, and it changes the moment we re-park the car. Everything downstream —
 * the sweep watcher, the alerting, the admin tab, the customer's CleaningBox —
 * needs the same answers to the same four questions, so they live here once:
 * which block is this, what windows does the sign say, when does the next one
 * start, and is one running as we speak.
 *
 * This file is deliberately pure and dependency-light: clock helpers and
 * nothing else. No model, no controller, no network. It is required from the
 * dispatch path, and the dispatch path must never be able to hang or throw
 * because a third party was slow.
 *
 * Two directions this module fails in, both on purpose:
 *
 *   - An EMPTY window list means UNKNOWN, never "this block has no sweep".
 *     A valet who skipped the field and a sign that genuinely has no cleaning
 *     rule produce the identical value today, and quietly reading that as "no
 *     move needed" is exactly the silent skip this whole build exists to stop.
 *     Callers must treat empty as an alarm; nothing here can make that call
 *     for them, so nothing here pretends to.
 *   - When two readings of one block disagree we dispatch on the union (see
 *     unionWindows). A move nobody needed costs one valet fee. A move we
 *     skipped costs a $65 Brooklyn ticket that the company eats.
 */

const { nyClock, nyStartOfDay, nyWallTimeToInstant, nextNyOccurrence } = require('./nyTime');

// ~0.001° of latitude is roughly 110 m and 0.001° of longitude roughly 85 m at
// NYC's latitude, so one tile is about a city block — the same grid
// StreetParkingMark already groups pin marks by.
const TILE_PRECISION = 1000;

// Fallback length of a sweep window when the sign's end time is missing or
// unusable. NYC alternate-side signs are overwhelmingly 90-minute windows, and
// the auto-ASP order the scheduler books already uses duration 90, so a guess
// of 90 keeps this module and the order it triggers describing the same block
// of time.
const DEFAULT_WINDOW_MINUTES = 90;

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const DAY_NAMES = [
    'Sundays',
    'Mondays',
    'Tuesdays',
    'Wednesdays',
    'Thursdays',
    'Fridays',
    'Saturdays',
];

/* ------------------------------ block identity ------------------------- */

/**
 * Grid cell of a lat/lng, e.g. '40679:-73995'.
 *
 * This is PURE ARITHMETIC and it stays that way. The obvious "better" answer
 * is to resolve the real street segment via streetSegmentResolver, but that
 * calls Overpass with a 6-second timeout, no retry, and a process-local cache
 * that dies on every deploy — and on failure it returns null, which is
 * indistinguishable from "there are no rules here". Block identity has to be
 * available when the network is not, so it is a rounding, computed locally,
 * every time.
 *
 * Returns null for anything that is not a real pair of numbers; the caller
 * decides what a car with no coordinates means.
 */
function tileKeyOf(point) {
    if (!point) return null;
    const lat = Number(point.lat);
    const lng = Number(point.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return `${Math.round(lat * TILE_PRECISION)}:${Math.round(lng * TILE_PRECISION)}`;
}

/**
 * Great-circle distance in metres.
 *
 * Copied verbatim from services/subscriptionService.js rather than imported,
 * because importing it would pull the Order and Subscription models into a
 * module that must stay free of them. Copied means the two can never disagree
 * about whether a car is at its home address; if one is ever changed, change
 * both.
 */
function haversineMeters(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

/* ------------------------------ parsing -------------------------------- */

// 'HH:MM' → { hour, minute }, or null. Strict on purpose: no Date.parse, no
// Number() on a partial string, no accepting '8:5' as 8:05. The valet app
// writes these from a phone picker and nothing validates them server-side, so
// this is the only gate they pass through.
function parseHHMM(value) {
    if (typeof value !== 'string') return null;
    const m = HHMM.exec(value.trim());
    if (!m) return null;
    return { hour: Number(m[1]), minute: Number(m[2]) };
}

function windowKey(w) {
    const end = w.endHour === null || w.endHour === undefined ? '-' : `${w.endHour}:${w.endMinute}`;
    return `${w.weekday}|${w.hour}|${w.minute}|${end}`;
}

/**
 * ParkingNote / StreetParkingMark shape → scheduler shape.
 *
 *   [{ day: 1, startTime: '08:30', endTime: '10:00' }]
 *      → { windows: [{ weekday: 1, hour: 8, minute: 30, endHour: 10, endMinute: 0 }], dropped: 0 }
 *
 * `dropped` is returned alongside the windows and is not cosmetic. "We read
 * three windows on this sign and understood two" is a completely different
 * fact from "this sign has two windows": the first one means a valet's entry
 * is garbage and a human has to look at the sign photo, and the alerting has
 * to be able to tell those apart. Nothing is ever coerced into a window to
 * make the count look better.
 *
 * A MISSING end time is not a parse failure — the schemas require it but old
 * and hand-written rows exist without it, and nextSweep already has a defined
 * answer for a window with no end. A PRESENT but malformed end time is a
 * failure: it means someone wrote something we cannot read, and guessing at it
 * is how we would end up believing a sweep ends before it does.
 */
function toSweepWindows(streetCleaning) {
    if (!Array.isArray(streetCleaning)) return { windows: [], dropped: 0 };

    const windows = [];
    const seen = new Set();
    let dropped = 0;

    for (const raw of streetCleaning) {
        if (!raw || typeof raw !== 'object') {
            dropped += 1;
            continue;
        }

        const day = raw.day;
        if (!Number.isInteger(day) || day < 0 || day > 6) {
            dropped += 1;
            continue;
        }

        const start = parseHHMM(raw.startTime);
        if (!start) {
            dropped += 1;
            continue;
        }

        let endHour = null;
        let endMinute = null;
        const hasEnd = raw.endTime !== undefined && raw.endTime !== null && raw.endTime !== '';
        if (hasEnd) {
            const end = parseHHMM(raw.endTime);
            if (!end) {
                dropped += 1;
                continue;
            }
            endHour = end.hour;
            endMinute = end.minute;
        }

        const w = {
            weekday: day,
            hour: start.hour,
            minute: start.minute,
            endHour,
            endMinute,
        };

        const key = windowKey(w);
        if (seen.has(key)) continue; // an exact repeat of a window we already have
        seen.add(key);
        windows.push(w);
    }

    return { windows: sortWindows(windows), dropped };
}

/* ------------------------------ occurrences ---------------------------- */

/**
 * When the occurrence that starts at `at` finishes.
 *
 * The end is the same NY calendar day at endHour:endMinute, except that a sign
 * reading 23:00-01:00 crosses midnight, so an end hour earlier than the start
 * hour belongs to the next day. All of the calendar arithmetic goes through
 * nyTime, which is DST-correct via Intl; doing any of it with millisecond
 * offsets here would be an hour wrong twice a year.
 */
function occurrenceEnd(at, window) {
    const fallback = new Date(at.getTime() + DEFAULT_WINDOW_MINUTES * 60 * 1000);
    if (window.endHour === null || window.endHour === undefined) return fallback;

    const c = nyClock(at);
    let end;
    if (window.endHour < c.hour) {
        // Crosses midnight. Noon of the following NY day is the safe way to
        // name that date — the same trick nextNyOccurrence uses to stay clear
        // of DST edges.
        const nextNoon = nyClock(new Date(nyStartOfDay(at).getTime() + 36 * 60 * 60 * 1000));
        end = nyWallTimeToInstant(
            nextNoon.year,
            nextNoon.month,
            nextNoon.day,
            window.endHour,
            window.endMinute
        );
    } else {
        end = nyWallTimeToInstant(c.year, c.month, c.day, window.endHour, window.endMinute);
    }

    // An end that is not after the start (10:00-10:00, or a garbled pair that
    // survived parsing) tells us nothing, so fall back to the 90 minutes the
    // rest of the system assumes.
    if (!(end.getTime() > at.getTime())) return fallback;
    return end;
}

/**
 * Soonest occurrence at or after `from`, across every window.
 *
 * Returns null when there are no windows — and null means UNKNOWN to the
 * caller, never "this block is never swept". A window that starts three
 * minutes from now is returned like any other; deciding that three minutes is
 * too late to dispatch is the caller's job, not this function's.
 */
function nextSweep(windows, from = new Date()) {
    if (!Array.isArray(windows) || windows.length === 0) return null;

    let best = null;
    for (const w of windows) {
        const at = nextNyOccurrence({ weekday: w.weekday, hour: w.hour, minute: w.minute }, from);
        if (!at) continue;
        if (!best || at.getTime() < best.at.getTime()) {
            best = { at, endsAt: occurrenceEnd(at, w), window: w };
        }
    }
    return best;
}

/**
 * The window we are standing inside of, if any.
 *
 * This is the "a ticket is being written on this car RIGHT NOW" signal, and it
 * is worth its own alert: everything else in the system is about acting before
 * a sweep, and by the time this returns something we are already late.
 *
 * Looks back 26 hours, which covers every real window including the ones that
 * cross midnight; a weekday cannot come round twice inside that span, so the
 * first occurrence at or after that point is the only candidate per window.
 */
function sweepInProgress(windows, now = new Date()) {
    if (!Array.isArray(windows) || windows.length === 0) return null;

    const lookbackFrom = new Date(now.getTime() - 26 * 60 * 60 * 1000);
    for (const w of windows) {
        const startedAt = nextNyOccurrence(
            { weekday: w.weekday, hour: w.hour, minute: w.minute },
            lookbackFrom
        );
        if (!startedAt || startedAt.getTime() > now.getTime()) continue;
        const endsAt = occurrenceEnd(startedAt, w);
        if (endsAt.getTime() > now.getTime()) return { window: w, startedAt, endsAt };
    }
    return null;
}

/* ------------------------------ set algebra ---------------------------- */

function sortWindows(windows) {
    return windows
        .slice()
        .sort((a, b) => a.weekday - b.weekday || a.hour - b.hour || a.minute - b.minute);
}

/**
 * Every window either reading knows about.
 *
 * Used when two readings of the same block disagree — a fresh ParkingNote
 * against an older one, or a note against a block-level mark. The asymmetry is
 * the entire point and it is not a close call: dispatching on a window that
 * turns out not to exist costs one valet fee, which is recoverable. Skipping a
 * window that does exist costs a $65 Brooklyn ticket, which the company pays
 * and the customer remembers. So we take the union and move the car.
 */
function unionWindows(a, b) {
    const out = [];
    const seen = new Set();
    for (const list of [a, b]) {
        if (!Array.isArray(list)) continue;
        for (const w of list) {
            if (!w) continue;
            const key = windowKey(w);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(w);
        }
    }
    return sortWindows(out);
}

/** Same set of windows, whatever order they arrived in. */
function sameWindows(a, b) {
    const keysOf = (list) =>
        (Array.isArray(list) ? list : [])
            .filter(Boolean)
            .map(windowKey)
            .sort();
    const ka = keysOf(a);
    const kb = keysOf(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k, i) => k === kb[i]);
}

/* ------------------------------ human copy ----------------------------- */

function clockLabel(hour, minute) {
    const suffix = hour < 12 ? 'am' : 'pm';
    const h = hour % 12 === 0 ? 12 : hour % 12;
    return `${h}:${String(minute).padStart(2, '0')}${suffix}`;
}

/**
 * 'Mondays 8:30am', 'Mondays & Thursdays 11:00am', 'Mondays 8:30am, Thursdays 11:30am'.
 *
 * This string goes in the alert body, the admin tab and the customer's app, so
 * it says one thing plainly and stops. Days that share a start time are
 * grouped, because "Mondays & Thursdays 11:00am" is how a person would say it
 * out loud.
 *
 * No windows returns an empty string. The caller has to write its own copy for
 * that case, because empty means we do not know this block's schedule, and no
 * wording produced here could honestly stand in for that.
 */
function describeWindows(windows) {
    const list = sortWindows((Array.isArray(windows) ? windows : []).filter(Boolean));
    if (list.length === 0) return '';

    const groups = [];
    const byTime = new Map();
    for (const w of list) {
        const timeKey = `${w.hour}:${w.minute}`;
        if (!byTime.has(timeKey)) {
            const group = { hour: w.hour, minute: w.minute, days: [] };
            byTime.set(timeKey, group);
            groups.push(group);
        }
        const group = byTime.get(timeKey);
        if (!group.days.includes(w.weekday)) group.days.push(w.weekday);
    }

    return groups
        .map((g) => `${g.days.map((d) => DAY_NAMES[d]).join(' & ')} ${clockLabel(g.hour, g.minute)}`)
        .join(', ');
}

/* ------------------------------ freshness ------------------------------ */

/**
 * Is this reading too old to act on without a fresh look?
 *
 * Signs get replaced, blocks get re-signed, and a car that has not moved in
 * six weeks may be sitting under a rule nobody has read since. A missing or
 * unusable capture date counts as stale for the same reason an empty window
 * list counts as unknown: the safe answer is the one that makes a human look.
 */
function isStaleCapture(capturedAt, now = new Date(), maxDays = 45) {
    if (!capturedAt) return true;
    const at = capturedAt instanceof Date ? capturedAt : new Date(capturedAt);
    const t = at.getTime();
    if (!Number.isFinite(t)) return true;
    return now.getTime() - t > maxDays * 24 * 60 * 60 * 1000;
}

module.exports = {
    TILE_PRECISION,
    DEFAULT_WINDOW_MINUTES,
    tileKeyOf,
    haversineMeters,
    toSweepWindows,
    nextSweep,
    sweepInProgress,
    unionWindows,
    sameWindows,
    describeWindows,
    isStaleCapture,
};
