/**
 * NYC alternate-side suspension calendar.
 *
 * Three ways in, in descending order of trustworthiness:
 *
 *   1. The DOT annual calendar. NYC publishes it as a PDF *and* an .ics on
 *      nyc.gov, a year ahead. This is the source of truth for the ~40
 *      scheduled suspensions and the only one that works offline. Import it
 *      once a year.
 *   2. NYC 311's public API. The only source that knows about snow
 *      emergencies, which the annual calendar cannot predict. It is also
 *      documented by its users as returning "NO INFORMATION" at random, so it
 *      is treated here as a CHECK, never as truth.
 *   3. A human, via the admin dashboard, for the morning the city announces
 *      something at 6am and neither of the above has caught up.
 *
 * WHICH WAY WE FAIL IS A PRODUCT DECISION, not a technical one. If we wrongly
 * believe a day is suspended we skip a real move and the customer takes a $65
 * ticket — the single thing the plan exists to prevent. If we wrongly believe
 * it is a normal day we dispatch a valet nobody needed, which costs one valet
 * fee and is refundable after the fact. So: unknown ALWAYS means "not
 * suspended", and every function here fails toward dispatching.
 */

const AspSuspension = require('../models/AspSuspension');

const NYC_TZ = 'America/New_York';

/** 'YYYY-MM-DD' for a Date, evaluated in New York rather than UTC. */
function nycDateKey(date = new Date()) {
    // en-CA gives ISO-ordered parts, which is the least fragile way to do this
    // without pulling in a date library.
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: NYC_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(date);
}

/* --------------------------- reading ---------------------------------- */

// Suspensions change rarely and are read on every scheduler tick and every
// calendar open, so a short in-process cache saves a lot of round trips
// without risking staleness that matters.
let cache = { at: 0, byDate: new Map() };
const CACHE_MS = 5 * 60 * 1000;

async function loadCache() {
    if (Date.now() - cache.at < CACHE_MS && cache.byDate.size) return cache.byDate;
    const rows = await AspSuspension.find({}).select('date reason source').lean();
    cache = {
        at: Date.now(),
        byDate: new Map(rows.map((r) => [r.date, r])),
    };
    return cache.byDate;
}

/** Drop the cache — call after any write so the next read is immediate. */
function invalidate() {
    cache = { at: 0, byDate: new Map() };
}

/**
 * Is alternate side suspended on this day?
 * Resolves to the suspension record, or null. Never throws: a database blip
 * must not stop a dispatch.
 */
async function getSuspension(dateOrKey) {
    const key =
        typeof dateOrKey === 'string' ? dateOrKey : nycDateKey(dateOrKey);
    try {
        const byDate = await loadCache();
        return byDate.get(key) || null;
    } catch (err) {
        console.error('aspSuspensions: lookup failed, treating as NOT suspended:', err.message);
        return null;
    }
}

async function isSuspended(dateOrKey) {
    return !!(await getSuspension(dateOrKey));
}

/** Every suspension in [fromKey, toKey] inclusive, for the month calendar. */
async function listRange(fromKey, toKey) {
    try {
        return await AspSuspension.find({ date: { $gte: fromKey, $lte: toKey } })
            .select('date reason source')
            .sort({ date: 1 })
            .lean();
    } catch (err) {
        console.error('aspSuspensions: range query failed:', err.message);
        return [];
    }
}

/* --------------------------- importing -------------------------------- */

/**
 * Parse an iCalendar feed into { date, reason } pairs.
 *
 * Deliberately hand-rolled rather than pulled from npm: the DOT feed is a flat
 * list of all-day VEVENTs with no recurrence, no timezones and no attachments,
 * and a dependency here would be more surface area than the fifteen lines it
 * replaces. Handles RFC 5545 line folding, which the DOT file does use.
 */
function parseIcs(text) {
    if (!text || typeof text !== 'string') return [];

    // Unfold: a leading space or tab continues the previous line.
    const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
    const lines = unfolded.split(/\r\n|\n|\r/);

    const out = [];
    let current = null;

    for (const line of lines) {
        if (line.startsWith('BEGIN:VEVENT')) {
            current = {};
            continue;
        }
        if (line.startsWith('END:VEVENT')) {
            if (current && current.date && current.reason) out.push(current);
            current = null;
            continue;
        }
        if (!current) continue;

        // DTSTART;VALUE=DATE:20260101  →  2026-01-01
        const dt = line.match(/^DTSTART[^:]*:(\d{4})(\d{2})(\d{2})/);
        if (dt) {
            current.date = `${dt[1]}-${dt[2]}-${dt[3]}`;
            continue;
        }
        const summary = line.match(/^SUMMARY[^:]*:(.*)$/);
        if (summary) {
            current.reason = summary[1]
                .replace(/\\,/g, ',')
                .replace(/\\;/g, ';')
                .replace(/\\n/gi, ' ')
                .replace(/\\\\/g, '\\')
                .trim();
        }
    }
    return out;
}

/**
 * Pull dates out of pasted plain text — the escape hatch for the years the
 * city ships a PDF and no .ics, where the practical move is to copy the text
 * out of the PDF and paste it in.
 *
 * Accepts the shapes the DOT calendar actually uses, e.g.
 *   "January 1 - New Year's Day"
 *   "Jan 1, 2026 — New Year's Day"
 *   "2026-01-01 New Year's Day"
 * A line with no recognisable date is skipped rather than guessed at.
 */
const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function parseLooseText(text, defaultYear) {
    if (!text || typeof text !== 'string') return [];
    const out = [];

    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;

        let year = defaultYear;
        let month = null;
        let day = null;
        let rest = line;

        // ISO first — unambiguous.
        const iso = line.match(/(\d{4})-(\d{2})-(\d{2})/);
        if (iso) {
            year = Number(iso[1]);
            month = Number(iso[2]);
            day = Number(iso[3]);
            rest = line.slice(iso.index + iso[0].length);
        } else {
            const named = line.match(
                /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?/i
            );
            if (!named) continue;
            month = MONTHS[named[1].toLowerCase()];
            day = Number(named[2]);
            if (named[3]) year = Number(named[3]);
            rest = line.slice(named.index + named[0].length);
        }

        if (!year || !month || !day) continue;
        if (day < 1 || day > 31 || month < 1 || month > 12) continue;

        const reason =
            rest.replace(/^[\s\-–—:•*]+/, '').trim() || 'Alternate side suspended';

        out.push({
            date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
            reason,
        });
    }
    return out;
}

/**
 * Write a parsed batch in. `replaceYear` clears that year's rows from the same
 * source first, so re-importing a corrected DOT calendar does not leave last
 * week's mistakes behind. Manual and 311 entries are never touched by an
 * annual import.
 */
async function importEntries(entries, { source = 'manual', replaceYear = null, createdBy = null } = {}) {
    const clean = (entries || []).filter(
        (e) => e && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.reason
    );
    if (!clean.length) return { imported: 0, removed: 0, skipped: (entries || []).length };

    let removed = 0;
    if (replaceYear) {
        const res = await AspSuspension.deleteMany({ year: Number(replaceYear), source });
        removed = res.deletedCount || 0;
    }

    const ops = clean.map((e) => ({
        updateOne: {
            filter: { date: e.date },
            update: {
                $set: {
                    date: e.date,
                    reason: e.reason,
                    source,
                    year: Number(e.date.slice(0, 4)),
                    ...(createdBy ? { createdBy } : {}),
                },
            },
            upsert: true,
        },
    }));

    const res = await AspSuspension.bulkWrite(ops, { ordered: false });
    invalidate();
    return {
        imported: (res.upsertedCount || 0) + (res.modifiedCount || 0),
        matched: res.matchedCount || 0,
        removed,
        skipped: (entries || []).length - clean.length,
    };
}

/* --------------------------- 311 check -------------------------------- */

/**
 * Ask NYC 311 whether alternate side is in effect today. Optional: without
 * NYC311_API_KEY configured this is a no-op, which is the intended state until
 * someone signs up at api-portal.nyc.gov.
 *
 * Returns { suspended: true, reason } | { suspended: false } | null when it
 * could not be determined. A null MUST be read as "carry on and dispatch".
 */
async function check311(dateKey = nycDateKey()) {
    const key = process.env.NYC311_API_KEY;
    if (!key) return null;

    const base =
        process.env.NYC311_CALENDAR_URL ||
        'https://api.nyc.gov/public/api/GetCalendar';

    const [y, m, d] = dateKey.split('-');
    const url = `${base}?fromdate=${m}/${d}/${y}&todate=${m}/${d}/${y}`;

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(url, {
            headers: { 'Ocp-Apim-Subscription-Key': key },
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) return null;

        const json = await res.json();
        const day = (json.days || [])[0];
        if (!day) return null;

        const asp = (day.items || []).find(
            (i) => String(i.type || '').toLowerCase().includes('alternate side')
        );
        if (!asp) return null;

        const status = String(asp.status || '').toUpperCase();
        // The documented statuses are inconsistent and "NO INFORMATION" comes
        // back at random, so only an explicit suspension counts. Anything else,
        // including a status we have never seen, means carry on.
        if (status.includes('SUSPEND') || status.includes('NOT IN EFFECT')) {
            return { suspended: true, reason: asp.details || 'Suspended by the city' };
        }
        if (status.includes('IN EFFECT')) return { suspended: false };
        return null;
    } catch (err) {
        console.warn('aspSuspensions: 311 check unavailable:', err.message);
        return null;
    }
}

/**
 * Run the 311 check and persist anything new it finds, so the app and the
 * scheduler both see it without each calling out. Safe to call on a timer.
 */
async function syncFrom311(dateKey = nycDateKey()) {
    const result = await check311(dateKey);
    if (!result || !result.suspended) return { changed: false };

    const existing = await AspSuspension.findOne({ date: dateKey }).lean();
    if (existing) return { changed: false, alreadyKnown: true };

    await AspSuspension.create({
        date: dateKey,
        reason: result.reason,
        source: 'nyc311',
        year: Number(dateKey.slice(0, 4)),
    });
    invalidate();
    console.log(`aspSuspensions: 311 reported ${dateKey} suspended — ${result.reason}`);
    return { changed: true, reason: result.reason };
}

module.exports = {
    NYC_TZ,
    nycDateKey,
    getSuspension,
    isSuspended,
    listRange,
    parseIcs,
    parseLooseText,
    importEntries,
    check311,
    syncFrom311,
    invalidate,
};
