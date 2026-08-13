/**
 * Shared gate for every /api/admin route.
 *
 * This used to live in adminNotificationController and covered only the four
 * push-notification endpoints. Everything else under /api/admin was open to the
 * internet: an unauthenticated GET of /api/admin/users returned every
 * customer's name, phone number, order count and signup time, and the metrics,
 * valet, payout and parking-photo reads were the same. It is now mounted once
 * on the whole router.
 *
 * ADMIN_API_KEY lives in the server env and is typed into the dashboard by the
 * operator; it is deliberately never bundled into the front-end build.
 */
module.exports = (req, res, next) => {
    const expected = process.env.ADMIN_API_KEY;
    if (!expected) {
        return res.status(503).json({
            success: false,
            message: 'ADMIN_API_KEY is not configured on the server',
        });
    }
    const provided = req.get('x-admin-key');
    if (!provided || provided !== expected) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    return next();
};
