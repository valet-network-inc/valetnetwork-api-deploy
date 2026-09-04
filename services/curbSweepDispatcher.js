/**
 * curbSweepDispatcher — moving a car we hold before its block is swept, and
 * shouting when we cannot.
 *
 * This is the other half of commit db519f1. That commit stopped asking $250 and
 * $300 customers which mornings their street is cleaned, on the grounds that
 * working it out is the job they are paying for. Until this file existed, the
 * job was simply not done: services/subscriptionScheduler.js skips a
 * subscription with no days via a bare `continue`, silently, so a customer could
 * buy the plan, pay, and receive nothing while nobody found out.
 *
 * TWO PASSES, REGISTERED SEPARATELY AND ON PURPOSE:
 *
 *   tick()  moves cars. Behind CURB_SWEEP_ENABLED.
 *   watch() is the alarm. NOT behind that flag.
 *
 * Turning the mover off to investigate something is a decision. Turning the
 * alarm off along with it is how a car takes a ticket that nobody hears about.
 *
 * WHY THIS IS NOT services/subscriptionScheduler.js:
 *
 *   That scheduler refuses to book while the customer has any order in status
 *   'parked' with paymentStatus 'paid' — its live-order guard, whose comment
 *   reads "the car is already with us". For a per-move customer that is exactly
 *   right. For a managed car it is fatal: a managed car is parked BY DEFINITION,
 *   for the life of the plan, so every occurrence would come back
 *   'skipped_active_order' forever. The car being with us is the precondition
 *   for a managed move and the disqualifier for a scheduled one. The two are
 *   partitioned by tier in that file's tick().
 */

const axios = require('axios');

const CurbCustody = require('../models/CurbCustody');
const Order = require('../models/Order');
const Subscription = require('../models/Subscription');
const sweepWindows = require('./sweepWindows');
const curbCustody = require('./curbCustody');
const operatorAlert = require('./operatorAlert');
const { isEntitled, aspListPriceCents } = require('./subscriptionService');
const { getSuspension } = require('./aspSuspensions');
const { nyDateKey, nyClock } = require('./nyTime');
const {
    LEAD_MS,
    LATE_GRACE_MS,
    PICKUP_HEADSTART_MS,
} = require('./subscriptionScheduler');

const OTP_EXPIRY_ORDER_CREATION = 30 * 24 * 60 * 60 * 1000; // matches orderController

// Cars on the same block at the same sweep are one valet's run, not N round
// trips. They are staggered so the valet has time to walk between them.
const BATCH_STAGGER_MS = 8 * 60 * 1000;
// More than this in one window is not a run any more, and someone should know
// before 8:30 Monday rather than after it.
const BATCH_ALERT_ABOVE = 4;

// How long before an occurrence an unclaimed move stops being normal.
const UNCLAIMED_LEAD_MS = 20 * 60 * 1000;
// The same question for a car we hold the keys to, asked later and on a
// different fact. There is no order for "nobody has accepted this" to be true
// of, so all we can ask is whether the car has actually moved — and at T-20 a
// valet working a run legitimately has not reached it yet (the booked path
// spaces one block's cars 8 minutes apart for exactly that reason). Ten minutes
// out, with the keys in his pocket, is not normal, and paging any earlier would
// page on an ordinary Monday until nobody read these any more.
const PUSH_NOT_MOVED_LEAD_MS = 10 * 60 * 1000;
// A sweep before this hour cannot be covered by anyone starting their day
// normally, so it is worth flagging the evening before rather than at 5:40am.
const EARLY_SWEEP_HOUR = 8;

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * The occurrence key.
 *
 * DELIBERATELY THE SAME NAMESPACE the schedule-driven booker uses
 * (`asp:<subId>:<NY date>:<HHMM>`). Order.autoBookKey's unique sparse index is
 * the only real double-dispatch guarantee in this system, and it only fires if
 * both paths compute the SAME STRING. A separate namespace plus a findOne
 * pre-check would be a read-then-write race; sharing the key makes the DATABASE
 * refuse the second write, so two valets can never be sent for one sweep even
 * if the tier partition is later broken by a bad edit.
 */
const occurrenceKey = (subId, occurrence, window) =>
    `asp:${subId}:${nyDateKey(occurrence)}:${pad2(window.hour)}${pad2(window.minute)}`;

const reminderKey = (occurrence, window) =>
    `${nyDateKey(occurrence)}:${pad2(window.hour)}:${pad2(window.minute)}`;

/** Same best-effort dispatch the schedule-driven booker uses. */
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

/** Every custody row that is due to move inside the firing window. */
function dueNow(custody, now) {
    const windows = (custody.rules && custody.rules.windows) || [];
    if (!windows.length) return null;
    const next = sweepWindows.nextSweep(windows, new Date(now.getTime() - LATE_GRACE_MS));
    if (!next) return null;
    const start = next.at.getTime() - LEAD_MS;
    const end = next.at.getTime() + LATE_GRACE_MS;
    if (now.getTime() < start || now.getTime() > end) return null;
    return next;
}

/**
 * Move a car whose keys we are holding: a push, no order.
 *
 * This is the shape the $250 plan is sold as and the shape away mode already
 * runs (orderController's AWAY_MOVE_REMINDER). It creates no order, takes no
 * payment, needs no OTP, cannot be blocked by any live-order guard, cannot be
 * reaped by autoCancelStaleOrders, and does not land in the cancel refund's
 * usage sum.
 *
 * This is now the PRIMARY path, not a dormant one: `CurbCustody.keysWith`
 * defaults to 'valet' on the managed tiers, so every car we are holding moves
 * this way. A `booked` outcome is the exception — it is for a car whose keys
 * the customer has taken back, where a valet has to be sent to collect them.
 */
async function remindKeyHolder(custody, occurrence, window, { io }) {
    const key = reminderKey(occurrence.at, window);
    if (custody.lastMoveReminderKey === key) return { outcome: 'already_reminded' };
    if (!custody.valet) return { outcome: 'no_key_holder' };

    // THE PUSH IS THE WHOLE JOB ON THIS PATH. It mints no order, so there is
    // nothing on the valet's board, nothing for the unclaimed watchdog to find
    // and nothing a second valet could pick up. If it does not land, the car
    // sits through the sweep and the customer takes the $65 ticket this plan
    // exists to prevent — so whether it landed is a fact we have to record.
    let delivered = false;
    let failure = 'no push attempted';
    try {
        const User = require('../models/User');
        const valet = await User.findById(custody.valet).select('firebaseUid').lean();
        if (!valet || !valet.firebaseUid) {
            failure = 'valet has no firebaseUid';
        } else {
            const { sendPushNotification } = require('../controllers/notificationController');
            const result = await sendPushNotification(
                valet.firebaseUid,
                'Street cleaning — move the car',
                `${custody.spot.streetAddress || 'A car you are holding'} is swept at ` +
                    `${sweepWindows.describeWindows([window])}. Move it and record the new spot.`,
                {
                    orderId: String(custody.currentOrder),
                    type: 'MANAGED_MOVE_REMINDER',
                    // Tapping the banner has to arrive somewhere. The app bails
                    // out of handleNotificationNavigation the moment
                    // `screen_name` is missing, so without this the notification
                    // opens the app and stops — and a valet who swipes it away
                    // is left with no in-app record of which car to move.
                    //
                    // It cannot be ValetOrderScreen: a park where the valet
                    // keeps the keys is stamped parkClosedAt at park time, which
                    // is exactly what takes it off the valet board that screen
                    // reads, so it would open an empty job. My Keys is the one
                    // shipped screen that lists the cars whose keys he is
                    // holding, and index 0 is the tab it opens on.
                    screen_name: 'KeyTransferScreen',
                    index: '0',
                }
            );
            // sendPushNotification RETURNS {success:false} rather than throwing
            // when the valet has no live token — a reinstall, a logout, or a
            // token the sender itself retired on a previous failure. Discarding
            // that return value is how "reminded" came to mean "we tried".
            delivered = !!(result && result.success);
            if (!delivered) {
                failure = (result && (result.message || result.error)) || 'push not delivered';
            }
        }
    } catch (err) {
        failure = err.message;
        console.error('curbSweep: key-holder push failed:', err.message);
    }

    if (io && custody.valet) {
        io.to(String(custody.valet)).emit('aspNotification', {
            orderId: String(custody.currentOrder),
            type: 'MANAGED_MOVE_REMINDER',
        });
    }

    custody.reminderSpotKey = custody.spot.tileKey;
    custody.reminderSentAt = new Date();
    custody.state = 'moving';
    // Stamped ONLY on a delivered push. This key is the "do not say it twice"
    // gate, so stamping it after a silent failure retires the single attempt
    // this car ever gets. Leaving it off means the next 60-second tick tries
    // again for the rest of the window, which is what rescues the valet who
    // reopens the app at 7:50 for an 8:30 sweep.
    if (delivered) custody.lastMoveReminderKey = key;
    await custody.save();

    if (!delivered) {
        // Raised at T-45, while a human still has time to phone the valet.
        // Deduped by the {kind, custody, dateKey} index, so the retry loop
        // above cannot turn this into a page a minute.
        await operatorAlert.raise({
            kind: 'move_reminder_undelivered',
            severity: operatorAlert.SEVERITY.PAGE,
            custody: custody._id,
            order: custody.currentOrder,
            customer: custody.customer,
            dateKey: nyDateKey(occurrence.at),
            title: 'Nobody was told to move a car we are holding',
            detail:
                `${custody.spot.streetAddress || 'A car we hold the keys to'} is swept at ` +
                `${sweepWindows.describeWindows([window])} and the reminder never reached the ` +
                `valet (${failure}). This move is a push and nothing else — it is on no job ` +
                `board — so unless somebody calls him the car takes the ticket.`,
            payload: {
                custodyId: String(custody._id),
                orderId: String(custody.currentOrder),
                valetId: String(custody.valet),
                reason: failure,
                spot: custody.spot,
            },
        });
        return { outcome: 'reminder_undelivered', reason: failure };
    }

    return { outcome: 'reminded' };
}

/**
 * Move a car whose keys the customer holds: a real, booked $0 move order.
 *
 * THE PATH THAT ACTUALLY FIRES TODAY. On every one of these plans the keys go
 * back to the customer at park close-out, so a sweep move is a genuine two-beat
 * ASP: a valet collects the keys before the sweep and returns them after.
 */
async function bookMove(custody, occurrence, window, { io, notify, now, staggerMs = 0 }) {
    const key = occurrenceKey(custody.subscription, occurrence.at, window);

    const suspension = await getSuspension(nyDateKey(occurrence.at));
    if (suspension) {
        // The city suspends alternate side ~40 days a year. Note the fail
        // direction, which is aspSuspensions' own: getSuspension returns null on
        // ANY error, so a database blip books the move rather than skipping it.
        // Booking needlessly costs one valet fee; skipping wrongly costs the
        // customer a $65 ticket, which is the single thing this plan prevents.
        return { outcome: 'suspended', reason: suspension.reason };
    }

    const pickUpTime = new Date(
        occurrence.at.getTime() - PICKUP_HEADSTART_MS + staggerMs
    );
    const listPrice = await aspListPriceCents();
    const otpCreatedAt = new Date();
    const spot = custody.spot || {};

    const order = new Order({
        customer: custody.customer,
        // From where the CAR ACTUALLY IS, never from the address the customer
        // typed at signup. On these plans they typed no address at all, and the
        // car may be three blocks from wherever they last were.
        customerLocation: {
            lat: spot.lat,
            lng: spot.lng,
            streetAddress: spot.streetAddress,
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
        coveredBySubscription: custody.subscription,
        listPriceCents: listPrice,
        autoBookKey: key,
        // The customer is holding the keys, so this move borrows them. They go
        // back at the end of it — a sweep is not consent to keep them.
        keysBorrowed: custody.keysWith === 'customer',
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
            // The schedule-driven booker or another tick got there first. This
            // is exactly what sharing the key namespace buys.
            return { outcome: 'already_booked' };
        }
        throw err;
    }

    await curbCustody.handOff({
        fromOrderId: custody.currentOrder,
        toOrderId: order._id,
    });

    const fresh = await CurbCustody.findById(custody._id);
    if (fresh) {
        fresh.movesThisPeriod = (fresh.movesThisPeriod || 0) + 1;
        fresh.lastMoveAt = new Date();
        fresh.lastMoveReminderKey = reminderKey(occurrence.at, window);
        fresh.reminderSpotKey = spot.tileKey;
        fresh.reminderSentAt = new Date();
        await fresh.save();
    }

    if (io) {
        io.emit('newOrder', order);
        io.to(String(custody.customer)).emit('orderUpdated', order);
    }

    try {
        const User = require('../models/User');
        const customer = await User.findById(custody.customer).select('firebaseUid').lean();
        if (customer && customer.firebaseUid) {
            const { sendPushNotification } = require('../controllers/notificationController');
            const when = occurrence.at.toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                timeZone: 'America/New_York',
            });
            await sendPushNotification(
                customer.firebaseUid,
                'We are moving your car',
                `${spot.streetAddress || 'Your block'} is swept at ${when}. A valet will come ` +
                    `for the keys before then and park it again after. Nothing for you to do.`,
                { orderId: String(order._id), type: 'MANAGED_MOVE_BOOKED' }
            );
        }
    } catch (err) {
        console.error('curbSweep: customer push failed:', err.message);
    }

    try {
        await (notify || defaultNotify)(order._id);
    } catch (err) {
        console.error(
            'curbSweep: valet dispatch failed for order',
            String(order._id),
            err.message
        );
    }

    console.log(`curbSweep: booked ${key} → order ${order._id}`);
    return { outcome: 'booked', orderId: order._id, key };
}

/**
 * One pass of the mover. `now`, `io` and `notify` are injectable for tests, the
 * same way subscriptionScheduler.tick is.
 */
async function tick({ now = new Date(), io = null, notify = null } = {}) {
    const results = [];
    try {
        const open = await CurbCustody.find({ closedAt: { $exists: false } }).limit(500);

        // A car whose block we have not read yet keeps trying. The normal
        // ordering is park-then-note (parkingNoteController hard requires
        // parkingLocation to exist first), so a car is 'resolving' for as long
        // as it takes the valet to photograph the sign.
        for (const custody of open) {
            if (custody.state === 'resolving' || custody.rules.source === 'unknown') {
                await curbCustody.refreshRules(custody);
            }
        }

        const refreshed = await CurbCustody.find({ closedAt: { $exists: false } }).limit(500);

        // Group everything due into one-block, one-sweep batches BEFORE booking
        // anything, so the stagger can be computed across the whole batch.
        const batches = new Map();
        for (const custody of refreshed) {
            const due = dueNow(custody, now);
            if (!due) continue;
            const batchKey = `${custody.spot.tileKey}:${due.at.getTime()}`;
            if (!batches.has(batchKey)) batches.set(batchKey, []);
            batches.get(batchKey).push({ custody, due });
        }

        for (const [batchKey, members] of batches) {
            if (members.length > BATCH_ALERT_ABOVE) {
                await operatorAlert.raise({
                    kind: 'block_batch_too_big',
                    severity: operatorAlert.SEVERITY.WARN,
                    dateKey: nyDateKey(now),
                    custody: members[0].custody._id,
                    title: `${members.length} managed cars on one block, one sweep`,
                    detail:
                        `All ${members.length} need moving at ` +
                        `${members[0].custody.spot.streetAddress || batchKey}. That is more than ` +
                        `one valet can realistically do inside the window. Every one of them is ` +
                        `still booked — a car we skipped for margin is a ticket we chose.`,
                    payload: { batchKey, count: members.length },
                });
            }

            for (let i = 0; i < members.length; i += 1) {
                const { custody, due } = members[i];
                try {
                    const sub = await Subscription.findById(custody.subscription);
                    if (!sub) {
                        results.push({ custodyId: custody._id, outcome: 'no_subscription' });
                        continue;
                    }
                    // The plan stopped paying while we still have their car. We
                    // keep moving it — the alternative is abandoning a car we
                    // physically hold — and the watchdog pages a human.
                    if (!isEntitled(sub, now) && !custody.planEndedAt) {
                        custody.planEndedAt = now;
                        await custody.save();
                    }

                    // NO WEEKLY CAP HERE, deliberately. Subscription.movesPerWeek
                    // is capped at 2 at the schema level so it cannot be raised
                    // by writing a bigger number, and on a flat plan the number
                    // of moves is decided by the block we chose, not by the
                    // customer. It is bypassed by tier and watched by cost.
                    const outcome =
                        custody.keysWith === 'valet'
                            ? await remindKeyHolder(custody, due, due.window, { io })
                            : await bookMove(custody, due, due.window, {
                                  io,
                                  notify,
                                  now,
                                  staggerMs: i * BATCH_STAGGER_MS,
                              });
                    results.push({ custodyId: custody._id, ...outcome });
                } catch (err) {
                    console.error(
                        'curbSweep: error moving custody',
                        String(custody._id),
                        err.message
                    );
                    results.push({
                        custodyId: custody._id,
                        outcome: 'error',
                        error: err.message,
                    });
                }
            }
        }
    } catch (err) {
        console.error('curbSweep tick error:', err.message);
    }
    return results;
}

/**
 * The alarm.
 *
 * Registered separately from tick() and NOT behind the mover's env flag: a
 * managed car with no resolvable window is a ticket we are now liable for, and
 * that is true whether or not the dispatcher is switched on.
 *
 * Every alert deduped on its own DECLARED schema path, keyed by New York date.
 * Alert fatigue is the failure mode that actually kills alarms — the one
 * alerting service already in this repo is dead — so the page set is kept small
 * and everything else is a clearable warn.
 */
async function watch({ now = new Date() } = {}) {
    const raised = [];
    const dateKey = nyDateKey(now);

    const say = async (custody, field, alert) => {
        if (custody.alerts[field] === dateKey) return;
        custody.alerts[field] = dateKey;
        await custody.save();
        await operatorAlert.raise({
            custody: custody._id,
            order: custody.currentOrder,
            customer: custody.customer,
            dateKey,
            ...alert,
        });
        raised.push(alert.kind);
    };

    try {
        await curbCustody.reconcile({ now });
    } catch (err) {
        console.error('curbSweep watch: reconcile failed:', err.message);
    }

    let open = [];
    try {
        open = await CurbCustody.find({ closedAt: { $exists: false } }).limit(500);
    } catch (err) {
        console.error('curbSweep watch: could not read custody:', err.message);
        return raised;
    }

    for (const custody of open) {
        try {
            const where = custody.spot.streetAddress || 'an unrecorded address';
            const windows = (custody.rules && custody.rules.windows) || [];

            // We are holding a car on a block we cannot read. This is the alert
            // the whole build exists for.
            if (custody.rules.source === 'unknown') {
                const held = Math.round(
                    (now.getTime() - new Date(custody.spotSince || custody.openedAt).getTime()) /
                        3600000
                );
                await say(custody, 'noRulesOn', {
                    kind: 'no_rules_for_block',
                    severity: operatorAlert.SEVERITY.WARN,
                    title: 'We are holding a car on a block nobody has read',
                    detail:
                        `A managed car has been at ${where} for ${held}h and we do not know when ` +
                        `that block is swept, so no move is scheduled. Any ticket it takes is ours. ` +
                        `Either get the valet to photograph the sign, or type the sweep days into ` +
                        `the console.`,
                    payload: {
                        custodyId: String(custody._id),
                        orderId: String(custody.currentOrder),
                        spot: custody.spot,
                        droppedWindows: custody.rules.droppedWindows,
                    },
                });
            }

            if (custody.rules.disputed) {
                await say(custody, 'disputedOn', {
                    kind: 'rules_disputed',
                    severity: operatorAlert.SEVERITY.WARN,
                    title: 'Two readings of one block disagree',
                    detail: custody.rules.disputeDetail || 'Moving for both sets of days.',
                    payload: { custodyId: String(custody._id), spot: custody.spot },
                });
            }

            if (custody.planEndedAt) {
                await say(custody, 'planEndedOn', {
                    kind: 'plan_ended_in_custody',
                    severity: operatorAlert.SEVERITY.PAGE,
                    title: 'A plan ended while we still have the car',
                    detail:
                        `The subscription stopped paying but the car is still at ${where} and we ` +
                        `are still moving it. Somebody has to decide how it gets back to them.`,
                    payload: { custodyId: String(custody._id), spot: custody.spot },
                });
            }

            if (windows.length) {
                // A sweep is happening right now on the block the car is on and
                // the car has not moved. A ticket is being written.
                //
                // This pages on the PHYSICAL fact — the car arrived on this spot
                // before the sweeper did and is still sitting on it — and not on
                // our own bookkeeping. It used to require `reminderSpotKey`,
                // which only remindKeyHolder and bookMove ever write, i.e. only
                // from tick(), i.e. only from behind CURB_SWEEP_ENABLED. So the
                // one case this alarm exists for — the mover never ran, or ran
                // and came back `no_key_holder`, or threw, or missed the window
                // because the sign photo landed late — left both fields
                // undefined and the page stayed silent while the car took a $65
                // ticket. The docstring at the top of this file promises the
                // alarm survives the mover being off; this is what makes that
                // true.
                //
                // `spotSince` before the window opened is what keeps it quiet
                // for the normal case: a valet legally parking behind the
                // sweeper mid-window has a spotSince inside the window, and that
                // is a move done right, not a ticket.
                const inProgress = sweepWindows.sweepInProgress(windows, now);
                const parkedBeforeTheSweeper =
                    inProgress &&
                    new Date(custody.spotSince || custody.openedAt).getTime() <
                        inProgress.startedAt.getTime();
                // A reminder went out for THIS spot and the car is still on it.
                // Kept as its own condition because a custody row with no tile
                // (a spot recorded without coordinates) would otherwise match
                // undefined against undefined and page for nothing.
                const reminderIgnored =
                    inProgress &&
                    !!custody.reminderSpotKey &&
                    custody.spot.tileKey === custody.reminderSpotKey;
                if (parkedBeforeTheSweeper || reminderIgnored) {
                    await say(custody, 'inProgressOn', {
                        kind: 'sweep_in_progress',
                        severity: operatorAlert.SEVERITY.PAGE,
                        title: 'A sweep is running and the car has not moved',
                        detail:
                            `${where} is being swept now and the car is still on it. This is a ` +
                            `ticket in progress. ` +
                            (custody.reminderSentAt
                                ? 'We asked for a move and it did not happen.'
                                : 'Nobody was ever asked to move it — no reminder went out.'),
                        payload: { custodyId: String(custody._id), spot: custody.spot },
                    });
                } else if (inProgress && custody.reminderSentAt) {
                    await say(custody, 'didNotMoveOn', {
                        kind: 'car_did_not_move',
                        severity: operatorAlert.SEVERITY.PAGE,
                        title: 'We asked for a move and the car is still there',
                        detail: `${where} — the reminder went out and the car has not moved.`,
                        payload: { custodyId: String(custody._id), spot: custody.spot },
                    });
                }

                // Nobody has taken the move. Said at T-20, and ALSO the evening
                // before for an early sweep: a 6am move with nobody on shift is
                // knowable the night before, not at 5:40am.
                const next = sweepWindows.nextSweep(windows, now);
                if (next) {
                    const untilMs = next.at.getTime() - now.getTime();
                    const early = next.window.hour < EARLY_SWEEP_HOUR;
                    const eveningBefore =
                        early && untilMs > 0 && untilMs < 16 * 3600000 && nyClock(now).hour >= 18;
                    if (untilMs > 0 && (untilMs <= UNCLAIMED_LEAD_MS || eveningBefore)) {
                        const move = await Order.findOne({
                            customer: custody.customer,
                            aspMode: true,
                            status: 'pending',
                            pickUpTime: { $lte: next.at, $gte: new Date(next.at.getTime() - 3600000) },
                        }).select('_id status');
                        // The keys-with-valet path books nothing, so the query
                        // above can never find it and this whole watchdog used
                        // to skip the plans it matters most on: the first thing
                        // anyone heard was sweep_in_progress, raised with the
                        // sweeper already on the block and the ticket being
                        // written. The car standing on the same tile we pushed
                        // about is the equivalent fact.
                        const toldAndStill =
                            custody.keysWith === 'valet' &&
                            custody.lastMoveReminderKey === reminderKey(next.at, next.window) &&
                            !!custody.reminderSpotKey &&
                            custody.spot.tileKey === custody.reminderSpotKey &&
                            untilMs <= PUSH_NOT_MOVED_LEAD_MS;
                        if (move) {
                            await say(custody, 'unclaimedOn', {
                                kind: 'move_unclaimed',
                                severity: operatorAlert.SEVERITY.PAGE,
                                title: early
                                    ? 'An early-morning move has no valet yet'
                                    : 'A move is due and no valet has taken it',
                                detail:
                                    `${where} is swept at ` +
                                    `${sweepWindows.describeWindows([next.window])} and nobody has ` +
                                    `accepted the job.`,
                                payload: {
                                    custodyId: String(custody._id),
                                    moveOrderId: String(move._id),
                                    at: next.at,
                                },
                            });
                        } else if (toldAndStill) {
                            await say(custody, 'unclaimedOn', {
                                kind: 'move_not_made',
                                severity: operatorAlert.SEVERITY.PAGE,
                                title: 'The valet was told to move a car and it is still there',
                                detail:
                                    `${where} is swept at ` +
                                    `${sweepWindows.describeWindows([next.window])}, we pushed the ` +
                                    `valet holding the keys, and the car has not left the block. ` +
                                    `There is no order to reassign — somebody has to call him.`,
                                payload: {
                                    custodyId: String(custody._id),
                                    orderId: String(custody.currentOrder),
                                    valetId: String(custody.valet),
                                    remindedAt: custody.reminderSentAt,
                                    at: next.at,
                                    spot: custody.spot,
                                },
                            });
                        }
                    }
                }
            }

            // The margin number, rather than a guess. A car on a twice-swept
            // block plus a free daily park is roughly ten dispatches a month.
            if (custody.movesThisPeriod > 0) {
                const sub = await Subscription.findById(custody.subscription)
                    .select('amountCents tier')
                    .lean();
                const perMove = await aspListPriceCents();
                if (sub && perMove && custody.movesThisPeriod * perMove > sub.amountCents) {
                    await say(custody, 'costOn', {
                        kind: 'move_cost_exceeds_plan',
                        severity: operatorAlert.SEVERITY.WARN,
                        title: 'This car has cost more to move than the plan charges',
                        detail:
                            `${custody.movesThisPeriod} moves this period at ` +
                            `$${(perMove / 100).toFixed(2)} each, against a ` +
                            `$${(sub.amountCents / 100).toFixed(2)} plan.`,
                        payload: {
                            custodyId: String(custody._id),
                            moves: custody.movesThisPeriod,
                            perMoveCents: perMove,
                            planCents: sub.amountCents,
                        },
                    });
                }
            }
        } catch (err) {
            console.error(
                'curbSweep watch: error on custody',
                String(custody._id),
                err.message
            );
        }
    }

    return raised;
}

module.exports = {
    tick,
    watch,
    dueNow,
    occurrenceKey,
    reminderKey,
    bookMove,
    remindKeyHolder,
    BATCH_STAGGER_MS,
    BATCH_ALERT_ABOVE,
};
