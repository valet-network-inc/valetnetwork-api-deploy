/**
 * Same-day bookings, told to ops the moment they land (Rishi, Nov 14 2026:
 * "the moment someone puts in a request, i get that in my order list ...
 * if the request was for a schedule move for today ... it comes on my phone").
 *
 * Who hears it: every valet flagged `alwaysNotify` (the same flag that puts
 * a valet on every dispatch regardless of distance). What: one push per
 * booking, naming the user, parking or retrieval, the time and the street.
 * Only bookings for later TODAY, New York time: a booking for now is already
 * dispatched at once, and one for another day reaches valets on its day.
 *
 * Idempotent per booking: a scheduled move remembers the occurrence it was
 * alerted for (`opsAlertKey`), an order its `opsAlertedAt`, each claimed
 * atomically before the push so two callers send one.
 */
const User = require('../models/User');
const { nyDateKey } = require('./nyTime');

function isLaterToday(at, now = new Date()) {
    if (!at) return false;
    const t = new Date(at);
    if (Number.isNaN(t.getTime()) || t.getTime() <= now.getTime()) return false;
    return nyDateKey(t) === nyDateKey(now);
}

function clock(at) {
    return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
}

function shortStreet(address) {
    const s = (address && address.streetAddress) || '';
    return s.split(',')[0].trim();
}

function nameOf(user) {
    if (!user) return 'A user';
    const n = [user.firstName, user.lastName].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
    return n || user.phone || 'A user';
}

async function recipients() {
    return User.find({ isValet: true, alwaysNotify: true, isActive: true, isDeleted: { $ne: true }, firebaseUid: { $nin: [null, ''] } })
        .select('firebaseUid')
        .lean();
}

/** Send one push to every alwaysNotify valet. Never throws. */
async function tell({ userId, label, at, address, data }) {
    try {
        const [user, to] = await Promise.all([User.findById(userId).select('firstName lastName phone').lean(), recipients()]);
        if (!to.length) return 0;
        const { sendPushNotification } = require('../controllers/notificationController');
        const street = shortStreet(address);
        const body = `${nameOf(user)} · ${label} at ${clock(at)}${street ? ` · ${street}` : ''}`;
        let sent = 0;
        for (const v of to) {
            try {
                await sendPushNotification(v.firebaseUid, 'New booking for today', body, { type: 'OPS_SAME_DAY_BOOKING', ...data });
                sent += 1;
            } catch (err) {
                console.error('opsAlert: push failed:', err.message);
            }
        }
        return sent;
    } catch (err) {
        console.error('opsAlert failed:', err.message);
        return 0;
    }
}

/**
 * A scheduled move just went on the schedule (booked, paid, or edited). Tell
 * ops if its next run is later today and that run hasn't been told yet.
 */
async function scheduledMove(move, now = new Date()) {
    try {
        if (!move || !move.active || !isLaterToday(move.nextAt, now)) return false;
        const ScheduledMove = require('../models/ScheduledMove');
        const key = new Date(move.nextAt).toISOString();
        const claimed = await ScheduledMove.findOneAndUpdate(
            { _id: move._id, active: true, opsAlertKey: { $ne: key } },
            { $set: { opsAlertKey: key } },
            { new: true }
        );
        if (!claimed) return false;
        await tell({
            userId: move.user,
            label: move.kind === 'pick-up' ? 'parking' : 'retrieval',
            at: move.nextAt,
            address: move.address,
            data: { scheduledMoveId: String(move._id) },
        });
        return true;
    } catch (err) {
        console.error('opsAlert.scheduledMove failed:', err.message);
        return false;
    }
}

/** A paid order booked for later today (the dispatch was deferred). */
async function order(o, now = new Date()) {
    try {
        if (!o || !isLaterToday(o.pickUpTime, now)) return false;
        const Order = require('../models/Order');
        const claimed = await Order.findOneAndUpdate(
            { _id: o._id, opsAlertedAt: { $exists: false } },
            { $set: { opsAlertedAt: now } },
            { new: true }
        );
        if (!claimed) return false;
        await tell({
            userId: (o.customer && o.customer._id) || o.customer,
            label: o.orderType === 'retrieval' ? 'retrieval' : 'parking',
            at: o.pickUpTime,
            address: o.customerLocation,
            data: { orderId: String(o._id) },
        });
        return true;
    } catch (err) {
        console.error('opsAlert.order failed:', err.message);
        return false;
    }
}

/** The instant today's NY day ends (the next NY midnight). */
function endOfNyToday(now = new Date()) {
    const { nyStartOfDay } = require('./nyTime');
    return nyStartOfDay(new Date(nyStartOfDay(now).getTime() + 30 * 60 * 60 * 1000));
}

module.exports = { scheduledMove, order, isLaterToday, endOfNyToday };
