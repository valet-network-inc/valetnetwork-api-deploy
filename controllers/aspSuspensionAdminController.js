/**
 * Admin side of the NYC alternate-side suspension calendar.
 *
 * Three ways to get a year in, easiest first:
 *
 *   1. `POST /import` with the .ics from nyc.gov. One paste, whole year, done.
 *   2. `POST /import` with text copied out of the DOT PDF for the years the
 *      city ships no .ics. The parser is forgiving about how the dates are
 *      written and simply skips lines it cannot read, so a bad paste can never
 *      half-import.
 *   3. `POST /` one day at a time, for the 6am snow announcement.
 *
 * All of it sits behind x-admin-key with the rest of /api/admin.
 */

const AspSuspension = require('../models/AspSuspension');
const {
    parseIcs,
    parseLooseText,
    importEntries,
    invalidate,
    check311,
    syncFrom311,
    nycDateKey,
} = require('../services/aspSuspensions');

const bad = (res, message, code = 400) =>
    res.status(code).json({ success: false, message });

/** GET /api/admin/asp-suspensions?year=2026 */
exports.list = async (req, res) => {
    try {
        const query = {};
        if (req.query.year) query.year = Number(req.query.year);
        if (req.query.from || req.query.to) {
            query.date = {};
            if (req.query.from) query.date.$gte = String(req.query.from);
            if (req.query.to) query.date.$lte = String(req.query.to);
        }
        const rows = await AspSuspension.find(query).sort({ date: 1 }).lean();

        // Grouped by year so the dashboard can show "2026 · 41 days" and let
        // Rishi see at a glance whether a year has actually been loaded.
        const byYear = rows.reduce((acc, r) => {
            acc[r.year] = (acc[r.year] || 0) + 1;
            return acc;
        }, {});

        return res.status(200).json({
            success: true,
            count: rows.length,
            byYear,
            todayKey: nycDateKey(),
            suspensions: rows,
        });
    } catch (err) {
        console.error('asp-suspensions list error:', err);
        return bad(res, 'Failed to list suspensions', 500);
    }
};

/**
 * POST /api/admin/asp-suspensions
 * Body: { date: 'YYYY-MM-DD', reason, note }
 */
exports.create = async (req, res) => {
    try {
        const { date, reason, note } = req.body || {};
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
            return bad(res, 'date must be YYYY-MM-DD');
        }
        if (!reason || !String(reason).trim()) {
            return bad(res, 'A reason is required — the customer reads it verbatim');
        }

        const doc = await AspSuspension.findOneAndUpdate(
            { date },
            {
                $set: {
                    date,
                    reason: String(reason).trim(),
                    note,
                    source: 'manual',
                    year: Number(String(date).slice(0, 4)),
                    createdBy: req.get('x-admin-user') || 'admin',
                },
            },
            { upsert: true, new: true }
        );
        invalidate();
        return res.status(200).json({ success: true, suspension: doc });
    } catch (err) {
        console.error('asp-suspensions create error:', err);
        return bad(res, 'Failed to save suspension', 500);
    }
};

/** DELETE /api/admin/asp-suspensions/:date */
exports.remove = async (req, res) => {
    try {
        const { date } = req.params;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
            return bad(res, 'date must be YYYY-MM-DD');
        }
        const result = await AspSuspension.deleteOne({ date });
        invalidate();
        return res.status(200).json({
            success: true,
            removed: result.deletedCount || 0,
        });
    } catch (err) {
        console.error('asp-suspensions delete error:', err);
        return bad(res, 'Failed to delete suspension', 500);
    }
};

/**
 * POST /api/admin/asp-suspensions/import
 * Body: { content, format: 'ics'|'text'|'auto', year, replaceYear, dryRun }
 *
 * `dryRun` returns exactly what would be written without writing it, because
 * pasting a year of the city's calendar and finding out afterwards that the
 * parser read it wrong is a bad afternoon.
 */
exports.import = async (req, res) => {
    try {
        const { content, year, replaceYear, dryRun } = req.body || {};
        if (!content || typeof content !== 'string' || !content.trim()) {
            return bad(res, 'Paste the .ics file or the text from the DOT calendar');
        }

        const format =
            req.body.format && req.body.format !== 'auto'
                ? req.body.format
                : /BEGIN:VCALENDAR/i.test(content)
                  ? 'ics'
                  : 'text';

        const defaultYear = Number(year) || new Date().getFullYear();
        const entries =
            format === 'ics' ? parseIcs(content) : parseLooseText(content, defaultYear);

        if (!entries.length) {
            return bad(
                res,
                format === 'ics'
                    ? 'No events found — is this really the .ics file?'
                    : 'No dates recognised. Each line needs a date, e.g. "January 1 - New Year\'s Day".'
            );
        }

        // Sanity check the reader before it is allowed to write: the DOT
        // calendar is one year, so a spread across many years means the paste
        // picked up something else.
        const years = [...new Set(entries.map((e) => Number(e.date.slice(0, 4))))];
        if (years.length > 2) {
            return bad(
                res,
                `Parsed dates span ${years.length} years (${years.join(', ')}) — that does not look like one year's calendar. Nothing was saved.`
            );
        }

        if (dryRun) {
            return res.status(200).json({
                success: true,
                dryRun: true,
                format,
                parsed: entries.length,
                years,
                entries,
            });
        }

        const result = await importEntries(entries, {
            source: 'dot_calendar',
            replaceYear: replaceYear ? Number(replaceYear) : null,
            createdBy: req.get('x-admin-user') || 'admin',
        });

        return res.status(200).json({ success: true, format, years, ...result });
    } catch (err) {
        console.error('asp-suspensions import error:', err);
        return bad(res, 'Failed to import calendar', 500);
    }
};

/**
 * POST /api/admin/asp-suspensions/check-311
 * Runs the live 311 lookup for a day and, unless dryRun, saves what it finds.
 * Reports plainly when 311 is not configured, rather than pretending the day
 * is fine.
 */
exports.check = async (req, res) => {
    try {
        const dateKey = String(req.body?.date || req.query.date || nycDateKey());
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return bad(res, 'date must be YYYY-MM-DD');

        if (!process.env.NYC311_API_KEY) {
            return res.status(200).json({
                success: true,
                configured: false,
                message:
                    'NYC311_API_KEY is not set. Sign up free at api-portal.nyc.gov, subscribe to "NYC 311 Public Developers", then set the key in Render.',
            });
        }

        if (req.body?.dryRun) {
            const result = await check311(dateKey);
            return res.status(200).json({ success: true, configured: true, dryRun: true, date: dateKey, result });
        }

        const result = await syncFrom311(dateKey);
        return res.status(200).json({ success: true, configured: true, date: dateKey, ...result });
    } catch (err) {
        console.error('asp-suspensions check error:', err);
        return bad(res, 'Failed to check 311', 500);
    }
};
