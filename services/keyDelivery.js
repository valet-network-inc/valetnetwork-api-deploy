/**
 * keyDelivery — the job that brings a customer their keys while the car stays
 * parked (keyDeliveryOnly). Shared by the release valve the customer taps
 * (custodyController.requestKeys) and, since Nov 11 2026, by the end of a
 * per-use park whose valet kept the keys: when its time is up the keys go
 * back on their own (curbSweepDispatcher.releaseExpired).
 */
const Order = require('../models/Order');
const User = require('../models/User');
const { emitToHousehold } = require('./accountLinks');
const { newHandoffCode: sixDigit, handoffCodesOn } = require('./handoffCode');

const OTP_EXPIRY_RETURN_KEY = 30 * 24 * 60 * 60 * 1000; // matches orderController

/**
 * Mint the delivery for `custody` (keys with the valet, nothing running).
 * `userId` is who asked: the owner, their linked partner, or the owner again
 * when the time ran out. `io` is the socket server, when there is one.
 */
async function mintKeyDelivery({ custody, userId, io = null }) {
    const keyOwner = String(custody.customer);
    const byPartner = !!userId && keyOwner !== String(userId);
    const req = { io };
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
                const { sendPushNotification } = require('../controllers/notificationController');
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

    return delivery;
}

module.exports = { mintKeyDelivery };
