/**
 * Admin-initiated push notifications.
 *
 * The dashboard had no way to message anyone before this. The pre-existing
 * /api/notification/* routes could technically do it, but they take a raw FCM
 * token and have no auth, so they are not something to build a broadcast button
 * on top of.
 *
 * The x-admin-key gate now lives in middleware/requireAdminKey.js and is
 * mounted on the whole /api/admin router, so these routes no longer name it
 * individually. Every send is written to NotificationLog whether it succeeds or
 * not, so a blast is auditable.
 */

const User = require('../models/User');
const FCMToken = require('../models/FCMToken');
const NotificationLog = require('../models/NotificationLog');
const { sendPushNotification } = require('./notificationController');

// How many pushes to have in flight at once. Firebase handles far more, but
// this keeps a 5000-user blast from monopolising the event loop.
const CONCURRENCY = 10;

const MAX_TITLE = 120;
const MAX_BODY = 500;

/**
 * Resolve an audience to the firebaseUids that actually have a device attached.
 * Filtering by live tokens up front means the reported "will reach N phones"
 * is the real number rather than a user count.
 */
const resolveAudience = async (audience, userId) => {
    let userQuery;
    if (audience === 'user') {
        if (!userId) throw new Error('userId is required when audience is "user"');
        userQuery = { _id: userId };
    } else if (audience === 'customers') {
        userQuery = { isValet: { $ne: true } };
    } else if (audience === 'valets') {
        userQuery = { isValet: true };
    } else if (audience === 'all') {
        userQuery = {};
    } else {
        throw new Error(`Unknown audience "${audience}"`);
    }

    const users = await User.find(userQuery)
        .select('_id firebaseUid firstName lastName phone isValet')
        .lean();

    const uids = users.map((u) => u.firebaseUid).filter(Boolean);
    if (uids.length === 0) return [];

    const withTokens = await FCMToken.distinct('firebaseUid', {
        firebaseUid: { $in: uids },
        isActive: true,
    });
    const reachable = new Set(withTokens);
    return users.filter((u) => u.firebaseUid && reachable.has(u.firebaseUid));
};

const runPool = async (items, worker, limit) => {
    const results = [];
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(items[index]);
        }
    });
    await Promise.all(runners);
    return results;
};

/**
 * GET /api/admin/notifications/audience-counts
 * Powers the "this will reach N phones" line before anything is sent.
 */
exports.getAudienceCounts = async (req, res) => {
    try {
        const [customers, valets, all] = await Promise.all([
            resolveAudience('customers'),
            resolveAudience('valets'),
            resolveAudience('all'),
        ]);
        return res.status(200).json({
            success: true,
            counts: {
                customers: customers.length,
                valets: valets.length,
                all: all.length,
            },
        });
    } catch (err) {
        console.error('getAudienceCounts failed:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * POST /api/admin/notifications/send
 * body: { audience, userId?, title, body, sound?, data?, sentByNote?, dryRun? }
 */
exports.sendAdminNotification = async (req, res) => {
    const {
        audience,
        userId,
        title,
        body,
        sound,
        data = {},
        sentByNote,
        dryRun = false,
    } = req.body || {};

    if (!title || !String(title).trim()) {
        return res.status(400).json({ success: false, message: 'title is required' });
    }
    if (!body || !String(body).trim()) {
        return res.status(400).json({ success: false, message: 'body is required' });
    }
    if (String(title).length > MAX_TITLE) {
        return res.status(400).json({
            success: false,
            message: `title must be ${MAX_TITLE} characters or fewer`,
        });
    }
    if (String(body).length > MAX_BODY) {
        return res.status(400).json({
            success: false,
            message: `body must be ${MAX_BODY} characters or fewer`,
        });
    }

    try {
        const recipients = await resolveAudience(audience, userId);

        if (dryRun) {
            return res.status(200).json({
                success: true,
                dryRun: true,
                wouldReach: recipients.length,
                sample: recipients.slice(0, 5).map((u) => ({
                    name: [u.firstName, u.lastName].filter(Boolean).join(' ') || 'unnamed',
                    isValet: !!u.isValet,
                })),
            });
        }

        if (recipients.length === 0) {
            return res.status(200).json({
                success: true,
                message: 'Nobody in that audience has a device registered',
                recipientsAttempted: 0,
                recipientsDelivered: 0,
            });
        }

        const payload = {
            ...data,
            type: data.type || 'ADMIN_MESSAGE',
        };

        const results = await runPool(
            recipients,
            (u) =>
                sendPushNotification(u.firebaseUid, title, body, payload, null, sound)
                    .then((r) => !!r?.success)
                    .catch(() => false),
            CONCURRENCY
        );

        const delivered = results.filter(Boolean).length;
        const failed = results.length - delivered;

        await NotificationLog.create({
            audience,
            targetUser: audience === 'user' ? userId : undefined,
            title,
            body,
            sound,
            data: payload,
            recipientsAttempted: recipients.length,
            recipientsDelivered: delivered,
            recipientsFailed: failed,
            sentByNote,
        });

        return res.status(200).json({
            success: true,
            recipientsAttempted: recipients.length,
            recipientsDelivered: delivered,
            recipientsFailed: failed,
        });
    } catch (err) {
        console.error('sendAdminNotification failed:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * GET /api/admin/notifications/history?limit=50
 */
exports.getNotificationHistory = async (req, res) => {
    try {
        const limit = Math.min(Number(req.query.limit) || 50, 200);
        const rows = await NotificationLog.find({})
            .sort({ sentAt: -1 })
            .limit(limit)
            .populate('targetUser', 'firstName lastName phone')
            .lean();
        return res.status(200).json({ success: true, notifications: rows });
    } catch (err) {
        console.error('getNotificationHistory failed:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * POST /api/admin/notifications/run-parking-alerts
 * Fires the parking-expiry / ASP sweep by hand instead of waiting for the
 * 60-second timer. Useful when checking the feature end to end.
 */
exports.runParkingAlertsNow = async (req, res) => {
    try {
        const result = await require('../services/parkingAlerts').runOnce();
        return res.status(200).json({ success: true, result });
    } catch (err) {
        console.error('runParkingAlertsNow failed:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
};
