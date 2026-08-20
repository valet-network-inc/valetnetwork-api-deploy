/**
 * The customer's street-cleaning schedule — free, and the source of truth the
 * subscription books against.
 *
 * Everything here is scoped to one user id and is deliberately small: the app
 * needs to read one object, write one object, and pause/resume it.
 */

const User = require('../models/User');
const Subscription = require('../models/Subscription');
const {
    suggestFromOrders,
    isActive,
    nextMove,
    monthView,
} = require('../services/cleaningSchedule');
const { nycDateKey } = require('../services/aspSuspensions');

const bad = (res, message, code = 400) =>
    res.status(code).json({ success: false, message });

/** Reject anything that would produce a schedule the scheduler cannot book. */
function validateDays(days) {
    if (!Array.isArray(days) || !days.length) return 'Pick at least one cleaning day';
    if (days.length > 3) return 'Three days is the most a block is ever swept';
    const seen = new Set();
    for (const d of days) {
        const weekday = Number(d && d.weekday);
        const hour = Number(d && d.hour);
        const minute = Number(d && d.minute);
        if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return 'Bad weekday';
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) return 'Bad hour';
        if (!Number.isInteger(minute) || minute < 0 || minute > 59) return 'Bad minute';
        if (seen.has(weekday)) return 'That day is listed twice';
        seen.add(weekday);
    }
    return null;
}

function normalizeDays(days) {
    return days
        .map((d) => ({
            weekday: Number(d.weekday),
            hour: Number(d.hour),
            minute: Number(d.minute),
        }))
        .sort((a, b) => a.weekday - b.weekday);
}

/** The shape every endpoint here returns, so the app has one thing to parse. */
async function buildPayload(user) {
    const schedule = user.cleaningSchedule;
    const hasSchedule = !!(schedule && (schedule.days || []).length);

    if (!hasSchedule) {
        return {
            hasSchedule: false,
            schedule: null,
            active: false,
            next: null,
            upcoming: [],
            suggestion: await suggestFromOrders(user._id),
        };
    }

    const active = isActive(schedule);
    const { next, upcoming } = active
        ? await nextMove(schedule)
        : { next: null, upcoming: [] };

    return {
        hasSchedule: true,
        schedule: {
            address: schedule.address,
            days: schedule.days,
            reminderLeadMin: schedule.reminderLeadMin ?? 60,
            status: schedule.status || 'active',
            pausedUntil: schedule.pausedUntil || null,
            source: schedule.source || 'manual',
            updatedAt: schedule.updatedAt || null,
        },
        active,
        next,
        upcoming,
        suggestion: null,
        todayKey: nycDateKey(),
    };
}

/** GET /api/cleaning-schedule/:userId */
exports.getSchedule = async (req, res) => {
    try {
        const user = await User.findById(req.params.userId).select(
            '_id cleaningSchedule cleaningScheduleSuggestionDismissedAt'
        );
        if (!user) return bad(res, 'User not found', 404);
        return res.status(200).json({ success: true, ...(await buildPayload(user)) });
    } catch (err) {
        console.error('getSchedule error:', err);
        return bad(res, 'Failed to load schedule', 500);
    }
};

/**
 * PUT /api/cleaning-schedule/:userId
 * Body: { address, days, reminderLeadMin, source }
 *
 * Also mirrors onto any active subscription, because the dashboard and older
 * documents still read Subscription.aspSchedule. The user's copy is the truth;
 * the mirror exists so nothing that has not been migrated yet goes blind.
 */
exports.setSchedule = async (req, res) => {
    try {
        const { address, days, reminderLeadMin, source } = req.body || {};

        const dayError = validateDays(days);
        if (dayError) return bad(res, dayError);

        if (
            !address ||
            typeof address.lat !== 'number' ||
            typeof address.lng !== 'number'
        ) {
            return bad(res, 'A pinned address is required');
        }

        const user = await User.findById(req.params.userId);
        if (!user) return bad(res, 'User not found', 404);

        const normalized = normalizeDays(days);
        const lead = Number.isFinite(Number(reminderLeadMin))
            ? Math.max(0, Math.min(1440, Number(reminderLeadMin)))
            : user.cleaningSchedule?.reminderLeadMin ?? 60;

        user.cleaningSchedule = {
            address: {
                streetAddress: address.streetAddress,
                lat: address.lat,
                lng: address.lng,
            },
            days: normalized,
            reminderLeadMin: lead,
            // Editing a paused schedule is a clear signal they want it back.
            status: 'active',
            pausedUntil: null,
            source: ['manual', 'from_orders', 'subscription'].includes(source)
                ? source
                : 'manual',
            updatedAt: new Date(),
        };
        // Answering the question retires the suggestion for good.
        user.cleaningScheduleSuggestionDismissedAt =
            user.cleaningScheduleSuggestionDismissedAt || new Date();
        await user.save();

        await mirrorToSubscription(user);

        return res.status(200).json({ success: true, ...(await buildPayload(user)) });
    } catch (err) {
        console.error('setSchedule error:', err);
        return bad(res, 'Failed to save schedule', 500);
    }
};

/**
 * POST /api/cleaning-schedule/:userId/pause
 * Body: { until } — an ISO date, or omitted for "until I turn it back on".
 */
exports.pauseSchedule = async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        if (!user) return bad(res, 'User not found', 404);
        if (!user.cleaningSchedule || !(user.cleaningSchedule.days || []).length) {
            return bad(res, 'No schedule to pause');
        }

        let until = null;
        if (req.body && req.body.until) {
            const parsed = new Date(req.body.until);
            if (Number.isNaN(parsed.getTime())) return bad(res, 'Bad resume date');
            if (parsed <= new Date()) return bad(res, 'Resume date must be in the future');
            until = parsed;
        }

        user.cleaningSchedule.status = 'paused';
        user.cleaningSchedule.pausedUntil = until;
        user.cleaningSchedule.updatedAt = new Date();
        await user.save();

        return res.status(200).json({ success: true, ...(await buildPayload(user)) });
    } catch (err) {
        console.error('pauseSchedule error:', err);
        return bad(res, 'Failed to pause schedule', 500);
    }
};

/** POST /api/cleaning-schedule/:userId/resume — one tap, no confirmation. */
exports.resumeSchedule = async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        if (!user) return bad(res, 'User not found', 404);
        if (!user.cleaningSchedule || !(user.cleaningSchedule.days || []).length) {
            return bad(res, 'No schedule to resume');
        }
        user.cleaningSchedule.status = 'active';
        user.cleaningSchedule.pausedUntil = null;
        user.cleaningSchedule.updatedAt = new Date();
        await user.save();
        return res.status(200).json({ success: true, ...(await buildPayload(user)) });
    } catch (err) {
        console.error('resumeSchedule error:', err);
        return bad(res, 'Failed to resume schedule', 500);
    }
};

/** DELETE /api/cleaning-schedule/:userId — back to the empty state. */
exports.clearSchedule = async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        if (!user) return bad(res, 'User not found', 404);
        user.cleaningSchedule = undefined;
        await user.save();
        return res.status(200).json({ success: true, ...(await buildPayload(user)) });
    } catch (err) {
        console.error('clearSchedule error:', err);
        return bad(res, 'Failed to clear schedule', 500);
    }
};

/**
 * POST /api/cleaning-schedule/:userId/suggestion/dismiss
 * The confirm prompt is one tap to accept and one to wave away; this is the
 * second one, and it must stick.
 */
exports.dismissSuggestion = async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        if (!user) return bad(res, 'User not found', 404);
        user.cleaningScheduleSuggestionDismissedAt = new Date();
        await user.save();
        return res.status(200).json({ success: true, ...(await buildPayload(user)) });
    } catch (err) {
        console.error('dismissSuggestion error:', err);
        return bad(res, 'Failed to dismiss suggestion', 500);
    }
};

/** GET /api/cleaning-schedule/:userId/month?month=YYYY-MM */
exports.getMonth = async (req, res) => {
    try {
        const month = String(req.query.month || nycDateKey().slice(0, 7));
        if (!/^\d{4}-\d{2}$/.test(month)) return bad(res, 'month must be YYYY-MM');

        const user = await User.findById(req.params.userId)
            .select('cleaningSchedule')
            .lean();
        if (!user) return bad(res, 'User not found', 404);

        const view = await monthView(user.cleaningSchedule, month);
        return res.status(200).json({ success: true, ...view });
    } catch (err) {
        console.error('getMonth error:', err);
        return bad(res, 'Failed to load month', 500);
    }
};

/**
 * Keep Subscription.aspSchedule in step with the user's copy.
 * Exported so the subscription controller can call it after a purchase.
 */
async function mirrorToSubscription(user) {
    if (!user.cleaningSchedule || !(user.cleaningSchedule.days || []).length) return;
    try {
        await Subscription.updateMany(
            { user: user._id, status: { $in: ['active', 'trialing', 'past_due'] } },
            {
                $set: {
                    'aspSchedule.address': user.cleaningSchedule.address,
                    'aspSchedule.days': user.cleaningSchedule.days,
                    'aspSchedule.source': 'edited',
                },
            }
        );
    } catch (err) {
        // A mirror failure must never fail the customer's save — the user
        // record is the one the scheduler reads.
        console.error('mirrorToSubscription failed:', err.message);
    }
}

exports.mirrorToSubscription = mirrorToSubscription;
