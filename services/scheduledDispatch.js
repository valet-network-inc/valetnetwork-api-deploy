// Advance-booking dispatch.
//
// A booking made for later — "move my car Thursday at 8:30", "park it at 3pm" —
// creates a perfectly ordinary paid `pending` order whose `pickUpTime` is hours
// or days away. Nothing in this backend ever woke up to dispatch one. Dispatch
// has only ever been client-triggered: both apps POST
// /api/notification/notify-closest-valets the moment the card clears, and the
// subscription scheduler (services/subscriptionScheduler.js) only creates its
// orders ~45 minutes before the sweep, so it can dispatch inline.
//
// That left advance bookings with two bad halves and no good one:
//   - dispatch at checkout, and five valets get a 3 a.m.-style ping on Saturday
//     for a job on Thursday, then watch it sit in their feed all week;
//   - don't dispatch, and nobody is ever told.
//
// This job is the missing middle. Every 60s it finds paid, pending, unassigned
// orders whose pickup is inside the lead window and dispatches them exactly
// then — the same endpoint, the same fan-out, just at the right hour.
//
// Two guards keep it off orders it has no business touching:
//   1. `notifiedValets` must be EMPTY. notifyClosestValets always pushes a row
//      per valet it reached (notificationController.js:450-458), so a non-empty
//      list means someone has already dispatched this order — a normal
//      book-it-now checkout, or an earlier tick of this job. This is what stops
//      a double fan-out, and it needs no new field, so orders written before
//      this shipped are covered too.
//   2. `dispatchedAt` is stamped on success as a second, explicit marker.
//
// A failed dispatch is deliberately NOT stamped: it is retried on the next
// tick, for as long as the window is open. The window's late edge exists so a
// job that has already been missed by half an hour is left to
// autoCancelStaleOrders rather than dispatched into the past.
//
// One fan-out is not enough on its own. If nobody happens to be on shift at
// pickup-minus-45, the job would sit unclaimed until autoCancelStaleOrders
// cancels it 30 minutes AFTER the slot — refunding the customer in full and
// telling nobody, while their car takes a $65 ticket. So there are two more
// beats: the job is re-broadcast every REBROADCAST_EVERY_MS while it is still
// unclaimed and the slot has not arrived, and it is escalated to Slack once,
// ESCALATE_BEFORE_MS out, so a human can still act on it. Re-broadcast only
// ever touches orders THIS job dispatched (`dispatchedAt` is set nowhere
// else), so a book-it-now order can never be re-pushed.

const axios = require('axios');
const Order = require('../models/Order');

// How early a valet hears about a booked job. Matches the lead the
// subscription scheduler gives itself (subscriptionScheduler.js LEAD_MS) so a
// covered move and a paid one reach valets at the same point before pickup.
const DISPATCH_LEAD_MS = 45 * 60 * 1000;

// Stop trying once the pickup is this far gone. autoCancelStaleOrders owns
// anything past here (it cancels + refunds 30 min after a missed pickup).
const DISPATCH_LATE_GRACE_MS = 20 * 60 * 1000;

// How often an unclaimed booking is put back in front of valets. Long enough
// that it isn't nagging, short enough that a valet coming on shift 20 minutes
// before a sweep still hears about it.
const REBROADCAST_EVERY_MS = 10 * 60 * 1000;

// When to stop hoping and tell a human. Fifteen minutes is still enough time
// to walk to a car in the neighbourhood.
const ESCALATE_BEFORE_MS = 15 * 60 * 1000;

async function defaultNotify(orderId) {
    const base =
        process.env.PUBLIC_BACKEND_URL ||
        `http://127.0.0.1:${process.env.PORT || 3001}`;
    await axios.post(
        `${base}/api/notification/notify-closest-valets`,
        { orderId: String(orderId) },
        { timeout: 20000 }
    );
}

/** Still waiting for a valet, and its slot is neither far off nor long gone. */
function liveWindow(now) {
    return {
        status: 'pending',
        paymentStatus: 'paid',
        valet: { $in: [null, undefined] },
        pickUpTime: {
            $lte: new Date(now.getTime() + DISPATCH_LEAD_MS),
            $gte: new Date(now.getTime() - DISPATCH_LATE_GRACE_MS),
        },
    };
}

/**
 * Orders nobody has told any valet about yet.
 *
 * `notifiedValets: { $size: 0 }` is the load-bearing half: notifyClosestValets
 * always writes a row per valet it reached (notificationController.js), so a
 * non-empty list means this order was already dispatched by a client at
 * checkout — an ordinary book-it-now job — and is none of this job's business.
 */
function dueQuery(now) {
    return {
        ...liveWindow(now),
        dispatchedAt: { $exists: false },
        notifiedValets: { $size: 0 },
    };
}

/** Ours already, still unclaimed, and last put out more than one beat ago. */
function rebroadcastQuery(now) {
    return {
        ...liveWindow(now),
        dispatchedAt: { $lte: new Date(now.getTime() - REBROADCAST_EVERY_MS) },
    };
}

/** Ours, unclaimed, and close enough to the slot that a person should know. */
function escalateQuery(now) {
    return {
        ...liveWindow(now),
        dispatchedAt: { $exists: true },
        dispatchEscalatedAt: { $exists: false },
        pickUpTime: {
            $lte: new Date(now.getTime() + ESCALATE_BEFORE_MS),
            $gte: new Date(now.getTime() - DISPATCH_LATE_GRACE_MS),
        },
    };
}

async function tick({ notify = defaultNotify, alert = defaultAlert, now = new Date() } = {}) {
    const [due, stale] = await Promise.all([
        Order.find(dueQuery(now)).select('_id pickUpTime aspMode customer'),
        Order.find(rebroadcastQuery(now)).select('_id pickUpTime aspMode customer'),
    ]);

    const toDispatch = [...due, ...stale];
    const escalated = await escalateUnclaimed(now, alert);

    if (toDispatch.length === 0) {
        return { dispatched: 0, failed: 0, rebroadcast: 0, escalated };
    }

    let dispatched = 0;
    let failed = 0;

    for (const order of toDispatch) {
        try {
            await notify(order._id);
            await Order.updateOne(
                { _id: order._id },
                { $set: { dispatchedAt: new Date() } }
            );
            dispatched += 1;
            console.log(
                'scheduledDispatch: dispatched advance booking',
                String(order._id),
                'pickup',
                order.pickUpTime && order.pickUpTime.toISOString()
            );
        } catch (err) {
            failed += 1;
            // Left unstamped on purpose — the next tick tries again.
            await Order.updateOne(
                { _id: order._id },
                {
                    $inc: { dispatchAttempts: 1 },
                    $set: { dispatchError: String(err.message || err).slice(0, 300) },
                }
            );
            console.error(
                'scheduledDispatch: dispatch failed for',
                String(order._id),
                err.message
            );
        }
    }

    return { dispatched, failed, rebroadcast: stale.length, escalated };
}

/**
 * Tell a human about a booking whose slot is nearly here and which no valet
 * has taken. Stamped so it is said once, not once a minute.
 */
async function escalateUnclaimed(now, alert) {
    const orders = await Order.find(escalateQuery(now))
        .select('_id pickUpTime aspMode customerLocation totalAmount')
        .populate('customer', 'firstName lastName phone');
    let count = 0;
    for (const order of orders) {
        try {
            await alert(order);
        } catch (err) {
            console.error(
                'scheduledDispatch: escalation alert failed for',
                String(order._id),
                err.message
            );
            // Stamped anyway. A Slack outage must not turn into one alert a
            // minute for the rest of the window.
        }
        await Order.updateOne(
            { _id: order._id },
            { $set: { dispatchEscalatedAt: new Date() } }
        );
        count += 1;
        console.warn(
            'scheduledDispatch: NOBODY has taken booking',
            String(order._id),
            'due',
            order.pickUpTime && order.pickUpTime.toISOString()
        );
    }
    return count;
}

async function defaultAlert(order) {
    const { sendSlackNotification, customerLabel } = require('../controllers/notificationController');
    const when = order.pickUpTime
        ? new Date(order.pickUpTime).toLocaleString('en-US', {
              weekday: 'short',
              hour: 'numeric',
              minute: '2-digit',
              timeZone: 'America/New_York',
          })
        : 'soon';
    await sendSlackNotification(
        order.aspMode ? 'Booked street-cleaning move has no valet' : 'Booked job has no valet',
        `Nobody has accepted a booking due ${when} ET. It was broadcast ${Math.round(
            DISPATCH_LEAD_MS / 60000
        )} minutes ahead and re-broadcast since.`,
        {
            'Order ID': String(order._id),
            Customer: customerLabel(order.customer),
            Where: order.customerLocation?.streetAddress || 'unknown',
            'Due (ET)': when,
        }
    );
}

module.exports = {
    tick,
    dueQuery,
    rebroadcastQuery,
    escalateQuery,
    DISPATCH_LEAD_MS,
    DISPATCH_LATE_GRACE_MS,
    REBROADCAST_EVERY_MS,
    ESCALATE_BEFORE_MS,
};
