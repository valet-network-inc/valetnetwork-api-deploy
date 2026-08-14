// America/New_York clock helpers for the subscription scheduler.
//
// The server runs in UTC; street-cleaning schedules are NY wall-clock times.
// Everything here goes through Intl (full ICU ships with Node 18+) so DST is
// handled by the platform, not by us.

const NY_TZ = 'America/New_York';

const partsFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
});

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// What the NY clock reads at a given instant.
function nyClock(date) {
    const parts = {};
    for (const p of partsFmt.formatToParts(date)) parts[p.type] = p.value;
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour) % 24, // Intl emits "24" for midnight with hour12:false
        minute: Number(parts.minute),
        second: Number(parts.second),
        weekday: WEEKDAYS[parts.weekday],
    };
}

// 'YYYY-MM-DD' of the NY calendar day containing the instant.
function nyDateKey(date) {
    const c = nyClock(date);
    const mm = String(c.month).padStart(2, '0');
    const dd = String(c.day).padStart(2, '0');
    return `${c.year}-${mm}-${dd}`;
}

// The UTC instant at which NY wall clock reads y-m-d h:min. Works across DST
// by guessing the UTC offset and correcting against what NY actually reads at
// the guess (two rounds converge for every real transition).
function nyWallTimeToInstant(year, month, day, hour, minute) {
    let guess = Date.UTC(year, month - 1, day, hour, minute, 0);
    for (let i = 0; i < 2; i++) {
        const c = nyClock(new Date(guess));
        const readAsUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
        const wantAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
        guess += wantAsUtc - readAsUtc;
    }
    return new Date(guess);
}

// UTC instant of NY midnight starting the day that contains `date`.
function nyStartOfDay(date) {
    const c = nyClock(date);
    return nyWallTimeToInstant(c.year, c.month, c.day, 0, 0);
}

// UTC instant of the Monday 00:00 NY that starts the week containing `date`.
function nyStartOfWeek(date) {
    const c = nyClock(date);
    const sinceMonday = (c.weekday + 6) % 7; // Mon=0 ... Sun=6
    const start = nyWallTimeToInstant(c.year, c.month, c.day, 0, 0);
    return new Date(start.getTime() - sinceMonday * 24 * 60 * 60 * 1000 + driftFix(start, sinceMonday));
}

// Subtracting whole days across a DST boundary can land an hour off NY
// midnight; measure and correct.
function driftFix(startOfDayInstant, daysBack) {
    if (daysBack === 0) return 0;
    const rough = new Date(startOfDayInstant.getTime() - daysBack * 24 * 60 * 60 * 1000);
    const c = nyClock(rough);
    const exact = nyWallTimeToInstant(c.year, c.month, c.day, 0, 0);
    return exact.getTime() - rough.getTime();
}

// Next occurrence (as a UTC instant) of `{weekday, hour, minute}` NY time at
// or after `from`. Scans day by day so DST days resolve exactly.
function nextNyOccurrence({ weekday, hour, minute }, from) {
    const start = nyClock(from);
    for (let i = 0; i < 8; i++) {
        const dayInstant = new Date(
            nyStartOfDay(from).getTime() + i * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000
        ); // noon-ish of candidate day, safe from DST edges
        const c = nyClock(dayInstant);
        if (c.weekday !== weekday) continue;
        const occurrence = nyWallTimeToInstant(c.year, c.month, c.day, hour, minute);
        if (occurrence.getTime() >= from.getTime()) return occurrence;
    }
    // Unreachable: 8 days always contain the weekday once at/after `from`.
    return null;
}

module.exports = {
    NY_TZ,
    nyClock,
    nyDateKey,
    nyWallTimeToInstant,
    nyStartOfDay,
    nyStartOfWeek,
    nextNyOccurrence,
};
