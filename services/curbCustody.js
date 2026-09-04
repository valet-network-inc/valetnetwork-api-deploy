/**
 * curbCustody — opening, re-arming and closing the record of a car we hold.
 *
 * THE LOOP THIS EXISTS TO CLOSE:
 *
 *     we park the car        →  capture that block's cleaning window
 *                            →  we hold responsibility until the sweep
 *     sweep is due           →  dispatch a valet, move it to another empty spot
 *                            →  CAPTURE THAT SPOT'S WINDOW TOO
 *     sweep ends             →  move it back to the original spot
 *                            →  back to that block's window. normal.
 *     customer takes the car →  management stops
 *     customer parks again   →  loop restarts, wherever the valet puts it
 *
 * The recursion IS the feature. Arm once and never re-arm and a car is managed
 * exactly once and then abandoned on whatever block the first sweep left it on.
 *
 * Everything here is called from a request path a valet is waiting on, so every
 * public entry point either cannot throw (`armSafely`, `closeSafely`) or is
 * called from a background tick that catches for itself.
 */

const CurbCustody = require('../models/CurbCustody');
const Order = require('../models/Order');
const ParkingNote = require('../models/ParkingNote');
const StreetParkingMark = require('../models/StreetParkingMark');
const Subscription = require('../models/Subscription');
const sweepWindows = require('./sweepWindows');
// No cycle: subscriptionService requires only models, subscriptionPlans and
// nyTime — never this file.
const subscriptionService = require('./subscriptionService');
const operatorAlert = require('./operatorAlert');
const { nyDateKey, nyClock } = require('./nyTime');

const MANAGED_TIERS = ['home_garage', 'valet_anywhere'];

// How far a ParkingNote may sit from where the car actually is before we stop
// believing it describes this block.
//
// This is not a tolerance, it is a DETECTOR. ParkingNote is upserted one row per
// ORDER, so after a second park within one order the note's rules describe block
// A while the car stands on block B — and the note still exists, so nothing else
// in the system flags it. Comparing the note's own coordinates against the
// order's current parkingLocation is the only signal available for that state.
// 40m is roughly half a short Brooklyn block: wide enough for GPS drift and a
// valet nudging the car two spaces up, narrow enough to catch a real move.
const NOTE_SPOT_TOLERANCE_M = 40;

// How far to look for another valet's note on the same block face.
const BLOCK_NOTE_RADIUS_M = 60;

// A car that has not actually gone anywhere. Only used while a sweep move is
// outstanding, to tell "the app re-sent the location it already had" apart from
// "the valet moved the car" — a curb-to-curb alternate-side hop is 10-20m, so
// anything above this during a move is the move.
const RESENT_LOCATION_M = 5;

// A car whose recorded spot is further than this from the order's actual
// parking location has drifted, and a valet would be sent to the wrong place.
const DRIFT_TOLERANCE_M = 40;

// How long a custody row may sit on a completed order before it counts as a
// leak rather than a loop in progress. The normal hop takes minutes.
const STALE_COMPLETED_MS = 6 * 60 * 60 * 1000;

const isManagedTier = (tier) => MANAGED_TIERS.includes(tier);

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** Enterprise dispatches are the front desk's custody, never ours. */
const isEnterprise = (order) =>
    !!(order && order.endCustomerName && String(order.endCustomerName).trim());

/**
 * A street-cleaning move's return leg is `orderType: 'retrieval'`, but it is not
 * a retrieval in the sense the customer means: the car comes off the swept block
 * and goes straight back onto the street. The valet re-parks through that leg,
 * so it has to be able to re-arm custody like any other park.
 */
const isSweepReturnLeg = (order) =>
    !!(
        order &&
        order.orderType === 'retrieval' &&
        (order.aspMode || String(order.autoBookKey || '').startsWith('aspreturn:'))
    );

/**
 * Is this order a managed park — one of ours, on a flat plan, on the street?
 *
 * Deliberately NOT gated on `aspMode`: the free daily park that a flat plan
 * covers is aspMode:false (evaluateParkCoverage → 'daily_free_park'), and that
 * is exactly the park that starts custody.
 */
async function classify(order) {
    if (!order) return null;
    if (order.orderType !== 'parking' && !isSweepReturnLeg(order)) return null;
    // A sweep return is 'completed' at the moment the valet closes it, and that
    // is precisely when we most need to record where the car ended up.
    if (['cancelled'].includes(order.status)) return null;
    if (order.status === 'completed' && !isSweepReturnLeg(order)) return null;
    if (isEnterprise(order)) return null;

    // Custody follows `indefinite`, NOT coverage. They are different questions
    // and they genuinely diverge:
    //
    //   covered    — did the plan PAY for this particular park? Once a day.
    //   indefinite — is this a car we HOLD until asked? Tier and place, always.
    //
    // The SECOND park of a day is charged for and still has no end time, and so
    // is a Car Watch park (coverage is gated on !carWatch, the indefinite stamp
    // is not). Keying custody on coverage meant those cars were promised
    // "Parked until you ask for it back" in the server's own words while no
    // CurbCustody row existed — so nothing read the block, nothing moved the
    // car before the sweep, and the watchdog had no row to alarm on. An
    // unwatched car on a cleaning block is a ticket or a tow.
    if (!order.coveredBySubscription && !order.indefinite) return null;
    const loc = order.parkingLocation;
    if (!loc || !finite(loc.lat) || !finite(loc.lng)) return null;

    // Prefer the stamp when the plan paid, because it names the exact
    // subscription that was charged. Fall back to the customer's live plan for
    // an indefinite park the plan did not pay for — there is no stamp on those.
    let sub = null;
    if (order.coveredBySubscription) {
        const subId = order.coveredBySubscription._id || order.coveredBySubscription;
        sub = await Subscription.findById(subId).select('tier user status').lean();
    } else {
        const live = await subscriptionService.getActiveSubscription(customerIdOf(order));
        // .lean() below is not available on the doc getActiveSubscription
        // returns, so take the same shape by hand.
        sub = live ? { _id: live._id, tier: live.tier, user: live.user, status: live.status } : null;
    }
    if (!sub || !isManagedTier(sub.tier)) return null;

    return { sub, loc };
}

const customerIdOf = (order) =>
    order && order.customer
        ? String(order.customer._id || order.customer)
        : null;

const valetIdOf = (order) =>
    order && order.valet ? order.valet._id || order.valet : undefined;

/**
 * Open custody for this order, or re-point it at the block the car has just
 * been moved to. Idempotent: this runs on every park AND every move, and may
 * run twice for one move.
 */
async function arm({ order }) {
    const classified = await classify(order);
    if (!classified) return null;
    const { sub, loc } = classified;

    const tileKey = sweepWindows.tileKeyOf(loc);
    const now = new Date();

    let custody = await CurbCustody.findOne({
        currentOrder: order._id,
        closedAt: { $exists: false },
    });

    // The car may already be under management through the order this one came
    // out of. A sweep move mints order M and then a return leg R linked back to
    // it; the valet re-parks through R, so R has to attach to the SAME row
    // rather than opening a second one for the same car. Matching on the linked
    // order (and then on the chain) is precise enough not to collide with a
    // second car in the same household, which a match on customer alone would.
    if (!custody && order.linkedOrderId) {
        custody = await CurbCustody.findOne({
            closedAt: { $exists: false },
            customer: customerIdOf(order),
            $or: [
                { currentOrder: order.linkedOrderId },
                { orderChain: order.linkedOrderId },
            ],
        });
        if (custody) {
            custody.currentOrder = order._id;
            if (!custody.orderChain.some((id) => String(id) === String(order._id))) {
                custody.orderChain.push(order._id);
            }
        }
    }

    if (!custody) {
        custody = new CurbCustody({
            customer: customerIdOf(order),
            subscription: sub._id,
            tier: sub.tier,
            currentOrder: order._id,
            orderChain: [order._id],
            valet: valetIdOf(order),
            // The park is what puts the keys in our hands. On these plans they
            // stay there until the customer asks for them back — that is the
            // whole point of the tier, and it is the only way a sweep move can
            // happen without the customer being present for it.
            keysWith: 'valet',
            keysWithSetAt: now,
            keyHolder: valetIdOf(order),
            keyHandoffs: [
                {
                    at: now,
                    direction: 'to_valet',
                    order: order._id,
                    toValet: valetIdOf(order),
                    verifiedVia: 'order_creation',
                },
            ],
            state: 'resolving',
            spot: {
                lat: loc.lat,
                lng: loc.lng,
                streetAddress: loc.streetAddress,
                tileKey,
            },
            spotSince: now,
            spots: [
                {
                    seq: 1,
                    order: order._id,
                    lat: loc.lat,
                    lng: loc.lng,
                    streetAddress: loc.streetAddress,
                    tileKey,
                    arrivedAt: now,
                },
            ],
            openedAt: now,
        });
        await stampKeysOnOrder(order, custody);
        try {
            await custody.save();
        } catch (err) {
            if (err && err.code === 11000) {
                // Another concurrent park won. Re-read and fall through to the
                // move path, which is idempotent.
                custody = await CurbCustody.findOne({
                    currentOrder: order._id,
                    closedAt: { $exists: false },
                });
                if (!custody) return null;
            } else {
                throw err;
            }
        }
        return custody;
    }

    // Already open on this order. Only a change of BLOCK is a move worth
    // recording — a valet correcting a pin by ten metres has not changed the
    // sign, and appending a spot for that would fill the history with noise.
    // A park by a customer who had taken their keys back hands them over again.
    // Without this the dispatcher would keep booking two-beat sweep moves for a
    // car whose keys are in fact in our pocket.
    takeKeys(custody, order, now);

    // ...EXCEPT once we have asked for the car to be moved off a sweep.
    //
    // The tile is ~110m x 85m, and an alternate-side move is by definition a hop
    // to the OTHER SIDE OF THE SAME STREET — ten to twenty metres. It lands in
    // the same tile nearly every time. Read as "same spot" it keeps the old
    // side's windows, keeps `state`, and never drops back to 'resolving', and
    // nothing else re-reads a row that is neither resolving nor unknown. So
    // from the first successful sweep move onward the car is scheduled against
    // the curb it LEFT: it is never moved for the curb it is now on, and the
    // in-progress watchdog is measured against the same wrong windows, so it
    // stays quiet while the sweeper writes a $65 ticket the company eats.
    //
    // A reminder having gone out is not a heuristic about distance, it is the
    // fact itself: we told the key holder "move it and record the new spot", so
    // the next spot they record IS that move, however few metres it is. The
    // small tolerance below is only there so that re-sending the SAME location
    // (a status update that carries parkingLocation along unchanged) is not
    // mistaken for a move and does not blank a perfectly good block reading.
    const askedToMove = !!custody.lastMoveReminderKey || custody.state === 'moving';
    const movedMeters =
        custody.spot && finite(custody.spot.lat) && finite(custody.spot.lng)
            ? sweepWindows.haversineMeters(
                  { lat: custody.spot.lat, lng: custody.spot.lng },
                  { lat: loc.lat, lng: loc.lng }
              )
            : Infinity;
    const sameSpot =
        custody.spot &&
        custody.spot.tileKey === tileKey &&
        (!askedToMove || movedMeters <= RESENT_LOCATION_M);

    if (sameSpot) {
        custody.spot.lat = loc.lat;
        custody.spot.lng = loc.lng;
        if (loc.streetAddress) custody.spot.streetAddress = loc.streetAddress;
        if (valetIdOf(order)) custody.valet = valetIdOf(order);
        await stampKeysOnOrder(order, custody);
        await custody.save();
        return custody;
    }

    const last = custody.spots[custody.spots.length - 1];
    if (last && !last.departedAt) last.departedAt = now;

    custody.spots.push({
        seq: (last ? last.seq : 0) + 1,
        order: order._id,
        lat: loc.lat,
        lng: loc.lng,
        streetAddress: loc.streetAddress,
        tileKey,
        arrivedAt: now,
    });
    custody.spot = {
        lat: loc.lat,
        lng: loc.lng,
        streetAddress: loc.streetAddress,
        tileKey,
    };
    custody.spotSince = now;
    if (valetIdOf(order)) custody.valet = valetIdOf(order);
    await stampKeysOnOrder(order, custody);

    // The car is somewhere new, so whatever we knew about the old block is now
    // wrong. Drop back to 'resolving' and clear the rules rather than carrying
    // them forward — dispatching against the block the car has LEFT is the
    // precise failure this model exists to prevent.
    custody.rules = {
        source: 'unknown',
        windows: [],
        disputed: false,
        droppedWindows: 0,
    };
    custody.state = 'resolving';
    custody.lastMoveReminderKey = undefined;
    custody.reminderSpotKey = undefined;
    custody.reminderSentAt = undefined;
    // A new block gets a fresh chance to alarm.
    custody.alerts.noRulesOn = undefined;
    custody.alerts.disputedOn = undefined;
    custody.alerts.didNotMoveOn = undefined;
    custody.alerts.inProgressOn = undefined;

    await custody.save();
    return custody;
}

/**
 * Mirror the key decision onto the ORDER.
 *
 * The valet's phone has to know, the moment it opens a job, whether this park
 * ends with the keys in their pocket — it decides whether a return-key OTP is
 * even offered. It cannot answer that from custody without a round trip, and
 * getting it wrong is not cosmetic: the app would wait for a handoff nobody is
 * ever going to walk, and the job would sit on their screen forever.
 */
async function stampKeysOnOrder(order, custody) {
    if (!order || !order._id) return;
    const stays = custody.keysWith === 'valet';
    if (order.keysStayWithValet === stays) return;
    try {
        await Order.updateOne({ _id: order._id }, { $set: { keysStayWithValet: stays } });
        order.keysStayWithValet = stays;
    } catch (err) {
        console.error('curbCustody.stampKeysOnOrder failed:', err.message);
    }
}

/**
 * Record that the keys are now in our hands.
 *
 * Called from `arm()` on every park. Idempotent: a valet correcting a pin does
 * not generate a second handoff entry, because the keys did not move.
 */
function takeKeys(custody, order, now = new Date()) {
    // A sweep move only BORROWS the keys. The customer asked for them; a street
    // cleaning happening on our schedule is not a reason to take them back, and
    // silently doing so is exactly the kind of thing that makes holding
    // somebody's car keys feel like a trap rather than a service.
    if (order && order.keysBorrowed) return custody;
    const valet = valetIdOf(order);
    const alreadyOurs =
        custody.keysWith === 'valet' &&
        String(custody.keyHolder || '') === String(valet || '');
    if (alreadyOurs) return custody;

    custody.keysWith = 'valet';
    custody.keysWithSetAt = now;
    custody.keyHolder = valet;
    // A park supersedes any key-back request that never completed — the
    // customer is standing in front of the valet handing the keys over.
    if (custody.keyRequest && custody.keyRequest.requestedAt && !custody.keyRequest.deliveredAt) {
        custody.keyRequest.cancelledAt = now;
    }
    custody.keyHandoffs.push({
        at: now,
        direction: 'to_valet',
        order: order && order._id,
        toValet: valet,
        verifiedVia: 'order_creation',
    });
    return custody;
}

/**
 * Record that the keys went back to the customer.
 *
 * Custody deliberately STAYS OPEN. The car is still parked on our block, still
 * on our plan, and still ours to move before the sweep — the only thing that
 * changed is that a sweep move now costs two handoffs instead of a push.
 * Closing here would abandon a car we are still being paid to manage.
 */
async function giveKeysBack({ custody, order, verifiedVia = 'return_key', now = new Date() }) {
    if (!custody) return null;
    custody.keysWith = 'customer';
    custody.keysWithSetAt = now;
    custody.keyHandoffs.push({
        at: now,
        direction: 'to_customer',
        order: order && order._id,
        fromValet: custody.keyHolder,
        verifiedVia,
    });
    custody.keyHolder = undefined;
    if (custody.keyRequest && custody.keyRequest.requestedAt) {
        custody.keyRequest.deliveredAt = now;
    }
    await custody.save();
    // The park the car is sitting under no longer keeps the keys, so the valet
    // app must stop suppressing the key handoff on it.
    try {
        await Order.updateOne(
            { _id: custody.currentOrder },
            { $set: { keysStayWithValet: false } }
        );
    } catch (err) {
        console.error('curbCustody.giveKeysBack: order stamp failed:', err.message);
    }
    return custody;
}

/** The open custody row for a customer, or null. */
async function openFor(customerId) {
    if (!customerId) return null;
    try {
        return await CurbCustody.findOne({
            customer: customerId,
            closedAt: { $exists: false },
        }).sort({ openedAt: -1 });
    } catch (err) {
        console.error('curbCustody.openFor failed:', err.message);
        return null;
    }
}

/**
 * Do we hold this customer's keys right now?
 *
 * The question every handoff asks, because it decides how many OTP moments the
 * job has. Fails toward FALSE: believing we have keys we do not sends a valet to
 * a locked car, while believing we lack keys we do have costs one extra trip.
 */
async function weHoldTheKeys(customerId) {
    const custody = await openFor(customerId);
    return !!(custody && custody.keysWith === 'valet');
}

/**
 * The wrapper every request path calls. It must be impossible for custody
 * bookkeeping to fail a valet's park, so nothing escapes here.
 */
async function armSafely({ order, orderId }) {
    try {
        let doc = order;
        if (!doc && orderId) doc = await Order.findById(orderId);
        if (!doc) return null;
        return await arm({ order: doc });
    } catch (err) {
        console.error('curbCustody.armSafely failed:', err.message);
        return null;
    }
}

/**
 * Read the sweep windows for the block this car is on, in the order that
 * reflects how much we should trust each source.
 *
 * Returns { source, windows, disputed, disputeDetail, droppedWindows, noteId }.
 * `source: 'unknown'` means we do not know — which is an ALARM, never a green
 * light. It is never "no sweep here".
 */
async function resolveRules({ order, note, spot }) {
    const at = { lat: spot.lat, lng: spot.lng };
    let primary = null;
    let disputeDetail = null;
    let dropped = 0;

    // 1. This order's own note — a valet stood at this car and photographed this
    //    sign. Guarded on distance, because the note is upserted per order and
    //    after a move it may still describe the previous block.
    let ownNote = note;
    if (!ownNote && order) {
        ownNote = await ParkingNote.findOne({ order: order._id })
            .sort({ updatedAt: -1 })
            .lean();
    }
    if (ownNote && ownNote.location) {
        const away = sweepWindows.haversineMeters(at, {
            lat: ownNote.location.lat,
            lng: ownNote.location.lng,
        });
        // Distance alone cannot see across a street. 40m is half a short
        // Brooklyn block, so it covers BOTH curbs, and an alternate-side move
        // is precisely a hop from one curb to the other — the note the valet
        // photographed on the north side is still "within tolerance" of the
        // south side it now stands on, and the car would be scheduled against
        // the sign it was moved AWAY FROM. Time can see what distance cannot:
        // parkingNoteController hard-requires order.parkingLocation to exist
        // before it will accept a note, so a note that genuinely describes
        // where the car stands now is always written AFTER the car arrived
        // there. One written before is describing the spot it left.
        //
        // Rejecting it drops the row to source 'unknown' → state 'blind', which
        // the watchdog already pages on (no_rules_for_block) and an operator can
        // close by typing the sign in. A loud "we do not know this curb" beats a
        // confident schedule for the wrong one.
        const noteWrittenAt = ownNote.updatedAt || ownNote.createdAt;
        const arrivedAt = spot.since ? new Date(spot.since).getTime() : null;
        const predatesThisSpot =
            !!arrivedAt &&
            !!noteWrittenAt &&
            new Date(noteWrittenAt).getTime() < arrivedAt;
        if (predatesThisSpot) {
            disputeDetail =
                `The parking note for this order was filed before the car was moved to where ` +
                `it stands now, so it describes the spot it left. Ignored.`;
        } else if (away <= NOTE_SPOT_TOLERANCE_M) {
            // A valet who read the sign and told us there is nothing to read is
            // the ONLY thing that legitimately silences the alarm on a block.
            const status = ownNote.sweepDataStatus;
            if (status === 'none_on_sign' || status === 'off_street') {
                return {
                    source: status,
                    windows: [],
                    disputed: false,
                    droppedWindows: 0,
                    noteId: ownNote._id,
                };
            }
            const converted = sweepWindows.toSweepWindows(ownNote.streetCleaning);
            dropped = converted.dropped;
            if (converted.windows.length) {
                primary = { source: 'note', windows: converted.windows, noteId: ownNote._id };
            }
            // An empty array with no sweepDataStatus is a LEGACY note, and it
            // means both "no cleaning here" and "the valet skipped the field".
            // It falls through to the block sources and then to unknown. It is
            // never backfilled to 'none_on_sign' — that would be a lie that
            // silences the alarm on this block permanently.

            // The valet app writes date.getHours(), the PHONE's local hour, and
            // nothing validates it. A phone on the wrong timezone turns into a
            // wrong dispatch instant that looks completely ordinary.
            if (finite(ownNote.tzOffsetMinutes)) {
                const nyOffset = nyOffsetMinutes(ownNote.createdAt || new Date());
                if (ownNote.tzOffsetMinutes !== nyOffset) {
                    disputeDetail =
                        `Sign times were entered on a phone ${ownNote.tzOffsetMinutes} minutes ` +
                        `off UTC while New York was ${nyOffset}. The hours may be shifted.`;
                }
            }
        } else {
            disputeDetail =
                `The parking note for this order was taken ${Math.round(away)}m away, ` +
                `so it describes a different block. Ignored.`;
        }
    }

    // 2. Another valet's note on the same block face.
    const blockWindows = await blockNoteWindows(at, ownNote && ownNote._id);

    // 3. StreetParkingMark consensus. Measured in production: 1 of 11 marks
    //    carries streetCleaning at all, so this is a tertiary hint and never a
    //    confirmation on its own.
    const markWindows = await markTileWindows(spot.tileKey);

    const secondary = blockWindows.length
        ? { source: 'block', windows: blockWindows }
        : markWindows.length
        ? { source: 'mark', windows: markWindows }
        : null;

    if (!primary && !secondary) {
        return {
            source: 'unknown',
            windows: [],
            disputed: false,
            disputeDetail,
            droppedWindows: dropped,
        };
    }
    if (!primary) {
        return {
            source: secondary.source,
            windows: secondary.windows,
            disputed: false,
            disputeDetail,
            droppedWindows: dropped,
        };
    }
    if (!secondary) {
        return {
            source: 'note',
            windows: primary.windows,
            disputed: !!disputeDetail,
            disputeDetail,
            droppedWindows: dropped,
            noteId: primary.noteId,
        };
    }

    // Two readings of one block. If they agree, nothing to say. If they do not,
    // dispatch on the UNION and flag it: moving the car on a morning it did not
    // need moving costs one valet fee, and missing the real morning costs a $65
    // ticket we have said we eat. Same asymmetry aspSuspensions reasons from.
    if (sweepWindows.sameWindows(primary.windows, secondary.windows)) {
        return {
            source: 'note',
            windows: primary.windows,
            disputed: !!disputeDetail,
            disputeDetail,
            droppedWindows: dropped,
            noteId: primary.noteId,
        };
    }
    return {
        source: 'note',
        windows: sweepWindows.unionWindows(primary.windows, secondary.windows),
        disputed: true,
        disputeDetail:
            (disputeDetail ? `${disputeDetail} ` : '') +
            `This block's own note says ${sweepWindows.describeWindows(primary.windows)}, ` +
            `while ${secondary.source === 'block' ? 'another note on the same block' : 'the block map'} ` +
            `says ${sweepWindows.describeWindows(secondary.windows)}. Moving for both.`,
        droppedWindows: dropped,
        noteId: primary.noteId,
    };
}

/** New York's UTC offset, in the same sign convention as getTimezoneOffset(). */
function nyOffsetMinutes(at) {
    const c = nyClock(at);
    const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
    return Math.round((new Date(at).getTime() - asUtc) / 60000);
}

async function blockNoteWindows(at, excludeNoteId) {
    const dLat = BLOCK_NOTE_RADIUS_M / 111000;
    const dLng = BLOCK_NOTE_RADIUS_M / (111000 * Math.cos((at.lat * Math.PI) / 180));
    const candidates = await ParkingNote.find({
        'location.lat': { $gte: at.lat - dLat, $lte: at.lat + dLat },
        'location.lng': { $gte: at.lng - dLng, $lte: at.lng + dLng },
        'streetCleaning.0': { $exists: true },
    })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();

    for (const n of candidates) {
        if (excludeNoteId && String(n._id) === String(excludeNoteId)) continue;
        const away = sweepWindows.haversineMeters(at, {
            lat: n.location.lat,
            lng: n.location.lng,
        });
        if (away > BLOCK_NOTE_RADIUS_M) continue;
        const converted = sweepWindows.toSweepWindows(n.streetCleaning);
        if (converted.windows.length) return converted.windows;
    }
    return [];
}

async function markTileWindows(tileKey) {
    if (!tileKey) return [];
    const marks = await StreetParkingMark.find({
        tileKey,
        'details.streetCleaning.0': { $exists: true },
    })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean();
    for (const m of marks) {
        const converted = sweepWindows.toSweepWindows(m.details.streetCleaning);
        if (converted.windows.length) return converted.windows;
    }
    return [];
}

/**
 * Called after a valet files a ParkingNote. This is where a car stops being
 * 'resolving' and becomes either 'armed' or 'blind'.
 */
async function enrichFromNote({ order, note }) {
    const custody = await CurbCustody.findOne({
        currentOrder: order._id,
        closedAt: { $exists: false },
    });
    if (!custody) return null;
    return applyRules(custody, { order, note });
}

async function applyRules(custody, { order, note } = {}) {
    const spot = custody.spot || {};
    const resolved = await resolveRules({
        order,
        note,
        // `since` is when the car arrived on THIS spot. resolveRules needs it to
        // tell a note that describes this curb from one filed for the curb the
        // car was moved off — the two can be twenty metres apart.
        spot: {
            lat: spot.lat,
            lng: spot.lng,
            tileKey: spot.tileKey,
            since: custody.spotSince,
        },
    });

    custody.rules = {
        source: resolved.source,
        windows: resolved.windows,
        capturedAt: new Date(),
        noteId: resolved.noteId,
        disputed: !!resolved.disputed,
        disputeDetail: resolved.disputeDetail,
        droppedWindows: resolved.droppedWindows || 0,
    };

    const last = custody.spots[custody.spots.length - 1];
    if (last) {
        last.windows = resolved.windows;
        last.rulesSource = resolved.source;
        last.disputed = !!resolved.disputed;
        last.noteId = resolved.noteId;
        last.rulesCapturedAt = new Date();
    }

    // 'none_on_sign' and 'off_street' are armed with zero windows: we know there
    // is nothing to move for. 'unknown' is blind, which the watchdog alarms on.
    custody.state = resolved.source === 'unknown' ? 'blind' : 'armed';
    await custody.save();
    return custody;
}

/**
 * Re-read the block for a car we already hold. Used by the dispatcher tick so a
 * note filed after the park (the normal ordering — parkingNoteController hard
 * requires parkingLocation to exist first) still arms the car within a minute,
 * and so a car whose rules were never resolved keeps trying.
 */
async function refreshRules(custody) {
    try {
        const order = await Order.findById(custody.currentOrder);
        return await applyRules(custody, { order });
    } catch (err) {
        console.error('curbCustody.refreshRules failed:', err.message);
        return custody;
    }
}

/** A human typing the sign into the admin console. */
async function setOperatorRules({ custodyId, streetCleaning, note }) {
    const custody = await CurbCustody.findById(custodyId);
    if (!custody) return null;
    const converted = sweepWindows.toSweepWindows(streetCleaning);
    custody.rules = {
        source: 'operator',
        windows: converted.windows,
        capturedAt: new Date(),
        disputed: false,
        disputeDetail: note || undefined,
        droppedWindows: converted.dropped,
    };
    custody.state = 'armed';
    custody.alerts.noRulesOn = undefined;
    const last = custody.spots[custody.spots.length - 1];
    if (last) {
        last.windows = converted.windows;
        last.rulesSource = 'operator';
        last.rulesCapturedAt = new Date();
    }
    await custody.save();
    return custody;
}

/**
 * The car went back to the customer, or the order died.
 *
 * Note what is NOT a close signal: `parkClosedAt`. That is stamped when the KEYS
 * go back, which on these plans happens at the end of every park while the car
 * stays on the street for weeks. Closing on it would drop exactly the cars this
 * feature exists for.
 */
async function close({ custody, reason }) {
    if (!custody || custody.closedAt) return custody;
    custody.closedAt = new Date();
    custody.closeReason = reason;
    custody.state = 'closed';
    const last = custody.spots[custody.spots.length - 1];
    if (last && !last.departedAt) last.departedAt = custody.closedAt;
    await custody.save();
    return custody;
}

async function closeSafely({ orderId, customerId, reason }) {
    try {
        const query = { closedAt: { $exists: false } };
        if (orderId) query.currentOrder = orderId;
        else if (customerId) query.customer = customerId;
        else return null;
        const custody = await CurbCustody.findOne(query);
        if (!custody) return null;
        return await close({ custody, reason });
    } catch (err) {
        console.error('curbCustody.closeSafely failed:', err.message);
        return null;
    }
}

/**
 * A sweep move mints a NEW order, and completing that move's return leg drives
 * the OLD order to 'completed'. The custody row has to HOP rather than close —
 * this is the recursion, and getting it wrong means a car is managed once and
 * then abandoned on whatever block the first sweep left it on.
 *
 * Ordering matters: the completion of the old order can arrive before or after
 * the new park. Hopping is therefore keyed on the NEW order existing, and
 * `closeSafely` is only ever called for a real retrieval, so a completion can
 * never close a row that has already hopped.
 */
async function handOff({ fromOrderId, toOrderId }) {
    try {
        const custody = await CurbCustody.findOne({
            currentOrder: fromOrderId,
            closedAt: { $exists: false },
        });
        if (!custody) return null;
        custody.currentOrder = toOrderId;
        if (!custody.orderChain.some((id) => String(id) === String(toOrderId))) {
            custody.orderChain.push(toOrderId);
        }
        custody.state = 'moving';
        await custody.save();
        return custody;
    } catch (err) {
        console.error('curbCustody.handOff failed:', err.message);
        return null;
    }
}

/**
 * The safety net that makes the fire-and-forget hooks safe to use.
 *
 * Every arm() call site is wrapped in a catch, which is right — a valet's park
 * must never fail because of bookkeeping — but it means a swallowed throw, a
 * deploy gap, or an order parked before this shipped leaves a car we are holding
 * with no row saying so. And a row that has DRIFTED is worse than a missing one:
 * it will confidently send a valet to a block the car has left.
 */
async function reconcile({ now = new Date() } = {}) {
    const found = { backfilled: 0, drifted: 0, superseded: 0 };
    const dateKey = nyDateKey(now);

    // (a) A managed park with no open custody row.
    try {
        const parked = await Order.find({
            status: 'parked',
            orderType: 'parking',
            // Same rule as classify(): a park the plan did not pay for still
            // has no end time on the flat tiers, and is still a car we hold.
            // Filtering on coverage alone made this safety net blind to the
            // exact orders most likely to have been missed.
            $or: [
                { coveredBySubscription: { $exists: true, $ne: null } },
                { indefinite: true },
            ],
            'parkingLocation.lat': { $exists: true },
        })
            .sort({ updatedAt: -1 })
            .limit(200);

        for (const order of parked) {
            const existing = await CurbCustody.exists({
                currentOrder: order._id,
                closedAt: { $exists: false },
            });
            if (existing) continue;
            const custody = await arm({ order });
            if (!custody) continue;
            found.backfilled += 1;
            if (custody.alerts.backfilledOn !== dateKey) {
                custody.alerts.backfilledOn = dateKey;
                await custody.save();
                await operatorAlert.raise({
                    kind: 'custody_backfilled',
                    severity: operatorAlert.SEVERITY.WARN,
                    custody: custody._id,
                    order: order._id,
                    customer: custody.customer,
                    dateKey,
                    title: 'Started managing a car we were already holding',
                    detail:
                        `A ${custody.tier === 'home_garage' ? '$250' : '$300'} plan car at ` +
                        `${custody.spot.streetAddress || 'an unknown address'} had no management ` +
                        `record. It has one now. Worth checking why it was missed.`,
                    payload: { orderId: String(order._id), spot: custody.spot },
                });
            }
        }
    } catch (err) {
        console.error('curbCustody.reconcile backfill failed:', err.message);
    }

    // (b) A row pointing somewhere the car is not.
    try {
        const open = await CurbCustody.find({ closedAt: { $exists: false } }).limit(500);
        for (const custody of open) {
            const order = await Order.findById(custody.currentOrder)
                .select('status parkingLocation orderType')
                .lean();
            if (!order) continue;

            if (order.status === 'cancelled') {
                await close({ custody, reason: 'cancelled' });
                found.superseded += 1;
                continue;
            }

            // (c) A terminal order with nothing after it.
            //
            // Being 'completed' is NOT on its own a reason to close. A sweep
            // return completes normally and the car stays on the street — that
            // is the product — and custody hops onto the next order within
            // minutes. So only a row that has sat on a completed order for
            // hours, with nothing live for that customer, is a genuine leak.
            // And it is worth saying out loud rather than tidying away: if the
            // car really is still out there, closing this stops us moving it.
            if (order.status === 'completed') {
                const stale =
                    now.getTime() -
                        new Date(custody.spotSince || custody.openedAt).getTime() >
                    STALE_COMPLETED_MS;
                if (!stale) continue;
                const live = await Order.exists({
                    customer: custody.customer,
                    status: { $in: ['pending', 'accepted', 'in_progress', 'in-progress', 'parked'] },
                });
                if (live) continue;
                await close({ custody, reason: 'superseded' });
                found.superseded += 1;
                await operatorAlert.raise({
                    kind: 'custody_superseded',
                    severity: operatorAlert.SEVERITY.WARN,
                    custody: custody._id,
                    order: order._id,
                    customer: custody.customer,
                    dateKey,
                    title: 'Stopped managing a car whose order ended',
                    detail:
                        `The order for a car at ` +
                        `${custody.spot.streetAddress || 'an unknown address'} completed hours ` +
                        `ago with nothing after it, so management has stopped. If that car is ` +
                        `still on the street, it is no longer being moved.`,
                    payload: { custodyId: String(custody._id), orderId: String(order._id) },
                });
                continue;
            }

            const loc = order.parkingLocation;
            if (!loc || !finite(loc.lat) || !finite(loc.lng)) continue;
            if (!custody.spot || !finite(custody.spot.lat)) continue;
            const away = sweepWindows.haversineMeters(
                { lat: loc.lat, lng: loc.lng },
                { lat: custody.spot.lat, lng: custody.spot.lng }
            );
            if (away <= DRIFT_TOLERANCE_M) continue;

            const full = await Order.findById(custody.currentOrder);
            await arm({ order: full });
            found.drifted += 1;
            const fresh = await CurbCustody.findById(custody._id);
            if (fresh && fresh.alerts.driftedOn !== dateKey) {
                fresh.alerts.driftedOn = dateKey;
                await fresh.save();
                await operatorAlert.raise({
                    kind: 'custody_spot_drifted',
                    severity: operatorAlert.SEVERITY.PAGE,
                    custody: fresh._id,
                    order: order._id,
                    customer: fresh.customer,
                    dateKey,
                    title: 'A managed car was not where we thought it was',
                    detail:
                        `We had it ${Math.round(away)}m from where the order says it is. ` +
                        `Fixed, and the block is being read again — but a valet may have been ` +
                        `sent to the wrong place before this.`,
                    payload: {
                        orderId: String(order._id),
                        was: custody.spot,
                        now: { lat: loc.lat, lng: loc.lng, streetAddress: loc.streetAddress },
                    },
                });
            }
        }
    } catch (err) {
        console.error('curbCustody.reconcile drift failed:', err.message);
    }

    return found;
}

module.exports = {
    MANAGED_TIERS,
    NOTE_SPOT_TOLERANCE_M,
    DRIFT_TOLERANCE_M,
    STALE_COMPLETED_MS,
    isManagedTier,
    isSweepReturnLeg,
    takeKeys,
    giveKeysBack,
    stampKeysOnOrder,
    openFor,
    weHoldTheKeys,
    classify,
    arm,
    armSafely,
    resolveRules,
    enrichFromNote,
    refreshRules,
    setOperatorRules,
    close,
    closeSafely,
    handOff,
    reconcile,
};
