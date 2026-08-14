// Auto-ASP scheduler: books the street-cleaning move for every entitled
// subscriber, twice a week, with zero customer action.
//
// Safety model, in order of defense:
//   1. Only status:'active' subscriptions inside their paid period are even
//      considered — lapsed/past_due/cancelled subs never fire.
//   2. Each schedule slot resolves to one occurrence key
//      `asp:<subId>:<NY date>:<HHMM>`; Order.autoBookKey has a UNIQUE sparse
//      index, so a duplicate booking is rejected by MongoDB itself no matter
//      how many ticks or processes race (E11000 is swallowed as "already
//      booked").
//   3. Orders are $0 / paymentStatus 'paid' at creation — no PaymentIntent is
//      ever minted, so there is nothing to double-charge.
//   4. The weekly covered-move cap is enforced on top (manual covered ASP
//      bookings count against it).
//   5. A subscriber with any live order is skipped and retried next tick
//      until the window closes — the car is already in our care.
//
// An occurrence fires inside [sweepStart - LEAD, sweepStart + LATE_GRACE].
// The order's pickUpTime is sweepStart - PICKUP_HEADSTART so the valet has
// the car before cleaning begins; the existing +1.5h asp_time rule then puts
// the auto-return ~75 minutes into the sweep window, matching how manual
// bookings behave today.

const Order = require('../models/Order');
const Subscription = require('../models/Subscription');
const axios = require('axios');
const {
    isEntitled,
    aspMovesUsedThisWeek,
    aspListPriceCents,
} = require('./subscriptionService');
const { ASP_MOVES_PER_WEEK } = require('./subscriptionPlans');
const { nyDateKey, nextNyOccurrence } = require('./nyTime');

const LEAD_MS = 45 * 60 * 1000; // start trying 45 min before the sweep
const LATE_GRACE_MS = 5 * 60 * 1000; // stop trying 5 min after it starts
const PICKUP_HEADSTART_MS = 15 * 60 * 1000; // valet has the car 15 min early
const OTP_EXPIRY_ORDER_CREATION = 30 * 24 * 60 * 60 * 1000; // matches orderController

function occurrenceKey(subId, occurrence, day) {
    const hhmm = `${String(day.hour).padStart(2, '0')}${String(day.minute).padStart(2, '0')}`;
    return `asp:${subId}:${nyDateKey(occurrence)}:${hhmm}`;
}

// The occurrence for `day` currently inside the firing window, if any.
function dueOccurrence(day, now) {
    // Look from the near past so an occurrence a few minutes gone still
    // resolves (nextNyOccurrence only looks forward).
    const from = new Date(now.getTime() - LATE_GRACE_MS);
    const occ = nextNyOccurrence(day, from);
    if (!occ) return null;
    const start = occ.getTime() - LEAD_MS;
    const end = occ.getTime() + LATE_GRACE_MS;
    if (now.getTime() >= start && now.getTime() <= end) return occ;
    return null;
}

// Default valet dispatch: the same client-triggered endpoint the apps call,
// invoked against our own public URL. Best-effort — the order exists either
// way and stays visible in valet order feeds.
async function defaultNotify(orderId) {
    const base =
        process.env.PUBLIC_BACKEND_URL ||
        `http://127.0.0.1:${process.env.PORT || 8080}`;
    await axios.post(
        `${base}/api/notification/notify-closest-valets`,
        { orderId: String(orderId) },
        { timeout: 20000 }
    );
}

async function bookOccurrence(sub, day, occurrence, { io, notify, now }) {
    const key = occurrenceKey(sub._id, occurrence, day);

    // Cheap pre-check; the unique index is the real guarantee.
    const existing = await Order.findOne({ autoBookKey: key }).select('_id');
    if (existing) return { key, outcome: 'already_booked' };

    // Never book on top of a live order — the car is already with us or a
    // booking is in flight. Unpaid pending orders only count while fresh (a
    // checkout in progress); older ones are abandoned carts that the
    // auto-cancel job will clear, and they must not block the sweep.
    // Retried next tick while the window stays open.
    const activeOrder = await Order.findOne({
        customer: sub.user,
        $or: [
            {
                status: { $in: ['pending', 'accepted', 'in_progress', 'in-progress', 'parked', 'keys-returning'] },
                paymentStatus: 'paid',
            },
            {
                status: 'pending',
                paymentStatus: 'pending',
                createdAt: { $gte: new Date(now.getTime() - 10 * 60 * 1000) },
            },
        ],
    }).select('_id');
    if (activeOrder) return { key, outcome: 'skipped_active_order' };

    // Weekly covered-move cap (auto + manual both count).
    const used = await aspMovesUsedThisWeek(sub, now);
    if (used >= ASP_MOVES_PER_WEEK) return { key, outcome: 'weekly_cap_reached' };

    const address = sub.aspSchedule && sub.aspSchedule.address;
    if (!address || typeof address.lat !== 'number' || typeof address.lng !== 'number') {
        return { key, outcome: 'no_schedule_address' };
    }

    const pickUpTime = new Date(occurrence.getTime() - PICKUP_HEADSTART_MS);
    const listPrice = await aspListPriceCents();
    const otpCreatedAt = new Date();

    const order = new Order({
        customer: sub.user,
        customerLocation: {
            lat: address.lat,
            lng: address.lng,
            streetAddress: address.streetAddress,
        },
        parkingType: 'street',
        orderType: 'parking',
        duration: 90,
        pickUpTime,
        paymentMethod: 'card',
        totalAmount: 0,
        status: 'pending',
        paymentStatus: 'paid',
        serviceType: 'park-and-hold',
        aspMode: true,
        asp_time: new Date(pickUpTime.getTime() + 1.5 * 60 * 60 * 1000),
        coveredBySubscription: sub._id,
        listPriceCents: listPrice,
        autoBookKey: key,
        otp: {
            code: Math.floor(100000 + Math.random() * 900000).toString(),
            createdAt: otpCreatedAt,
            expiresAt: new Date(otpCreatedAt.getTime() + OTP_EXPIRY_ORDER_CREATION),
            verified: false,
            type: 'order_creation',
        },
    });

    try {
        await order.save();
    } catch (err) {
        if (err && err.code === 11000) {
            // Another tick/process booked this occurrence first. Exactly what
            // the unique index is for.
            return { key, outcome: 'already_booked' };
        }
        throw err;
    }

    if (io) {
        io.emit('newOrder', order);
        io.to(String(sub.user)).emit('orderUpdated', order);
    }

    // Tell the customer their move is booked (best-effort).
    try {
        const User = require('../models/User');
        const customer = await User.findById(sub.user).select('firebaseUid');
        if (customer && customer.firebaseUid) {
            const { sendPushNotification } = require('../controllers/notificationController');
            const when = occurrence.toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                timeZone: 'America/New_York',
            });
            await sendPushNotification(
                customer.firebaseUid,
                'Street-cleaning move booked',
                `Your car's ${when} move is scheduled. A valet will come for the keys before the sweep.`,
                { orderId: String(order._id), type: 'AUTO_ASP_BOOKED' }
            );
        }
    } catch (pushErr) {
        console.error('Auto-ASP: customer push failed:', pushErr.message);
    }

    try {
        await (notify || defaultNotify)(order._id);
    } catch (err) {
        console.error(
            'Auto-ASP: valet dispatch failed for order',
            String(order._id),
            err.message
        );
    }

    console.log(
        `Auto-ASP: booked ${key} → order ${order._id} (pickup ${pickUpTime.toISOString()})`
    );
    return { key, outcome: 'booked', orderId: order._id };
}

// One scheduler pass. Runs every minute from server.js; `now` and `notify`
// are injectable for tests.
async function tick({ io = null, now = new Date(), notify = null } = {}) {
    const results = [];
    try {
        const subs = await Subscription.find({
            status: 'active',
            'aspSchedule.days.0': { $exists: true },
        });

        for (const sub of subs) {
            if (!isEntitled(sub, now)) continue; // stale period → webhook lag or lapse; never book
            for (const day of sub.aspSchedule.days) {
                try {
                    const occurrence = dueOccurrence(day, now);
                    if (!occurrence) continue;
                    const result = await bookOccurrence(sub, day, occurrence, { io, notify, now });
                    results.push({ subscriptionId: sub._id, ...result });
                } catch (err) {
                    console.error(
                        'Auto-ASP: error booking for subscription',
                        String(sub._id),
                        err.message
                    );
                    results.push({ subscriptionId: sub._id, outcome: 'error', error: err.message });
                }
            }
        }
    } catch (err) {
        console.error('Auto-ASP scheduler tick error:', err.message);
    }
    return results;
}

module.exports = {
    tick,
    dueOccurrence,
    occurrenceKey,
    bookOccurrence,
    LEAD_MS,
    LATE_GRACE_MS,
    PICKUP_HEADSTART_MS,
};
