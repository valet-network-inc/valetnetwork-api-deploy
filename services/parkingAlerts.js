/**
 * Time-based customer alerts: "your parking is ending" and "your car goes back
 * for alternate-side parking".
 *
 * Before this existed nothing in the system fired on a clock. checkAspOrders
 * was written as an HTTP handler that nothing ever called, so the ASP reminder
 * only went out if somebody POSTed the endpoint by hand, and the parking-expiry
 * reminder did not exist at all. This service is the missing timer.
 *
 * Two alerts, both to the customer:
 *   1. PARKING_ENDING_SOON  — LEAD_PARKING_MIN before pickUpTime + duration
 *   2. ASP_RETURN_SOON      — LEAD_ASP_MIN before asp_time
 *
 * Safety properties that matter on a live database:
 *   - An alert only fires inside the window [target - lead, target). An order
 *     whose end time has already passed is never touched, so the six orders
 *     sitting in `parked` since April cannot be woken up by a deploy.
 *   - MAX_LOOKBACK_MIN is a second belt on the same risk: a clock jump or a
 *     long outage cannot produce a backlog blast.
 *   - endingSoonAlert.forDurationMinutes records the duration the alert was
 *     sent for. A paid extension bumps order.duration, which no longer matches,
 *     which re-arms the alert against the new end time. No extra bookkeeping.
 *   - Orders with no usable duration or pickUpTime are skipped, not guessed at.
 *
 * Set PARKING_ALERTS_DRY_RUN=1 to log every decision and send nothing.
 */

const Order = require('../models/Order');

const LEAD_PARKING_MIN = Number(process.env.PARKING_ALERT_LEAD_MIN || 15);
const LEAD_ASP_MIN = Number(process.env.ASP_ALERT_LEAD_MIN || 10);
const MAX_LOOKBACK_MIN = Number(process.env.PARKING_ALERT_LOOKBACK_MIN || 60);
const TICK_MS = 60 * 1000;

const ACTIVE_STATUSES = ['parked'];

const isDryRun = () =>
    String(process.env.PARKING_ALERTS_DRY_RUN || '') === '1';

const minutesUntil = (date, now) => Math.round((date - now) / 60000);

/**
 * True when `target` is close enough to now to alert, but has not passed.
 * The lookback bound means a process that was down for a day comes back and
 * stays quiet instead of firing everything it missed.
 */
const inAlertWindow = (target, now, leadMin) => {
    const diffMin = minutesUntil(target, now);
    return diffMin <= leadMin && diffMin > 0 && diffMin > -MAX_LOOKBACK_MIN;
};

const send = async (firebaseUid, title, body, data) => {
    if (!firebaseUid) return { success: false, message: 'no firebaseUid' };
    if (isDryRun()) {
        console.log(
            `parkingAlerts[DRY RUN] would send to ${firebaseUid}: "${title}" — "${body}"`
        );
        return { success: true, dryRun: true };
    }
    // Required lazily: notificationController pulls in firebase-admin, which
    // must not be touched before server.js finishes initializing it.
    const { sendPushNotification } = require('../controllers/notificationController');
    return sendPushNotification(firebaseUid, title, body, data);
};

/**
 * "15 minutes left on your parking" — to the customer.
 */
const sweepParkingEndingSoon = async (now) => {
    const orders = await Order.find({
        status: { $in: ACTIVE_STATUSES },
        duration: { $gt: 0 },
        pickUpTime: { $ne: null },
    })
        .populate('customer')
        .limit(500);

    let sent = 0;
    for (const order of orders) {
        try {
            const pickUp = order.pickUpTime ? new Date(order.pickUpTime) : null;
            if (!pickUp || Number.isNaN(pickUp.getTime())) continue;
            if (!order.duration || order.duration <= 0) continue;

            const endsAt = new Date(pickUp.getTime() + order.duration * 60000);
            if (!inAlertWindow(endsAt, now, LEAD_PARKING_MIN)) continue;

            // Already told them about *this* end time? An extension changes
            // duration, so this comparison re-arms on its own.
            const alert = order.endingSoonAlert || {};
            if (alert.sentAt && alert.forDurationMinutes === order.duration) continue;

            const left = minutesUntil(endsAt, now);
            const result = await send(
                order.customer?.firebaseUid,
                `${left} minutes left on your parking`,
                'Tap to add more time, or we can bring your car back.',
                {
                    orderId: order._id.toString(),
                    type: 'PARKING_ENDING_SOON',
                    endsAt: endsAt.toISOString(),
                    screen_name: 'UserOrderScreen',
                }
            );

            if (result?.success) {
                order.endingSoonAlert = {
                    sentAt: now,
                    forDurationMinutes: order.duration,
                };
                await order.save();
                sent += 1;
                console.log(
                    `parkingAlerts: ending-soon sent for order ${order._id} (${left}m left)`
                );
            } else {
                console.warn(
                    `parkingAlerts: ending-soon send failed for order ${order._id}: ${result?.message || 'unknown'}`
                );
            }
        } catch (err) {
            console.error(
                `parkingAlerts: ending-soon error on order ${order?._id}:`,
                err.message
            );
        }
    }
    return sent;
};

/**
 * "Your car goes back in 10 minutes" — the customer half of the ASP reminder.
 * The valet half already lives in orderController.checkAspOrders; this does not
 * touch that flag, so the two can run independently without double-sending.
 */
const sweepAspReturn = async (now) => {
    const orders = await Order.find({
        status: { $in: ACTIVE_STATUSES },
        aspMode: true,
        asp_time: { $ne: null },
    })
        .populate('customer')
        .limit(500);

    let sent = 0;
    for (const order of orders) {
        try {
            const aspTime = new Date(order.asp_time);
            if (Number.isNaN(aspTime.getTime())) continue;
            if (!inAlertWindow(aspTime, now, LEAD_ASP_MIN)) continue;
            if (order.aspCustomerNotificationSent) continue;

            const left = minutesUntil(aspTime, now);
            const result = await send(
                order.customer?.firebaseUid,
                `Your car goes back in ${left} minutes`,
                'Street cleaning is ending. Your valet is returning it to the spot.',
                {
                    orderId: order._id.toString(),
                    type: 'ASP_RETURN_SOON',
                    aspTime: aspTime.toISOString(),
                    screen_name: 'UserOrderScreen',
                }
            );

            if (result?.success) {
                order.aspCustomerNotificationSent = true;
                await order.save();
                sent += 1;
                console.log(
                    `parkingAlerts: asp-return sent for order ${order._id} (${left}m out)`
                );
            }
        } catch (err) {
            console.error(
                `parkingAlerts: asp-return error on order ${order?._id}:`,
                err.message
            );
        }
    }
    return sent;
};

/**
 * One pass. Exported so an admin can trigger it by hand and so it is testable
 * without waiting on the interval.
 */
exports.runOnce = async () => {
    const now = new Date();
    const [endingSoon, aspReturn] = await Promise.all([
        sweepParkingEndingSoon(now),
        sweepAspReturn(now),
    ]);
    if (endingSoon + aspReturn > 0) {
        console.log(
            `parkingAlerts: sent ${endingSoon} ending-soon, ${aspReturn} asp-return`
        );
    }
    return { endingSoon, aspReturn, at: now.toISOString(), dryRun: isDryRun() };
};

exports.start = () => {
    setInterval(() => {
        exports
            .runOnce()
            .catch((err) => console.error('parkingAlerts tick failed:', err));
    }, TICK_MS);
    console.log(
        `parkingAlerts started (every ${TICK_MS / 1000}s, parking lead ${LEAD_PARKING_MIN}m, asp lead ${LEAD_ASP_MIN}m${isDryRun() ? ', DRY RUN' : ''})`
    );
};
