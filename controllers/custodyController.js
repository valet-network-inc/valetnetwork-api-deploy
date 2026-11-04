/**
 * custodyController — what the customer can do about a car we are holding.
 *
 * On the $250 and $300 plans the valet keeps the keys after every park. That is
 * the only arrangement under which we can actually move the car before its block
 * is swept: the alternative needs the customer standing at the curb twice per
 * cleaning, which is the friction the plan exists to remove.
 *
 * Keeping somebody's car keys indefinitely is only reasonable if they can have
 * them back the moment they want them, without a phone call. That is this file.
 * `requestKeys` is the release valve, and it is deliberately one tap from the
 * home screen.
 */

const Order = require('../models/Order');
const User = require('../models/User');
const CurbCustody = require('../models/CurbCustody');
const curbCustody = require('../services/curbCustody');
const { partnerIdOf, emitToHousehold } = require('../services/accountLinks');

const OTP_EXPIRY_RETURN_KEY = 30 * 24 * 60 * 60 * 1000; // matches orderController

const { newHandoffCode: sixDigit, handoffCodesOn } = require('../services/handoffCode'); // 2 digits now (Nov 4 2026); the old name stays

/** Serialise the key state for the app. Never throws. */
async function keyStateFor(customerId) {
    const custody = await curbCustody.openFor(customerId);
    if (!custody) return null;

    let holderName = null;
    if (custody.keyHolder) {
        try {
            const v = await User.findById(custody.keyHolder)
                .select('firstName lastName')
                .lean();
            if (v) holderName = [v.firstName, v.lastName].filter(Boolean).join(' ').trim() || null;
        } catch (err) {
            // A missing name is cosmetic; the key state is not.
            console.error('keyStateFor: holder lookup failed:', err.message);
        }
    }

    const req = custody.keyRequest || {};
    const requestRunning = !!(req.requestedAt && !req.deliveredAt && !req.cancelledAt);

    return {
        custodyId: custody._id,
        with: custody.keysWith,
        holderName,
        canRequest: custody.keysWith === 'valet' && !requestRunning,
        requestedAt: requestRunning ? req.requestedAt : null,
        deliveryOrderId: requestRunning && req.deliveryOrder ? String(req.deliveryOrder) : null,
    };
}

/**
 * POST /api/custody/request-keys   { userId }
 *
 * Mints the job that brings the keys back. It is shaped as a retrieval so it
 * inherits dispatch, acceptance, chat and the OTP machinery unchanged — but
 * `keyDeliveryOnly` marks it as keys-only, because the car is NOT coming. It
 * stays parked exactly where it is and we go on moving it for street cleaning.
 *
 * The OTP is `return_key`, which is the direction that matters: the valet is
 * HANDING something over, so THE CUSTOMER READS THE CODE OUT and the valet
 * verifies it. Getting this backwards strands both of them at the curb.
 */
exports.requestKeys = async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({ success: false, message: 'userId is required' });
        }

        // Ownership gate, widened for the linked partner. A plan held by either
        // of a linked pair covers both, one park at a time, so the car we are
        // holding may be the one the OTHER of them booked — and either of them
        // may ask for its keys. Their own car first; the partner's only when
        // we hold none of theirs. From here on the car's owner is `keyOwner`:
        // the delivery is their job, on their park, with `actedBy` recording
        // who asked.
        let custody = await curbCustody.openFor(userId);
        if (!custody) {
            const partnerId = await partnerIdOf(userId);
            if (partnerId) custody = await curbCustody.openFor(partnerId);
        }
        if (!custody) {
            return res.status(409).json({
                success: false,
                message: 'We are not holding a car for you right now.',
            });
        }
        const keyOwner = String(custody.customer);
        const byPartner = keyOwner !== String(userId);
        if (custody.keysWith !== 'valet') {
            return res.status(409).json({
                success: false,
                message: 'You already have your keys.',
            });
        }

        const existing = custody.keyRequest || {};
        if (existing.requestedAt && !existing.deliveredAt && !existing.cancelledAt) {
            // Already on the way. Answering 409 rather than minting a second job
            // matters: two valets dispatched for one set of keys is a wasted fee
            // and a confusing pair of codes on the customer's screen.
            return res.status(409).json({
                success: false,
                message: 'Your keys are already on the way.',
                keys: await keyStateFor(keyOwner),
            });
        }

        const parkOrder = await Order.findById(custody.currentOrder).lean();
        // The car's owner: theirs is the name on the valet's push and job.
        const customer = await User.findById(keyOwner).select('firstName lastName firebaseUid').lean();

        const now = new Date();
        const delivery = new Order({
            customer: keyOwner,
            ...(byPartner ? { actedBy: userId } : {}),
            // Where the customer is, which is where the keys have to go — NOT
            // where the car is. This job never touches the car.
            customerLocation:
                (parkOrder && parkOrder.customerLocation) || {
                    lat: custody.spot.lat,
                    lng: custody.spot.lng,
                    streetAddress: custody.spot.streetAddress,
                },
            parkingLocation: custody.spot
                ? {
                      lat: custody.spot.lat,
                      lng: custody.spot.lng,
                      streetAddress: custody.spot.streetAddress,
                  }
                : undefined,
            parkingType: 'retrieval',
            orderType: 'retrieval',
            duration: 30,
            pickUpTime: now,
            paymentMethod: 'card',
            // Covered by the plan. Handing back keys we chose to keep is not a
            // service we can charge for.
            totalAmount: 0,
            paymentStatus: 'paid',
            serviceType: 'park-and-hold',
            // The plan that is holding this car, read off the custody row —
            // never looked up for whoever asked. Since accounts can be linked
            // that matters: the row was opened on the household's plan
            // (curbCustody.classify), which may be the partner's, and it stays
            // right after an unlink, when the asker may have no plan at all.
            coveredBySubscription: custody.subscription,
            keyDeliveryOnly: true,
            linkedOrderId: custody.currentOrder,
            vehicle: parkOrder ? parkOrder.vehicle : undefined,
            handoffCode: await handoffCodesOn(userId),
            status: 'pending',
            otp: {
                code: sixDigit(),
                createdAt: now,
                expiresAt: new Date(now.getTime() + OTP_EXPIRY_RETURN_KEY),
                verified: false,
                // The customer reads this one out.
                type: 'return_key',
            },
        });
        await delivery.save();

        custody.keyRequest = { requestedAt: now, deliveryOrder: delivery._id };
        await custody.save();

        // Prefer the valet actually holding the keys — nobody else can complete
        // this job. Fall back to the open board only if we have lost track of
        // who has them, which the watchdog also alarms on.
        try {
            if (custody.keyHolder) {
                const holder = await User.findById(custody.keyHolder)
                    .select('firebaseUid')
                    .lean();
                if (holder && holder.firebaseUid) {
                    const { sendPushNotification } = require('./notificationController');
                    const who =
                        [customer?.firstName, customer?.lastName].filter(Boolean).join(' ').trim() ||
                        'A customer';
                    await sendPushNotification(
                        holder.firebaseUid,
                        'Keys wanted back',
                        `${who} has asked for their keys. Take them over — the car stays parked.`,
                        { orderId: String(delivery._id), type: 'KEY_DELIVERY_REQUESTED' }
                    );
                }
            }
        } catch (err) {
            console.error('requestKeys: holder push failed:', err.message);
        }

        if (req.io) {
            req.io.emit('newOrder', delivery);
            if (custody.keyHolder) {
                req.io.to(String(custody.keyHolder)).emit('newOrder', delivery);
            }
            // The car's owner and, when linked, their partner — one of whom
            // just asked.
            await emitToHousehold(req.io, keyOwner, 'orderUpdated', delivery);
        }

        return res.json({
            success: true,
            order: delivery,
            keys: await keyStateFor(keyOwner),
            message: 'A valet is bringing your keys. Your car stays parked.',
        });
    } catch (err) {
        console.error('requestKeys error:', err);
        return res
            .status(500)
            .json({ success: false, message: err.message || 'Could not request your keys.' });
    }
};

/** GET /api/custody/mine/:userId — the key + car state the home screen renders. */
exports.getMine = async (req, res) => {
    try {
        const keys = await keyStateFor(req.params.userId);
        const custody = await curbCustody.openFor(req.params.userId);
        return res.json({
            success: true,
            keys,
            managed: custody
                ? {
                      active: true,
                      state: custody.state,
                      spotAddress: custody.spot && custody.spot.streetAddress,
                      blind: custody.rules && custody.rules.source === 'unknown',
                  }
                : null,
        });
    } catch (err) {
        console.error('getMine error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

exports.keyStateFor = keyStateFor;
