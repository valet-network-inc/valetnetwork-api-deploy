const dotenv = require('dotenv');
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });
const Order = require('../models/Order');
const User = require('../models/User');
const Event = require('../models/Event');
const subscriptionService = require('../services/subscriptionService');
const orderPricing = require('../services/orderPricing');
const axios = require('axios');
const stripeModule = require('stripe');
const stripe = process.env.STRIPE_API_KEY ? stripeModule(process.env.STRIPE_API_KEY) : null;

// OTP Expiry Constants (in milliseconds)
// const OTP_EXPIRY_ORDER_CREATION = 4 * 60 * 60 * 1000; // 4 hours
// const OTP_EXPIRY_RETURN_KEY = 4 * 60 * 60 * 1000; // 4 hours
// const OTP_EXPIRY_PARKING_LOCATION = 4 * 60 * 60 * 1000; // 4 hours

// Deposit taken when an away booking's price can't be known yet (the valet
// still has to read the sign). Charged at booking, credited against the
// final price. Stripe's USD minimum charge is $0.50, so $1 is the smallest
// round amount that always goes through.
const AWAY_DEPOSIT_CENTS = 100;

// A client quoting a different price than the server computed is either a
// stale app reading old prices or someone editing the request. Both want a
// human, so it goes to Slack when SLACK_WEBHOOK_URL is set. Fire-and-forget:
// alerting must never be able to fail a booking.
const notifyPriceMismatch = ({ customer, clientCents, serverCents, basis }) => {
    const url = process.env.SLACK_WEBHOOK_URL;
    if (!url) return;
    const money = (c) => `$${(c / 100).toFixed(2)}`;
    axios
        .post(url, {
            text:
                `:rotating_light: Price mismatch on createOrder — charged the server price.\n` +
                `customer \`${customer}\` · ${basis}\n` +
                `client said ${money(clientCents)}, server says ${money(serverCents)}`,
        })
        .catch((err) => console.error('Slack price-mismatch alert failed:', err.message));
};

const OTP_EXPIRY_ORDER_CREATION = 30 * 24 * 60 * 60 * 1000; // 30 days
const OTP_EXPIRY_RETURN_KEY = 30 * 24 * 60 * 60 * 1000; // 30 days
const OTP_EXPIRY_PARKING_LOCATION = 30 * 24 * 60 * 60 * 1000; // 30 days

// What a job is worth for valet pay. Subscription-covered orders charge the
// customer $0 but carry the per-use value in listPriceCents — the valet is
// paid from that, exactly as if the customer had paid per-use. Event-code
// free orders stay unpaid (unchanged behavior).
const valetPayBaseCents = (order) =>
    order.totalAmount > 0
        ? order.totalAmount
        : order.coveredBySubscription && order.listPriceCents > 0
        ? order.listPriceCents
        : 0;
exports.valetPayBaseCents = valetPayBaseCents;

// --- Retrieval lifecycle -----------------------------------------------------
//
// A retrieval order runs `pending` -> `accepted` -> `completed`. It never
// passes through `in-progress` (the valet app writes that only on parks), but
// both spellings are listed so a hand-edited or legacy order still counts as
// live rather than quietly allowing a duplicate dispatch.
const RETRIEVAL_LIVE_STATUSES = [
    'pending',
    'accepted',
    'in-progress',
    'in_progress',
];

// --- What still sits on a valet's plate --------------------------------------
//
// A valet can hold several jobs at once, so "am I busy" is a count, not a
// yes/no. `hasActiveOrder` (what the app lists) and `acceptOrder` (the
// concurrency cap) both read this one query so the two can never disagree
// about which orders count as open.
//
//   • 'accepted' / 'in_progress' — actively driving / on the job.
//   • 'parked' for non-Enterprise, but only until the valet closes the job out
//     with "Swipe to End Order" (`parkClosedAt`). Gating on the key-handoff
//     stamp instead took the order off their screen one step early and
//     stranded it with nobody able to move it.
//   • Enterprise dispatches: valet is free as soon as parking completes (front
//     desk holds keys), so 'parked' is excluded for Enterprise.
const valetActiveOrderQuery = (valetId) => ({
    valet: valetId,
    paymentStatus: 'paid',
    $or: [
        { status: { $in: ['accepted', 'in_progress', 'in-progress'] } },
        {
            status: 'parked',
            parkClosedAt: { $exists: false },
            $or: [
                { endCustomerName: { $exists: false } },
                { endCustomerName: '' },
                { endCustomerName: null },
            ],
        },
    ],
});

// Safety valve against one valet hoovering the whole board — not a queue depth
// we expect anyone to hit. Set VALET_MAX_ACTIVE_ORDERS to another number to
// widen it, or to 0 for no cap at all.
const valetMaxActiveOrders = () => {
    const parsed = Number.parseInt(process.env.VALET_MAX_ACTIVE_ORDERS ?? '5', 10);
    return Number.isFinite(parsed) ? parsed : 5;
};

/**
 * Has the retrieval valet physically taken the keys?
 *
 * The retrieval has two OTP beats (see `verifyOTP`): beat 1 is the valet
 * proving who they are and taking the keys, beat 2 is the customer claiming
 * the car back. Beat 1 stamps `otpVerifiedTimes.returnKey`, so that stamp is
 * the moment custody moves — and the moment "cancel" stops being a thing the
 * app can do on its own. Past it, someone is holding keys to a car and the
 * only correct move is to talk to them.
 *
 * Street-cleaning (ASP) legs are the exception that stamp nothing: the valet
 * kept the keys straight through the sweep, so `checkAspOrders` mints the
 * return leg pre-`accepted` with no beat 1 at all. Custody was never handed
 * back, so those are in-custody from birth. Read it off the leg itself when
 * it's flagged, and off the parent for legs minted before it was.
 */
/**
 * Record the keys-collected handoff on the chat document too.
 *
 * The valet's "return the key" button is gated on `parkHoldCollectVerified` in
 * the conversation, and until now the ONLY writer of that flag was the
 * customer's app, on a best-effort call whose errors are swallowed. When that
 * write didn't land — a missing conversation id, a dropped request — the order
 * verified fine on this side and the valet's button stayed grey forever, with
 * no error surfaced to anyone and no way to finish the job. Seen in production
 * 2026-08-11.
 *
 * The server knows the same fact at the same moment, so write it here. Clients
 * still write it (harmless, idempotent); this is the copy that can't go
 * missing. Best-effort by design: a chat-side failure must never fail an OTP
 * the customer just completed, but it IS logged rather than swallowed.
 */
const markCollectVerifiedOnConversation = async (order) => {
    const conversationId = order?.conversationId;
    if (!conversationId) {
        console.warn(
            'Collect OTP verified but order has no conversationId — the valet key button cannot unlock:',
            String(order?._id)
        );
        return;
    }
    try {
        const admin = require('firebase-admin');
        await admin
            .firestore()
            .collection('conversations')
            .doc(String(conversationId))
            .set(
                { parkHoldCollectVerified: true, collectOtpVerified: true },
                { merge: true }
            );
        console.log('Collect-verified flag written to conversation', conversationId);
    } catch (err) {
        console.error(
            'Failed to write collect-verified flag to conversation',
            conversationId,
            '-',
            err.message
        );
    }
};

const retrievalHasCustody = async (order) => {
    if (order?.orderType !== 'retrieval') return false;
    // Beat 1 stamps a different field depending on how the retrieval was born.
    // A LINKED one comes from `createRetrievalOrder`, whose OTP is minted
    // `type: 'return_key'` -> stamps `returnKey`. A STANDALONE $5 one comes
    // from `createOrder`, which always mints `type: 'order_creation'` ->
    // stamps `orderCreation`. Same physical moment, two field names; reading
    // only the first left every standalone retrieval cancellable (and fully
    // refundable) while the valet was already driving the car back.
    if (order?.otpVerifiedTimes?.returnKey) return true;
    if (order?.otpVerifiedTimes?.orderCreation) return true;
    if (order?.aspMode) return true;
    if (order?.linkedOrderId) {
        try {
            // Legacy sweep legs, minted before `aspMode` was stamped on the leg
            // itself. Match ONLY those: a customer who manually asks for their
            // car back from an ASP park creates an ordinary retrieval against
            // an ASP parent, and that one is theirs to cancel. The cron's leg is
            // the one the parent points back at and flagged when it made it.
            const parent = await Order.findById(order.linkedOrderId).select(
                'aspMode aspOrderCreated linkedOrderId'
            );
            if (
                parent?.aspMode &&
                parent?.aspOrderCreated &&
                String(parent.linkedOrderId || '') === String(order._id)
            ) {
                return true;
            }
        } catch (err) {
            console.error('Custody parent lookup failed:', err.message);
        }
    }
    return false;
};

/**
 * Put a parking order back the way it was before its retrieval was requested.
 *
 * A parked car is parked: the only status a cancelled retrieval can restore is
 * 'parked'. (Enterprise is the one flow that moves the park off it — to
 * 'completed' — when the retrieval starts, so that's what this undoes.)
 *
 * Returns the restored parking order, or null if there was nothing to restore.
 */
const restoreParkingAfterRetrievalCancel = async (retrievalOrder) => {
    if (retrievalOrder?.orderType !== 'retrieval' || !retrievalOrder?.linkedOrderId) {
        return null;
    }
    try {
        const parking = await Order.findById(retrievalOrder.linkedOrderId);
        if (!parking) return null;

        // Don't resurrect a park the customer already closed out some other
        // way (completed via the valet, cancelled, etc.).
        if (['cancelled', 'completed'].includes(parking.status)) {
            const stillLinked = String(parking.linkedOrderId || '') ===
                String(retrievalOrder._id);
            // Enterprise flips the park to 'completed' when retrieval starts,
            // so a completed-and-still-linked park IS ours to restore.
            if (!(parking.status === 'completed' && stillLinked)) {
                await Order.findByIdAndUpdate(parking._id, {
                    $unset: { linkedOrderId: '' },
                });
                return null;
            }
        }

        const restored = await Order.findByIdAndUpdate(
            parking._id,
            {
                status: 'parked',
                $unset: { linkedOrderId: '' },
            },
            { new: true }
        );
        console.log(
            'Restored parking order',
            parking._id.toString(),
            'to parked after retrieval cancel'
        );
        return restored;
    } catch (err) {
        console.error(
            'Failed to restore parking order after retrieval cancel:',
            err.message
        );
        return null;
    }
};

exports.createOrder = async (req, res) => {
    const {
        customer,
        customerLocation,
        parkingType,
        duration,
        pickUpTime,
        paymentMethod,
        totalAmount,
        orderType,
        paymentIntentId,
        eventCode,
        isFreeService,
        serviceType,
        aspMode,
        carWatch, // Car Watch add-on ($1/hr) — valet keeps eyes on the parked car
        carWatchAmount, // Car Watch portion of totalAmount, in cents
        endCustomerName,
        endCustomerPhone,
        vehicle, // { licensePlate, color?, model?, keyTagNumber? } — optional at create time
        awayMode, // multi-day hold: keys collected once, returned at awayEndTime
        awayDays, // street-cleaning slots to move the car for while away
        awayEndTime, // when the customer is back — becomes asp_time (the auto-return moment)
        awayService, // 'moves' (per-move, reconciled on schedule set) | 'hold' (per-day, paid up front)
    } = req.body;

    try {
        console.log('Creating order with data:', {
            customer,
            customerLocation,
            parkingType,
            duration,
            pickUpTime,
            paymentMethod,
            totalAmount,
            orderType,
            paymentIntentId,
            eventCode,
            isFreeService,
            serviceType,
            endCustomerName,
            endCustomerPhone,
        });

        // Enterprise (doorman) accounts are allowed to have multiple concurrent orders
        // because each order is for a different end-customer. Skip the active-order check for them.
        const customerDoc = await User.findById(customer).select('isDoorman phone');
        const isEnterpriseCustomer = !!customerDoc?.isDoorman;

        if (!isEnterpriseCustomer) {
            // A booking scheduled well into the future (advance ASP move,
            // away-mode start) must not lock the customer out of parking
            // today — only orders that are live now, or starting within 6
            // hours, block a new one.
            const soonCutoff = new Date(Date.now() + 6 * 60 * 60 * 1000);
            const activeOrder = await Order.findOne({
                customer,
                paymentStatus: 'paid',
                $or: [
                    { status: { $in: ['accepted', 'in_progress', 'parked'] } },
                    { status: 'pending', pickUpTime: { $lte: soonCutoff } },
                ],
            });

            if (activeOrder) {
                console.log('Customer already has an active order:', activeOrder._id);
                return res.status(400).json({
                    success: false,
                    message: 'Customer already has an active order. Please complete or cancel the existing order before creating a new one.',
                    existingOrderId: activeOrder._id,
                });
            }
        }

        const subscription = req.subscription || null;
        let isEventValid = false;
        let validatedEvent = null;
        // Free service is decided here, never by the caller. This used to read
        // `isFreeService || false`, so a client could post `isFreeService: true`
        // and zero its own order — no event code, no subscription, no auth. A
        // valid event code below is the only thing that turns it on.
        let finalIsFreeService = false;
        let finalServiceType = serviceType || 'standard';

        // Validate event code if provided
        if (eventCode) {
            console.log('Validating event code:', eventCode);
            validatedEvent = await Event.findOne({ 
                code: eventCode.toUpperCase(),
                isActive: true 
            });

            if (validatedEvent && validatedEvent.isValid()) {
                // Some codes are issued to named people (e.g. an outage make-good)
                // rather than to a venue. When allowedPhones is set, only those
                // numbers may redeem it; an empty/absent list means unrestricted,
                // which is how every pre-existing event code keeps working.
                const allowed = validatedEvent.allowedPhones || [];
                if (allowed.length > 0) {
                    const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
                    const callerPhone = last10(customerDoc?.phone);
                    const permitted = allowed.some((p) => last10(p) === callerPhone && callerPhone.length === 10);
                    if (!permitted) {
                        console.log('Event code', validatedEvent.code, 'refused for phone', callerPhone || '(none)');
                        return res.status(400).json({
                            success: false,
                            message: 'This code is not valid for your account.',
                        });
                    }
                }

                isEventValid = true;
                finalIsFreeService = true;
                finalServiceType = serviceType || validatedEvent.serviceType || 'standard';
                console.log('Event code validated successfully:', validatedEvent.name);
            } else {
                console.log('Invalid or expired event code:', eventCode);
                return res.status(400).json({
                    success: false,
                    message: 'Invalid or expired event code',
                });
            }
        }

        // Determine final amount based on subscription coverage, event code,
        // or regular pricing.
        //
        // The price is computed here from the customer's choices. It used to be
        // `totalAmount || 0` — whatever the app posted went to Stripe verbatim,
        // so an unauthenticated caller could park for 50 cents, and the same
        // field feeds valetPayBaseCents, so an inflated one paid a valet 70% of
        // an invented number. The client's figure is now only checked against
        // ours, never charged.
        const quote = await orderPricing.priceOrderCents({
            orderType,
            serviceType: finalServiceType,
            aspMode,
            carWatch,
            duration,
            awayMode,
            awayService,
            awayDays,
            pickUpTime,
            awayEndTime,
        });

        let finalAmount = quote.amountCents;
        const quotedByClient = Number.isFinite(Number(totalAmount))
            ? Math.round(Number(totalAmount))
            : null;

        // A mismatch means the customer saw a different number than we are
        // about to charge. We charge ours, and say so loudly — a stale app
        // reading old prices and a tampered request look identical from here,
        // and both want a human.
        if (quotedByClient !== null && quotedByClient !== finalAmount) {
            console.warn('PRICE MISMATCH — charging server price', {
                customer,
                clientCents: quotedByClient,
                serverCents: finalAmount,
                basis: quote.basis,
                orderType: orderType || 'parking',
                serviceType: finalServiceType,
                aspMode: !!aspMode,
                carWatch: !!carWatch,
                duration,
            });
            notifyPriceMismatch({
                customer,
                clientCents: quotedByClient,
                serverCents: finalAmount,
                basis: quote.basis,
            });
        }

        let paymentStatus = 'pending';
        let coverage = { covered: false };

        // Subscription coverage applies to parking orders only (retrieval
        // legs are priced by createRetrievalOrder), never stacks on an event
        // code, and never covers an order carrying the Car Watch add-on —
        // zeroing the order would hand out the paid add-on too, so those
        // bookings charge normally and the free park stays available.
        // Away-mode input checks: the return moment is load-bearing (it
        // becomes asp_time, which drives the auto-return), so reject
        // nonsense before anything is saved.
        if (awayMode) {
            const start = new Date(pickUpTime).getTime();
            const end = new Date(awayEndTime || 0).getTime();
            if (!Number.isFinite(end) || end <= start + 2 * 60 * 60 * 1000) {
                return res.status(400).json({
                    success: false,
                    message: 'awayEndTime must be at least 2 hours after pickUpTime',
                });
            }
            if (end - start > 30 * 24 * 60 * 60 * 1000) {
                return res.status(400).json({
                    success: false,
                    message: 'Away mode is capped at 30 days',
                });
            }
            for (const d of awayDays || []) {
                if (
                    !d ||
                    !Number.isInteger(d.weekday) || d.weekday < 0 || d.weekday > 6 ||
                    !Number.isInteger(d.hour) || d.hour < 0 || d.hour > 23 ||
                    !Number.isInteger(d.minute) || d.minute < 0 || d.minute > 59
                ) {
                    return res.status(400).json({
                        success: false,
                        message: 'each away day needs weekday 0-6, hour 0-23, minute 0-59',
                    });
                }
            }
        }

        // Away orders are priced per-move/per-day and are never covered by a
        // subscription (the weekly-cap math is meaningless across a
        // multi-week hold).
        if (
            subscription &&
            !finalIsFreeService &&
            !carWatch &&
            !awayMode &&
            (orderType || 'parking') === 'parking'
        ) {
            coverage = await subscriptionService.evaluateParkCoverage(subscription, {
                aspMode: !!aspMode,
                lat: customerLocation && customerLocation.lat,
                lng: customerLocation && customerLocation.lng,
                // Server-priced: the recorded per-use value must not come
                // from the client's totalAmount (it feeds the valet's pay and
                // the value indicator).
                listPriceCents: await subscriptionService.parkListPriceCents({
                    aspMode: !!aspMode,
                    serviceType: finalServiceType,
                }),
            });
            console.log('Subscription coverage decision:', coverage.reason);
        }

        console.log('Payment determination:', {
            covered: coverage.covered,
            finalIsFreeService,
            paymentIntentId,
            totalAmount,
        });

        // Away "moves" bookings with no schedule yet take a $1 deposit now
        // and the balance once the valet reads the sign and sets the days.
        // The deposit is what makes the later charge safe: it proves the
        // card works and — via createPaymentIntent's setup_future_usage —
        // saves it for the off-session balance. It counts toward the final
        // price, so one move is $15 total ($1 now, $14 then).
        // Server-enforced: whatever amount the client sent is discarded.
        const awayBillLater =
            awayMode &&
            awayService === 'moves' &&
            (!awayDays || awayDays.length === 0) &&
            !finalIsFreeService;

        if (awayBillLater) {
            finalAmount = AWAY_DEPOSIT_CENTS;
            paymentStatus = 'pending'; // the normal PaymentIntent flow charges it
            console.log('Away order with no schedule — $1 deposit now, balance when the valet sets it');
        } else if (coverage.covered || finalIsFreeService) {
            finalAmount = 0;
            paymentStatus = 'paid';
            console.log('Setting as paid due to subscription coverage or free service');
        } else if (paymentIntentId) {
            // Payment intent exists, mark as pending until confirmed
            paymentStatus = 'pending';
            console.log('Setting as pending due to payment intent');
        } else {
            // No payment info provided yet - keep the totalAmount if provided
            paymentStatus = 'pending';
            console.log('Setting as pending - no payment intent provided, amount:', finalAmount);
        }
        
        // Generate OTP for order verification (6-digit code)
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const otpCreatedAt = new Date();
        const otpExpiresAt = new Date(otpCreatedAt.getTime() + OTP_EXPIRY_ORDER_CREATION);

        // asp_time is "when the car comes back automatically": for a normal
        // street-cleaning move that's pickup + 1.5h; for away mode it's the
        // day the customer returns.
        const pickupTimeMs = new Date(pickUpTime).getTime();
        const aspTime = awayMode
            ? new Date(awayEndTime)
            : aspMode
            ? new Date(pickupTimeMs + 1.5 * 60 * 60 * 1000)
            : null;

        const orderData = {
            customer,
            customerLocation,
            parkingType,
            duration,
            pickUpTime,
            paymentMethod: paymentMethod || 'card',
            totalAmount: finalAmount,
            status: 'pending',
            paymentStatus: paymentStatus,
            orderType: orderType || 'parking',
            // Never attach a PaymentIntent to a $0 order: cancel paths issue
            // full refunds against order.paymentIntentId without verifying it
            // ever charged for THIS order, so an attacker-supplied (or stray)
            // intent on a covered/free order becomes someone's refund.
            paymentIntentId:
                coverage.covered || finalIsFreeService
                    ? undefined
                    : paymentIntentId || undefined,
            eventCode: eventCode ? eventCode.toUpperCase() : undefined,
            isFreeService: finalIsFreeService,
            serviceType: finalServiceType,
            carWatch: !!carWatch,
            // Server-derived, like totalAmount: the client's carWatchAmount is
            // part of the same money record and was equally unchecked.
            carWatchAmount: quote.carWatchCents,
            // Away orders ride the aspMode machinery (sweep reminders +
            // auto-return at asp_time) whatever service was picked.
            aspMode: awayMode ? true : aspMode || false,
            asp_time: aspTime,
            ...(awayMode
                ? {
                      awayMode: true,
                      awayService: awayService === 'hold' ? 'hold' : 'moves',
                      awayDays: (awayDays || []).map(({ weekday, hour, minute }) => ({
                          weekday,
                          hour,
                          minute,
                      })),
                      // What the booking charge covers (the $1 deposit for
                      // bill-later, the full price otherwise). The reconciler
                      // credits it against the final price. Safe to stamp
                      // before the charge confirms: reconciliation only runs
                      // on orders that reached paymentStatus 'paid'.
                      awayPaidCents: finalAmount,
                      ...(awayBillLater
                          ? { awayBilling: { status: 'pending_schedule', at: new Date() } }
                          : {}),
                  }
                : {}),
            // Subscription coverage stamp: which plan paid, and what the
            // order would have cost per-use (the value indicator's usage side).
            ...(coverage.covered
                ? {
                      coveredBySubscription: subscription._id,
                      listPriceCents: coverage.listPriceCents || totalAmount || 0,
                  }
                : {}),
            // Enterprise-only end-customer details (shown to valet instead of the enterprise's own name)
            ...(endCustomerName ? { endCustomerName } : {}),
            ...(endCustomerPhone ? { endCustomerPhone } : {}),
            // Vehicle info — license plate at minimum, captured at summon time
            // for Enterprise. Color/model/keyTagNumber may be filled in later
            // by the valet via the existing /addVehicleInfo endpoint.
            ...(vehicle && (vehicle.licensePlate || vehicle.color || vehicle.model)
                ? {
                      vehicle: {
                          ...(vehicle.licensePlate
                              ? { licensePlate: String(vehicle.licensePlate).trim().toUpperCase() }
                              : {}),
                          ...(vehicle.color ? { color: vehicle.color } : {}),
                          ...(vehicle.model ? { model: vehicle.model } : {}),
                          ...(vehicle.keyTagNumber
                              ? { keyTagNumber: vehicle.keyTagNumber }
                              : {}),
                      },
                  }
                : {}),
            otp: {
                code: otpCode,
                createdAt: otpCreatedAt,
                expiresAt: otpExpiresAt,
                verified: false,
                type: 'order_creation',
            },
        };

        console.log('Order data to save:', orderData);
        
        const order = new Order(orderData);
        await order.save();
        
        console.log('Order saved successfully:', order._id);

        // Increment event usage if event code was used
        if (isEventValid && validatedEvent) {
            try {
                await validatedEvent.incrementUsage();
                console.log('Event usage incremented for:', validatedEvent.code);
            } catch (eventError) {
                console.error('Failed to increment event usage:', eventError);
                // Don't fail the order creation if event increment fails
            }
        }

        if (coverage.covered) {
            // Emit socket events and return response
            req.io.emit('newOrder', order);
            req.io.to(customer).emit('orderUpdated', order);

            return res.status(201).json({
                success: true,
                message: 'Order covered by subscription',
                coveredBySubscription: true,
                order,
            });
        }

        if (finalIsFreeService) {
            // Emit socket events and return response for free service
            req.io.emit('newOrder', order);
            req.io.to(customer).emit('orderUpdated', order);

            return res.status(201).json({
                success: true,
                message: 'Order created with event code discount',
                order,
            });
        }

        req.io.emit('newOrder', order);

        res.status(200).json({
            success: true,
            message: 'Order created successfully',
            order,
        });
    } catch (err) {
        console.error('Order creation error:', err);
        
        // Handle validation errors specifically
        if (err.name === 'ValidationError') {
            const validationErrors = Object.keys(err.errors).map(key => ({
                field: key,
                message: err.errors[key].message,
                value: err.errors[key].value
            }));
            console.error('Validation errors:', validationErrors);
            
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: validationErrors,
            });
        }
        
        res.status(500).json({
            success: false,
            message: err.message || 'Failed to create order',
            error: err.name,
            stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
    }
};

exports.getPendingOrders = async (req, res) => {
    try {
        const orders = await Order.find({ status: 'pending', paymentStatus: 'paid' });

        res.status(200).json({
            success: true,
            message: 'Orders fetched successfully',
            orders,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch orders',
        });
    }
};

exports.acceptOrder = async (req, res) => {
    const { orderId, valetId, valetLocation, conversationId } = req.body;

    try {
        // Check if valet is deleted
        const valet = await User.findById(valetId);
        if (!valet) {
            return res.status(404).json({
                success: false,
                message: 'Valet not found',
            });
        }
        if (valet.isDeleted) {
            return res.status(403).json({
                success: false,
                message: 'This valet account has been deleted and cannot accept orders.',
            });
        }
        // Onboarding gate (v1.2.0): only valets who have passed Certn AND
        // have their DL on file AND been authorized by an admin can accept
        // jobs. NOTE: requires the v1.2.0 migration script to have run so
        // existing pre-v1.2.0 valets are stamped as 'active' before deploy.
        if (valet.valetOnboardingStatus && valet.valetOnboardingStatus !== 'active') {
            return res.status(403).json({
                success: false,
                message: 'Valet has not completed onboarding and cannot accept orders.',
                onboardingStatus: valet.valetOnboardingStatus,
            });
        }

        // Concurrency cap. A valet holding other live jobs is fine — that's the
        // point — but past the cap they're told to close one out first. The
        // accepted order itself is excluded so a retry after a flaky response
        // can't count the same job twice.
        const maxActive = valetMaxActiveOrders();
        if (maxActive > 0) {
            const openJobs = await Order.countDocuments({
                ...valetActiveOrderQuery(valetId),
                _id: { $ne: orderId },
            });

            if (openJobs >= maxActive) {
                return res.status(409).json({
                    success: false,
                    code: 'VALET_AT_CAPACITY',
                    message: `You already have ${openJobs} jobs open. Finish one before taking another.`,
                    openJobs,
                    maxActiveOrders: maxActive,
                });
            }
        }

        const acceptedAt = new Date();

        // Get order to calculate pickup distance
        const existingOrder = await Order.findById(orderId);
        if (!existingOrder) {
            return res.status(404).json({
                success: false,
                message: 'Order not found',
            });
        }

        // Calculate pickup distance (Haversine formula for accurate distance in meters)
        let pickupDistance = null;
        if (valetLocation && valetLocation.lat && valetLocation.lng && 
            existingOrder.customerLocation && existingOrder.customerLocation.lat && existingOrder.customerLocation.lng) {
            
            const R = 6371e3; // Earth's radius in meters
            const φ1 = valetLocation.lat * Math.PI / 180;
            const φ2 = existingOrder.customerLocation.lat * Math.PI / 180;
            const Δφ = (existingOrder.customerLocation.lat - valetLocation.lat) * Math.PI / 180;
            const Δλ = (existingOrder.customerLocation.lng - valetLocation.lng) * Math.PI / 180;

            const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
                      Math.cos(φ1) * Math.cos(φ2) *
                      Math.sin(Δλ/2) * Math.sin(Δλ/2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

            pickupDistance = Math.round(R * c); // Distance in meters
        }

        const order = await Order.findOneAndUpdate(
            {
                _id: orderId,
                status: 'pending',
                $or: [{ valet: { $exists: false } }, { valet: null }],
            },
            {
                $set: {
                    status: 'accepted',
                    valet: valetId,
                    valetLocation: valetLocation,
                    conversationId: conversationId,
                    acceptanceLocation: valetLocation,
                    pickupDistance: pickupDistance,
                    acceptedAt: acceptedAt,
                    'notifiedValets.$[elem].accepted': true,
                    'notifiedValets.$[elem].acceptedAt': acceptedAt,
                },
            },
            { 
                new: true,
                arrayFilters: [{ 'elem.valet': valetId }]
            }
        );

        if (!order) {
            const existingOrder = await Order.findById(orderId).select(
                'status valet customer'
            );

            if (!existingOrder) {
                return res.status(404).json({
                    success: false,
                    message: 'Order not found',
                });
            }

            // Be specific about why the order can't be accepted
            const statusMessage =
                existingOrder.status === 'cancelled'
                    ? 'This request has been cancelled by the customer'
                    : 'This request is no longer available';

            return res.status(409).json({
                success: false,
                message: statusMessage,
                order: existingOrder,
            });
        }

        // Check if this order has a linked order (retrieval order linked to parking order)
        if (order.linkedOrderId) {
            const linkedOrder = await Order.findById(order.linkedOrderId).select('valet');
            
            if (linkedOrder && linkedOrder.valet) {
                const linkedOrderValet = linkedOrder.valet.toString();
                const acceptingValet = valetId.toString();
                
                // If the valets are different, notify the original valet to hand over keys
                if (linkedOrderValet !== acceptingValet) {
                    const notificationMessage = `The car you parked has been assigned to another valet. Please hand over the keys to them.`;
                    
                    req.io.to(linkedOrderValet).emit('keyHandoverNotification', {
                        orderId: order._id,
                        linkedOrderId: order.linkedOrderId,
                        message: notificationMessage,
                        newValetId: acceptingValet,
                        type: 'KEY_HANDOVER_REQUEST',
                    });
                    
                    console.log(`Key handover notification sent to valet ${linkedOrderValet} for order ${order._id}`);
                }
            }
        }

        // Removed 2026-08-06: this broadcast went to EVERY connected socket,
        // including browsers. The room-targeted emits directly below deliver the
        // same payload to the only two parties that act on it, and the clients
        // ignore updates for orders that are not their own. Keeping it meant
        // handing every listener the full order document.
        req.io.to(order.customer).emit('orderUpdated', order);
        req.io.to(valetId).emit('orderUpdated', order);

        res.status(200).json({
            success: true,
            message: 'Order accepted successfully',
            order,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Failed to accept order',
        });
    }
};

exports.hasActiveOrder = async (req, res) => {
    const { userId, isValet } = req.query;

    try {
        // Valet's "active" set is `valetActiveOrderQuery` — see the comment on
        // it. A valet can hold several of these at once.
        const valetSide = isValet === 'true';
        const query = valetSide
            ? valetActiveOrderQuery(userId)
            : {
                  customer: userId,
                  status: {
                      $in: ['pending', 'accepted', 'in_progress', 'parked'],
                  },
                  paymentStatus: 'paid',
                  // A park the valet has closed out is NOT "in flight" to
                  // this endpoint, and never has been: it used to sit on a
                  // status this query didn't list, so the customer app
                  // learned to find it in the orders list instead and shows
                  // it as the keys-held ticket. Keep that shape. Answering
                  // with it here hands shipped builds a case they have
                  // never seen from this endpoint, and their home screen
                  // renders the keys-held ticket for a frame and then
                  // replaces it with the generic in-progress one.
                  parkClosedAt: { $exists: false },
              };

        // Valets get the whole set; customers are still held to one order at a
        // time by `createOrder`, so that side keeps its single-document read.
        //
        // `activeOrder` stays on the payload and is the oldest of the set:
        // builds already on phones only ever expected one order here, and
        // oldest-first means the job they see doesn't jump the moment a newer
        // one is accepted.
        const activeOrders = valetSide
            ? await Order.find(query).sort({ acceptedAt: 1, createdAt: 1 })
            : [await Order.findOne(query)].filter(Boolean);

        res.status(200).json({
            success: true,
            hasActiveOrder: activeOrders.length > 0,
            activeOrder: activeOrders[0] || null,
            activeOrders,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Failed to check active order status',
        });
    }
};

exports.updateValetLocation = async (req, res) => {
    const { orderId, valetLocation } = req.body;

    try {
        const order = await Order.findByIdAndUpdate(
            orderId,
            { valetLocation },
            { new: true }
        );

        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found',
            });
        }

        // Emit to both customer and valet rooms
        if (order.customer) {
            req.io.to(order.customer.toString()).emit('orderUpdated', {
                type: 'LOCATION_UPDATE',
                order,
            });
        }
        if (order.valet) {
            req.io.to(order.valet.toString()).emit('orderUpdated', {
                type: 'LOCATION_UPDATE',
                order,
            });

            // Remind the valet's app where the car is parked.
            //
            // The app holds the parked spot in session state only, so after a
            // cold start it doesn't know the job it is carrying is already
            // parked — and the control for recording a move is drawn off that
            // state. On an away / street-cleaning job the move happens hours or
            // days after the park, long after the app was last killed, which
            // left the valet with no way to say where the car went. Riding
            // along with the location ping the app already sends puts the spot
            // back within a couple of seconds, on the build already installed.
            if (order.status === 'parked' && order.parkingLocation) {
                req.io.to(order.valet.toString()).emit('orderUpdated', {
                    type: 'PARKING_LOCATION_UPDATE',
                    order,
                });
            }
        }

        res.status(200).json({
            success: true,
            message: 'Valet location updated successfully',
            order,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Failed to update valet location',
        });
    }
};

exports.updateOrder = async (req, res) => {
    const { orderId, updates, otp } = req.body;

    try {
        // "The valet closed this park out."
        //
        // Two spellings reach us. Clients on the shipped build say it by
        // sending the retired 'parked-with-keys' (the schema setter folds the
        // value itself down to 'parked', which would otherwise lose the fact
        // that the swipe happened). Newer clients say it outright with
        // `parkClosed`. Either way it stamps the same field, which is what
        // takes the job off the valet's screen.
        if (updates && (updates.status === 'parked-with-keys' || updates.parkClosed)) {
            updates.status = 'parked';
            updates.parkClosedAt = new Date();
            delete updates.parkClosed;
        }

        // Check if vehicle info is required for parking/completion operations
        const requiresVehicle = ['parked', 'completed'].includes(updates.status);
        
        if (requiresVehicle) {
            const existingOrder = await Order.findById(orderId);
            if (!existingOrder) {
                return res.status(404).json({
                    success: false,
                    message: 'Order not found',
                });
            }
            
            // Skip vehicle requirement check for retrieval orders
            if (existingOrder.orderType !== 'retrieval') {
                // Check if vehicle info exists and is complete
                const hasVehicleInfo = existingOrder.vehicle && 
                    existingOrder.vehicle.color && 
                    existingOrder.vehicle.model && 
                    existingOrder.vehicle.licensePlate;
                    
                if (!hasVehicleInfo) {
                    return res.status(400).json({
                        success: false,
                        message: 'Vehicle information is required before parking or completing an order',
                        requiresVehicle: true,
                    });
                }
            }

            // If completing order, check OTP verification
            if (updates.status === 'completed-old') {
                const otpData = existingOrder.otp;
                
                // If OTP is not verified, require OTP in request
                if (!otpData || !otpData.verified) {
                    if (!otp) {
                        return res.status(400).json({
                            success: false,
                            message: 'OTP is required to complete the order. Please verify OTP first.',
                        });
                    }

                    if (!otpData || !otpData.code) {
                        return res.status(400).json({
                            success: false,
                            message: 'No OTP found for this order. Please update parking location first.',
                        });
                    }

                    // Check if OTP is expired - regenerate if needed
                    if (new Date() > otpData.expiresAt) {
                        // Regenerate OTP
                        const newOtpCode = Math.floor(100000 + Math.random() * 900000).toString();
                        const newOtpCreatedAt = new Date();
                        const newOtpExpiresAt = new Date(newOtpCreatedAt.getTime() + OTP_EXPIRY_ORDER_CREATION);
                        
                        await Order.findByIdAndUpdate(orderId, {
                            'otp.code': newOtpCode,
                            'otp.createdAt': newOtpCreatedAt,
                            'otp.expiresAt': newOtpExpiresAt,
                            'otp.verified': false,
                        });
                        
                        return res.status(400).json({
                            success: false,
                            message: 'OTP has expired. A new OTP has been generated and sent.',
                            otpRegenerated: true,
                        });
                    }

                    // Verify OTP code
                    if (otpData.code !== otp.toString()) {
                        return res.status(400).json({
                            success: false,
                            message: 'Invalid OTP. Please try again.',
                        });
                    }

                    // Mark OTP as verified
                    updates.otp = {
                        ...otpData,
                        verified: true,
                    };
                }
            }
        }
        
        // If updates include review, allow updating the review field
        const updateObj = { ...updates };
        if (updates.review) {
            updateObj.review = updates.review;
        }

        // If parking location is being updated, generate the return-key OTP.
        //
        // A parked car can be moved again — street cleaning on an away job, a
        // garage that shut, a spot that turned out to be a hydrant — and each
        // move comes back through here. Only the FIRST park is a park: a move
        // must not mint a new code (the customer is already holding one), must
        // not flip a verified handoff back to unverified, and must not restamp
        // `parkedAt`, which the admin metrics read as "accepted → parked".
        if (updates.parkingLocation) {
            const existingOrder = await Order.findById(orderId);
            const existingOtp = existingOrder && existingOrder.otp;
            const hasLiveReturnKeyOtp =
                existingOtp &&
                existingOtp.code &&
                existingOtp.type === 'return_key' &&
                (existingOtp.verified ||
                    (existingOtp.expiresAt && new Date(existingOtp.expiresAt) > new Date()));

            if (!hasLiveReturnKeyOtp) {
                // Generate new OTP (6-digit code)
                const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
                const otpCreatedAt = new Date();
                const otpExpiresAt = new Date(otpCreatedAt.getTime() + OTP_EXPIRY_PARKING_LOCATION);

                updateObj.otp = {
                    code: otpCode,
                    createdAt: otpCreatedAt,
                    expiresAt: otpExpiresAt,
                    verified: false,
                    type: 'return_key',
                };
            }

            // Store parkedAt timestamp the first time the car is parked.
            if (!existingOrder || !existingOrder.parkedAt) {
                updateObj.parkedAt = new Date();
            }
        }

        const order = await Order.findByIdAndUpdate(orderId, updateObj, {
            new: true,
        }).populate('customer', 'firstName lastName email phone')
          .populate('valet', 'firstName lastName email phone');

        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found',
            });
        }

        // If completing a retrieval order, update the linked parking order
        // AND credit the parking valet for their share. The credit hook
        // below only fires for the order that was directly updated; the
        // linked parking is updated via a separate findByIdAndUpdate so we
        // have to run the credit logic explicitly here.
        if (order.orderType === 'retrieval' && updates.status === 'completed' && order.linkedOrderId) {
            try {
                const linkedParking = await Order.findById(order.linkedOrderId);
                if (
                    linkedParking &&
                    !linkedParking.creditedValet &&
                    linkedParking.valet &&
                    valetPayBaseCents(linkedParking) > 0
                ) {
                    const VALET_CUT = 0.7;
                    const parkingValetId =
                        typeof linkedParking.valet === 'object'
                            ? linkedParking.valet._id
                            : linkedParking.valet;
                    // Park-and-retrieve: parking is $10 of the $13 total.
                    // The other $3 is for retrieval (credited separately
                    // when the retrieval order's own credit hook fires).
                    const linkedPayBase = valetPayBaseCents(linkedParking);
                    const parkingPortion =
                        linkedParking.serviceType === 'park-and-hold'
                            ? Math.max(0, linkedPayBase - 300)
                            : linkedPayBase;
                    const valetCutCents = Math.floor(parkingPortion * VALET_CUT);
                    await User.findByIdAndUpdate(parkingValetId, {
                        $inc: {
                            currentBalance: valetCutCents,
                            totalEarnings: valetCutCents,
                        },
                    });
                    await Order.findByIdAndUpdate(linkedParking._id, {
                        status: 'completed',
                        creditedValet: true,
                    });
                    console.log(
                        'Credited linked parking valet',
                        parkingValetId.toString(),
                        'with',
                        valetCutCents,
                        'cents (parking portion of park-and-retrieve)'
                    );
                } else {
                    await Order.findByIdAndUpdate(order.linkedOrderId, {
                        status: 'completed',
                    });
                }
            } catch (linkedErr) {
                console.error(
                    'Failed to credit linked parking valet on retrieval completion:',
                    linkedErr.message
                );
                // Best-effort: still mark the parking as completed
                try {
                    await Order.findByIdAndUpdate(order.linkedOrderId, {
                        status: 'completed',
                    });
                } catch {}
            }
            console.log('Updated original order status to completed:', order.linkedOrderId);
        }

        // Park-and-hold special case: credit the parking valet IMMEDIATELY
        // when their leg is done (status becomes 'parked'), not later when
        // retrieval completes. Reasons:
        //   - Customer might wait days before requesting retrieval; the valet
        //     would otherwise sit with no visible earnings for the parking they
        //     already did.
        //   - Different valet might do the retrieval. The original parking
        //     valet's credit shouldn't depend on what the retrieval valet does.
        //
        // Sets creditedValet=true so the retrieval-complete linked-credit hook
        // (above) skips this order. Retrieval valet gets their $3 portion
        // separately when their own retrieval order hits 'completed' (below).
        const PARK_AND_HOLD_RETRIEVAL_CENTS = 300;
        if (
            !order.creditedValet &&
            order.valet &&
            valetPayBaseCents(order) > 0 &&
            order.serviceType === 'park-and-hold' &&
            order.orderType === 'parking' &&
            ['parked'].includes(updates.status)
        ) {
            const VALET_CUT = 0.7;
            const parkingPortion = Math.max(
                0,
                valetPayBaseCents(order) - PARK_AND_HOLD_RETRIEVAL_CENTS
            );
            const valetCutCents = Math.floor(parkingPortion * VALET_CUT);
            const valetId =
                typeof order.valet === 'object' ? order.valet._id : order.valet;
            try {
                await User.findByIdAndUpdate(valetId, {
                    $inc: {
                        currentBalance: valetCutCents,
                        totalEarnings: valetCutCents,
                    },
                });
                await Order.findByIdAndUpdate(order._id, { creditedValet: true });
                console.log(
                    'Credited park-and-hold parking valet on park-complete:',
                    valetId.toString(),
                    'with',
                    valetCutCents,
                    'cents (parking portion)'
                );
            } catch (err) {
                console.error(
                    'Failed to credit park-and-hold parking valet on park-complete:',
                    err.message
                );
            }
        }

        // If the order has a `creditedValet` flag already, skip — already paid.
        // Otherwise, if status just became 'completed' and there's a valet,
        // credit valet's currentBalance + totalEarnings.
        //
        // Revenue split: 70% to the valet, 30% to ValetNYC. Math.floor avoids
        // fractional cents (any rounding fragment goes to the platform).
        // Adjust `VALET_CUT` if the split changes — keep it on this single line.
        if (
            updates.status === 'completed' &&
            !order.creditedValet &&
            order.valet &&
            valetPayBaseCents(order) > 0
        ) {
            const VALET_CUT = 0.7;
            const valetId =
                typeof order.valet === 'object'
                    ? order.valet._id
                    : order.valet;
            const valetCutCents = Math.floor(valetPayBaseCents(order) * VALET_CUT);
            try {
                await User.findByIdAndUpdate(valetId, {
                    $inc: {
                        currentBalance: valetCutCents,
                        totalEarnings: valetCutCents,
                    },
                });
                // Mark order as credited so we don't double-pay on re-saves
                await Order.findByIdAndUpdate(order._id, {
                    creditedValet: true,
                });
                console.log(
                    'Credited valet',
                    valetId.toString(),
                    'with',
                    valetCutCents,
                    'cents'
                );
            } catch (err) {
                // Don't fail the order completion if crediting fails — log and continue
                console.error('Failed to credit valet earnings:', err.message);
            }
        }

        const updateType =
            updates.status === 'completed'
                ? 'ORDER_COMPLETED'
                : updates.parkingLocation
                ? 'PARKING_LOCATION_UPDATE'
                : 'ORDER_UPDATE';

        const orderWithType = {
            ...order.toObject(),
            type: updateType,
        };

        // Broadcast to all relevant parties
        // Removed 2026-08-06: this broadcast went to EVERY connected socket,
        // including browsers. The room-targeted emits directly below deliver the
        // same payload to the only two parties that act on it, and the clients
        // ignore updates for orders that are not their own. Keeping it meant
        // handing every listener the full order document.
        // `order` is populated, so `order.customer` / `order.valet` are
        // documents, not ids — calling toString() on one yields its inspect
        // string ("{ firstName: 'x', _id: ... }") and the emit lands in a room
        // nobody is in. Every live update out of this endpoint was being
        // dropped, including the parking-location move the customer is
        // waiting on. Resolve the id explicitly, and tolerate an order with
        // no valet yet (a customer editing their own order) instead of
        // throwing after the write has already landed.
        const roomId = (party) =>
            party && typeof party === 'object'
                ? party._id && party._id.toString()
                : party && party.toString();

        const customerRoom = roomId(order.customer);
        const valetRoom = roomId(order.valet);
        if (customerRoom) {
            req.io.to(customerRoom).emit('orderUpdated', orderWithType);
        }
        if (valetRoom) {
            req.io.to(valetRoom).emit('orderUpdated', orderWithType);
        }

        res.status(200).json({
            success: true,
            message: 'Order updated successfully',
            order,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Failed to update order',
        });
    }
};

exports.getOrdersByUser = async (req, res) => {
    const { userId, isValet } = req.query;

    try {
        const query =
            isValet === 'true' ? { valet: userId } : { customer: userId };

        const orders = await Order.find(query).sort({ pickUpTime: -1 }).exec();

        res.status(200).json({
            success: true,
            message: 'Orders fetched successfully',
            orders,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch orders',
        });
    }
};

exports.createRetrievalOrder = async (req, res) => {
    const {
        customer,
        customerLocation,
        originalOrderId,
        paymentMethod,
        paymentIntentId,
    } = req.body;

    try {
        console.log('Creating retrieval order for original order:', originalOrderId);

        // Find the original parking order
        const originalOrder = await Order.findById(originalOrderId).populate('valet');

        if (!originalOrder) {
            return res.status(404).json({
                success: false,
                message: 'Original order not found',
            });
        }

        // Validate the original order
        if (originalOrder.orderType !== 'parking') {
            return res.status(400).json({
                success: false,
                message: 'Can only create retrieval for parking orders',
            });
        }

        if (originalOrder.status !== 'parked') {
            return res.status(400).json({
                success: false,
                message: 'Car must be parked before requesting retrieval',
            });
        }

        if (originalOrder.customer.toString() !== customer) {
            return res.status(403).json({
                success: false,
                message: 'Unauthorized: Order belongs to different customer',
            });
        }

        // One retrieval per park. The customer's home screen keeps the
        // "slide to have it brought back" control visible while a retrieval
        // is in flight, so a second slide used to mint a second retrieval
        // order — two valets dispatched to the same car, one of them unpaid.
        // Hand the caller the live one instead; every client already treats
        // `order` in the response as "the retrieval to watch".
        const liveRetrieval = await Order.findOne({
            linkedOrderId: originalOrderId,
            orderType: 'retrieval',
            status: { $in: RETRIEVAL_LIVE_STATUSES },
        });
        if (liveRetrieval) {
            console.log(
                'Retrieval already in flight for order',
                originalOrderId,
                '->',
                liveRetrieval._id.toString()
            );
            return res.status(200).json({
                success: true,
                alreadyRequested: true,
                message: 'A retrieval is already on its way for this car',
                order: liveRetrieval,
            });
        }

        // Retrieval is open to ANY available valet. The original valet
        // doesn't hold the keys anymore (they're with the customer for
        // park-and-retrieve customer flow, or with the front desk for
        // Enterprise) — so requiring them specifically would be wrong and
        // would block the customer when their original valet is offline.
        const customerDoc = await User.findById(customer).select('isDoorman');
        const isEnterpriseRequester = !!customerDoc?.isDoorman;

        // Retrieval legs don't take subscription coverage of their own —
        // linked retrievals are already $0/pre-paid below, which is exactly
        // what "free park + retrieval" needs (the covered PARK is the free
        // one; its return ride was always free once linked).
        const isFreeService = originalOrder.isFreeService || false;
        const eventCode = originalOrder.eventCode;
        const serviceType = originalOrder.serviceType || 'standard';

        // Determine the amount for retrieval.
        // - Standalone retrieval (no originalOrderId): $5 charged to the requester.
        // - Linked retrieval after PARK-AND-RETRIEVE parking: customer pre-paid
        //   the $3 retrieval portion at parking time, so we still record
        //   totalAmount=300 here (so the retrieval valet gets credited 70% on
        //   completion) but mark it isFreeService=true so no charge fires.
        // - Linked retrieval after STANDARD parking: $0 (no separate retrieval
        //   portion was paid), retrieval valet gets nothing.
        const RETRIEVAL_PORTION_CENTS = 300; // $3
        const isParkAndRetrieveLinked =
            !!originalOrderId && serviceType === 'park-and-hold';
        let totalAmount = 500; // $5 in cents (default standalone)
        let finalIsFreeService = isFreeService;
        if (isParkAndRetrieveLinked) {
            totalAmount = RETRIEVAL_PORTION_CENTS;
            finalIsFreeService = true;
        } else if (originalOrderId) {
            totalAmount = 0;
            finalIsFreeService = true;
        } else if (isFreeService) {
            totalAmount = 0;
        }

        // If not free service, ensure payment is verified
        if (!finalIsFreeService && !paymentIntentId) {
            return res.status(400).json({
                success: false,
                message: 'Payment verification required for retrieval order',
            });
        }

        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const otpCreatedAt = new Date();
        const otpExpiresAt = new Date(otpCreatedAt.getTime() + OTP_EXPIRY_RETURN_KEY);

        // Create retrieval order data
        //
        // Customer location for retrieval defaults to the keys-handoff
        // coordinate (where the keys originally changed hands at order
        // start) — that's almost always where the customer/doorman wants
        // the car returned to. Fall back to the parking order's original
        // customerLocation if we never recorded a key drop-off (legacy
        // pre-build-11 orders).
        const defaultRetrievalLocation =
            originalOrder.keyDropoffLocation &&
            typeof originalOrder.keyDropoffLocation.lat === 'number'
                ? {
                      lat: originalOrder.keyDropoffLocation.lat,
                      lng: originalOrder.keyDropoffLocation.lng,
                      streetAddress: originalOrder.keyDropoffLocation.streetAddress,
                  }
                : originalOrder.customerLocation;
        const retrievalOrderData = {
            customer,
            customerLocation: customerLocation || defaultRetrievalLocation,
            parkingType: 'retrieval',
            orderType: 'retrieval',
            parkingLocation: originalOrder.parkingLocation,
            duration: 30, // Default 30 minutes for retrieval
            pickUpTime: new Date(),
            status: 'pending', // Start as pending for valet to accept
            paymentMethod: paymentMethod || originalOrder.paymentMethod,
            totalAmount,
            paymentStatus: 'paid',
            paymentIntentId,
            linkedOrderId: originalOrderId,
            eventCode,
            isFreeService: finalIsFreeService,
            serviceType,
            // Carry forward Enterprise end-customer + vehicle context so the
            // accepting valet knows who they're meeting and which car.
            ...(originalOrder.endCustomerName
                ? { endCustomerName: originalOrder.endCustomerName }
                : {}),
            ...(originalOrder.endCustomerPhone
                ? { endCustomerPhone: originalOrder.endCustomerPhone }
                : {}),
            ...(originalOrder.vehicle
                ? { vehicle: originalOrder.vehicle }
                : {}),
            otp: {
                code: otpCode,
                createdAt: otpCreatedAt,
                expiresAt: otpExpiresAt,
                verified: false,
                type: 'return_key',
            }
        };

        console.log('Retrieval order data:', retrievalOrderData);

        const retrievalOrder = new Order(retrievalOrderData);
        await retrievalOrder.save();

        console.log('Retrieval order created successfully:', retrievalOrder._id);

        // Update original order to link to retrieval. For Enterprise we also
        // mark the original parking as 'completed' immediately — once
        // retrieval is in flight, the parking phase is conceptually over
        // and the front desk's active list should show only the retrieval.
        // The existing post-retrieval-completion hook (which also sets the
        // linked order to 'completed') becomes a no-op for Enterprise.
        originalOrder.linkedOrderId = retrievalOrder._id;
        if (isEnterpriseRequester) {
            originalOrder.status = 'completed';
        }
        await originalOrder.save();

        // Crediting happens here for Enterprise because we transitioned the
        // parking order to 'completed' via a direct save above (which
        // bypasses the credit hook in `updateOrder`). For non-Enterprise
        // the parking order's normal completion flow still handles this.
        if (
            isEnterpriseRequester &&
            !originalOrder.creditedValet &&
            originalOrder.valet &&
            valetPayBaseCents(originalOrder) > 0
        ) {
            const VALET_CUT = 0.7;
            const parkingValetId =
                typeof originalOrder.valet === 'object'
                    ? originalOrder.valet._id
                    : originalOrder.valet;
            // For park-and-retrieve, $3 of the $13 was for the retrieval
            // valet — strip that out so the parking valet only gets credit
            // for the parking portion (70% × $10 = $7, not 70% × $13).
            const enterprisePayBase = valetPayBaseCents(originalOrder);
            const parkingPortion =
                originalOrder.serviceType === 'park-and-hold'
                    ? Math.max(0, enterprisePayBase - 300)
                    : enterprisePayBase;
            const valetCutCents = Math.floor(parkingPortion * VALET_CUT);
            try {
                await User.findByIdAndUpdate(parkingValetId, {
                    $inc: {
                        currentBalance: valetCutCents,
                        totalEarnings: valetCutCents,
                    },
                });
                await Order.findByIdAndUpdate(originalOrder._id, {
                    creditedValet: true,
                });
                console.log(
                    'Credited Enterprise parking valet',
                    parkingValetId.toString(),
                    'with',
                    valetCutCents,
                    'cents on retrieval request'
                );
            } catch (err) {
                console.error(
                    'Failed to credit Enterprise parking valet:',
                    err.message
                );
            }
        }

        // Emit socket events - use newOrder to trigger ValetHomeScreen update
        req.io.emit('newOrder', retrievalOrder);

        // Also emit to customer as orderUpdated for tracking
        req.io.to(customer).emit('orderUpdated', retrievalOrder);

        // For non-Enterprise: target the original valet specifically. For
        // Enterprise: skip targeted notifications — the broadcast `newOrder`
        // event above already lights up all available valets.
        if (!isEnterpriseRequester && originalOrder.valet && originalOrder.valet._id) {
            req.io.to(originalOrder.valet._id.toString()).emit('newRetrievalRequest', {
                order: retrievalOrder,
                message: 'You have a new retrieval request for a car you parked',
            });
        }

        // Send push notification to valet for retrieval request (non-Enterprise only)
        try {
            // Get valet's Firebase UID
            const valet = !isEnterpriseRequester && originalOrder.valet
                ? await User.findById(originalOrder.valet._id)
                : null;
            if (valet && valet.firebaseUid) {
                // Get FCM token from Firestore
                const admin = require('firebase-admin');
                const valetDoc = await admin.firestore()
                    .collection('users')
                    .doc(valet.firebaseUid)
                    .get();
                
                if (valetDoc.exists && valetDoc.data().fcmToken) {
                    const notificationData = {
                        token: valetDoc.data().fcmToken,
                        title: 'Retrieval Request',
                        body: `Customer requests their car back at ${retrievalOrder.customerLocation.streetAddress.split(',')[0]}`
                    };
                    
                    // Send notification using existing endpoint
                    await axios.post(`http://localhost:${process.env.PORT || 3001}/api/notification/send`, notificationData);
                    console.log('Push notification sent to valet for retrieval request');
                }
            }
        } catch (notificationError) {
            console.error('Error sending retrieval push notification:', notificationError);
            // Don't fail the request if notification fails
        }

        res.status(201).json({
            success: true,
            message: 'Retrieval order created successfully',
            order: retrievalOrder,
        });
    } catch (err) {
        console.error('Retrieval order creation error:', err);
        
        if (err.name === 'ValidationError') {
            const validationErrors = Object.keys(err.errors).map(key => ({
                field: key,
                message: err.errors[key].message,
                value: err.errors[key].value
            }));
            
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: validationErrors,
            });
        }
        
        res.status(500).json({
            success: false,
            message: err.message || 'Failed to create retrieval order',
            error: err.name,
            stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
    }
};

// Add vehicle information to an order
exports.addVehicleInfo = async (req, res) => {
    const { orderId, vehicle } = req.body;

    try {
        // Validate required vehicle fields
        if (!vehicle || !vehicle.color || !vehicle.model || !vehicle.licensePlate) {
            return res.status(400).json({
                success: false,
                message: 'Vehicle color, model, and license plate are required',
            });
        }

        // Check if keyTagNumber is provided and validate uniqueness among active orders
        if (vehicle.keyTagNumber) {
            const activeStatuses = ['pending', 'accepted', 'in-progress', 'in_progress', 'parked'];
            
            const existingKeyTag = await Order.findOne({
                _id: { $ne: orderId }, // Exclude current order
                'vehicle.keyTagNumber': vehicle.keyTagNumber,
                status: { $in: activeStatuses },
            });

            if (existingKeyTag) {
                return res.status(400).json({
                    success: false,
                    message: `Key tag number '${vehicle.keyTagNumber}' is already in use by an active order`,
                    conflictingOrderId: existingKeyTag._id,
                });
            }
        }

        console.log('Adding vehicle info to order:', orderId, vehicle);
        const order = await Order.findByIdAndUpdate(
            orderId,
            { vehicle },
            { new: true }
        );

        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found',
            });
        }

        // Removed 2026-08-06: this broadcast went to EVERY connected socket,
        // including browsers. The room-targeted emits directly below deliver the
        // same payload to the only two parties that act on it, and the clients
        // ignore updates for orders that are not their own. Keeping it meant
        // handing every listener the full order document.
        req.io.to(order.customer.toString()).emit('orderUpdated', {
            ...order.toObject(),
            type: 'VEHICLE_ADDED',
        });
        req.io.to(order.valet.toString()).emit('orderUpdated', {
            ...order.toObject(),
            type: 'VEHICLE_ADDED',
        });

        res.status(200).json({
            success: true,
            message: 'Vehicle information added successfully',
            order,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Failed to add vehicle information',
        });
    }
};

// Check if a key tag number is available
exports.checkKeyTagAvailability = async (req, res) => {
    const { keyTagNumber } = req.body;

    try {
        if (!keyTagNumber) {
            return res.status(400).json({
                success: false,
                message: 'keyTagNumber is required',
            });
        }

        const activeStatuses = ['pending', 'accepted', 'in-progress', 'in_progress', 'parked'];
        
        const existingKeyTag = await Order.findOne({
            'vehicle.keyTagNumber': keyTagNumber,
            status: { $in: activeStatuses },
        });

        if (existingKeyTag) {
            return res.status(200).json({
                success: true,
                available: false,
                message: `Key tag number '${keyTagNumber}' is already in use`,
                conflictingOrderId: existingKeyTag._id,
            });
        }

        res.status(200).json({
            success: true,
            available: true,
            message: `Key tag number '${keyTagNumber}' is available`,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Failed to check key tag availability',
            error: err.message,
        });
    }
};

// Get today's parked cars for a valet
exports.getTodaysParkedCars = async (req, res) => {
    const { valetId } = req.params;
    const { lat, lng } = req.query;

    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Find orders that are parked or completed today with vehicle info
        const orders = await Order.find({
            valet: valetId,
            status: { $in: ['parked', 'completed'] },
            updatedAt: { $gte: today, $lt: tomorrow },
            'vehicle.color': { $exists: true },
            'vehicle.model': { $exists: true },
            'vehicle.licensePlate': { $exists: true },
        }).populate('customer', 'firstName lastName phone');

        // Calculate distance if valet location provided
        if (lat && lng) {
            const valetLat = parseFloat(lat);
            const valetLng = parseFloat(lng);
            
            console.log('Valet location for distance calculation:', { valetLat, valetLng });

            // Filter orders that have parking locations
            const ordersWithParkingLocation = orders.filter(order => order.parkingLocation);
            
            if (ordersWithParkingLocation.length > 0) {
                // Prepare destinations for Google Maps Distance Matrix API
                const destinations = ordersWithParkingLocation
                    .map(order => `${order.parkingLocation.lat},${order.parkingLocation.lng}`)
                    .join('|');

                console.log('Calculating distances for', ordersWithParkingLocation.length, 'cars');

                try {
                    // Use Google Maps Distance Matrix API
                    const distanceMatrixResponse = await axios.get(
                        'https://maps.googleapis.com/maps/api/distancematrix/json',
                        {
                            params: {
                                origins: `${valetLat},${valetLng}`,
                                destinations,
                                mode: 'walking',
                                units: 'imperial', // This will return distances in miles/feet
                                key: process.env.REACT_APP_GOOGLE_MAPS_APIKEY,
                            },
                        }
                    );

                    console.log('Distance Matrix API response status:', distanceMatrixResponse.data.status);
                    
                    // Log more details if request was denied
                    if (distanceMatrixResponse.data.status === 'REQUEST_DENIED') {
                        console.error('Google Maps API Request Denied:', distanceMatrixResponse.data.error_message);
                    } else if (distanceMatrixResponse.data.status === 'OK') {
                        console.log('Distance Matrix API Success - First result:', distanceMatrixResponse.data.rows[0]?.elements[0]);
                    }

                    // Process distances and combine with orders
                    const ordersWithDistance = orders.map(order => {
                        const orderObj = order.toObject();
                        
                        if (!order.parkingLocation) {
                            return { ...orderObj, distance: null, distanceText: null };
                        }

                        const orderIndex = ordersWithParkingLocation.findIndex(o => o._id.equals(order._id));
                        if (orderIndex >= 0 && distanceMatrixResponse.data.rows[0]?.elements[orderIndex]) {
                            const element = distanceMatrixResponse.data.rows[0].elements[orderIndex];
                            
                            return {
                                ...orderObj,
                                distance: element.distance?.value || null, // Distance in meters (for sorting)
                                distanceText: element.distance?.text || null, // Human-readable distance (e.g., "0.5 mi", "300 ft")
                            };
                        }

                        return { ...orderObj, distance: null, distanceText: null };
                    });

                    // Sort by distance
                    ordersWithDistance.sort((a, b) => {
                        if (a.distance === null && b.distance === null) return 0;
                        if (a.distance === null) return 1;
                        if (b.distance === null) return -1;
                        return a.distance - b.distance;
                    });

                    return res.status(200).json({
                        success: true,
                        message: 'Today\'s parked cars fetched successfully',
                        orders: ordersWithDistance,
                    });
                } catch (apiError) {
                    console.error('Google Maps API error:', apiError.response?.data || apiError.message);
                    // Fallback to returning orders without distance
                    return res.status(200).json({
                        success: true,
                        message: 'Today\'s parked cars fetched successfully (distance unavailable)',
                        orders: orders.map(order => ({ ...order.toObject(), distance: null, distanceText: null })),
                    });
                }
            } else {
                // No orders have parking locations, but valet location was provided
                return res.status(200).json({
                    success: true,
                    message: 'Today\'s parked cars fetched successfully',
                    orders: orders.map(order => ({ ...order.toObject(), distance: null, distanceText: null })),
                });
            }
        } else {
            // No valet location provided
            return res.status(200).json({
                success: true,
                message: 'Today\'s parked cars fetched successfully',
                orders: orders.map(order => ({ ...order.toObject(), distance: null, distanceText: null })),
            });
        }
    } catch (err) {
        console.error('Error in getTodaysParkedCars:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch today\'s parked cars',
        });
    }
};

// Update parking location for a car
exports.verifyOTP = async (req, res) => {
    const { orderId, otp } = req.body;

    try {
        if (!orderId || !otp) {
            return res.status(400).json({
                success: false,
                message: 'orderId and otp are required',
            });
        }

        const order = await Order.findById(orderId);
        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found',
            });
        }

        const otpData = order.otp;
        if (!otpData || !otpData.code) {
            return res.status(400).json({
                success: false,
                message: 'No OTP found for this order. Please update parking location first.',
            });
        }

        // Check if OTP is expired - regenerate if needed
        if (new Date() > otpData.expiresAt) {
            // Regenerate OTP
            const newOtpCode = Math.floor(100000 + Math.random() * 900000).toString();
            const newOtpCreatedAt = new Date();
            const newOtpExpiresAt = new Date(newOtpCreatedAt.getTime() + OTP_EXPIRY_RETURN_KEY);
            
            await Order.findByIdAndUpdate(orderId, {
                'otp.code': newOtpCode,
                'otp.createdAt': newOtpCreatedAt,
                'otp.expiresAt': newOtpExpiresAt,
                'otp.verified': false,
            });
            
            return res.status(400).json({
                success: false,
                message: 'OTP has expired. A new OTP has been generated and sent.',
                otpRegenerated: true,
            });
        }

        // Verify OTP code
        if (otpData.code !== otp.toString()) {
            return res.status(400).json({
                success: false,
                message: 'Invalid OTP. Please try again.',
            });
        }

        // Mark OTP as verified with timestamp
        const verifiedAt = new Date();
        const updateData = {
            'otp.verified': true,
            'otp.verifiedAt': verifiedAt,
        };

        // Track verification time based on OTP type
        if (otpData.type === 'order_creation') {
            updateData['otpVerifiedTimes.orderCreation'] = verifiedAt;
        } else if (otpData.type === 'parking_location') {
            updateData['otpVerifiedTimes.parkingLocation'] = verifiedAt;
        } else if (otpData.type === 'return_key') {
            updateData['otpVerifiedTimes.returnKey'] = verifiedAt;
        }

        // A RETRIEVAL has two handoffs, and they must not share a code.
        //
        //   Beat 1 — the valet arrives, reads their code, the customer types it,
        //            and hands over the keys.
        //   Beat 2 — the valet returns with the car, the customer says a code,
        //            the valet types it, and the car is released.
        //
        // A parking order gets its second code for free: `updateCarLocation`
        // regenerates the OTP when the valet parks. Nothing does that on a
        // retrieval, so until now both beats verified against the SAME code —
        // which means anyone who overheard beat 1 could claim the car at beat 2.
        // Beat 1 is identified by `otpVerifiedTimes.returnKey` being unset; once
        // it is stamped, this is beat 2 and the order is finished with.
        const isRetrievalKeyPickup =
            order.orderType === 'retrieval' &&
            otpData.type === 'return_key' &&
            !(order.otpVerifiedTimes && order.otpVerifiedTimes.returnKey);

        if (isRetrievalKeyPickup) {
            const nextCode = Math.floor(100000 + Math.random() * 900000).toString();
            const nextCreatedAt = new Date();
            const nextExpiresAt = new Date(nextCreatedAt.getTime() + OTP_EXPIRY_RETURN_KEY);

            // `otp.*` dotted paths and a whole `otp` object can't co-exist in one
            // $set, so the timestamp is carried over by hand.
            const updatedOrder = await Order.findByIdAndUpdate(
                orderId,
                {
                    'otpVerifiedTimes.returnKey': verifiedAt,
                    otp: {
                        code: nextCode,
                        createdAt: nextCreatedAt,
                        expiresAt: nextExpiresAt,
                        verified: false,
                        type: 'return_key',
                    },
                },
                { new: true }
            );

            // The customer SAYS this one, so only the customer may see it —
            // same split `updateCarLocation` uses for the parking leg.
            if (req.io && updatedOrder) {
                const orderData = updatedOrder.toObject();
                const orderForValet = { ...orderData, otp: { ...orderData.otp } };
                delete orderForValet.otp.code;

                req.io
                    .to(updatedOrder.customer.toString())
                    .emit('orderUpdated', { ...orderData, type: 'RETURN_KEY_OTP_GENERATED' });
                if (updatedOrder.valet) {
                    req.io
                        .to(updatedOrder.valet.toString())
                        .emit('orderUpdated', { ...orderForValet, type: 'RETURN_KEY_OTP_GENERATED' });
                }
            }

            // Beat 1 of a retrieval: the valet has just taken the keys.
            await markCollectVerifiedOnConversation(updatedOrder || order);

            return res.status(200).json({
                success: true,
                message: 'OTP verified successfully',
                otpRegenerated: true,
            });
        }

        await Order.findByIdAndUpdate(orderId, updateData);

        // Beat 1 of a park: the customer has just handed the keys over. Same
        // moment, different OTP type, same flag the valet's button reads.
        if (otpData.type === 'order_creation') {
            await markCollectVerifiedOnConversation(order);
        }

        res.status(200).json({
            success: true,
            message: 'OTP verified successfully',
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Failed to verify OTP',
        });
    }
};

exports.updateCarLocation = async (req, res) => {
    const { orderId, parkingLocation } = req.body;

    try {
        const order = await Order.findById(orderId);

        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found',
            });
        }

        // Check if previous OTP has been verified
        // if (!order.otp || !order.otp.verified) {
        //     return res.status(400).json({
        //         success: false,
        //         message: 'Please verify the OTP first before updating parking location',
        //     });
        // }

        // Same rule as updateOrder: only the FIRST park is a park. A valet
        // moving a car they already parked must not silently change the
        // return-key code the customer is holding, un-verify a handoff that
        // already happened, or restamp parkedAt.
        const existingOtp = order.otp;
        const hasLiveReturnKeyOtp =
            existingOtp &&
            existingOtp.code &&
            existingOtp.type === 'return_key' &&
            (existingOtp.verified ||
                (existingOtp.expiresAt && new Date(existingOtp.expiresAt) > new Date()));

        const changes = { parkingLocation };
        let otpExpiresAt = existingOtp && existingOtp.expiresAt;
        if (!hasLiveReturnKeyOtp) {
            // Generate new OTP (6-digit code)
            const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
            const otpCreatedAt = new Date();
            otpExpiresAt = new Date(otpCreatedAt.getTime() + OTP_EXPIRY_PARKING_LOCATION);
            changes.otp = {
                code: otpCode,
                createdAt: otpCreatedAt,
                expiresAt: otpExpiresAt,
                verified: false,
                type: 'return_key',
            };
        }
        if (!order.parkedAt) {
            changes.parkedAt = new Date();
        }

        const updatedOrder = await Order.findByIdAndUpdate(orderId, changes, {
            new: true,
        });

        const orderData = updatedOrder.toObject();
        // Don't send the OTP code to the valet — only to the customer. The
        // spread is shallow, so `otp` has to be re-made or deleting the code
        // strips it out of the customer's copy too.
        const orderForValet = { ...orderData, otp: { ...(orderData.otp || {}) } };
        delete orderForValet.otp.code;

        // Removed 2026-08-06: this broadcast went to EVERY connected socket,
        // including browsers. The room-targeted emits directly below deliver the
        // same payload to the only two parties that act on it, and the clients
        // ignore updates for orders that are not their own. Keeping it meant
        // handing every listener the full order document.
        if (order.customer) {
            req.io.to(order.customer.toString()).emit('orderUpdated', {
                ...orderData,
                type: 'PARKING_LOCATION_UPDATE',
            });
        }
        if (order.valet) {
            req.io.to(order.valet.toString()).emit('orderUpdated', {
                ...orderForValet,
                type: 'PARKING_LOCATION_UPDATE',
            });
        }

        res.status(200).json({
            success: true,
            message: 'Car location updated successfully.',
            order: {
                ...orderData,
                otp: {
                    expiresAt: otpExpiresAt,
                    verified: !!(updatedOrder.otp && updatedOrder.otp.verified),
                    // Don't send code in response
                }
            },
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Failed to update car location',
        });
    }
};

// Calculate distances for Firebase conversations
exports.calculateConversationDistances = async (req, res) => {
    const { conversations, valetLat, valetLng } = req.body;

    try {
        if (!conversations || !Array.isArray(conversations) || conversations.length === 0) {
            return res.status(200).json({
                success: true,
                distances: {}
            });
        }

        if (!valetLat || !valetLng) {
            return res.status(400).json({
                success: false,
                message: 'Valet location is required'
            });
        }

        // Filter conversations that have parking locations
        const conversationsWithLocation = conversations.filter(
            conv => conv.parkingLocation?.lat && conv.parkingLocation?.lng
        );

        if (conversationsWithLocation.length === 0) {
            return res.status(200).json({
                success: true,
                distances: {}
            });
        }

        // Prepare destinations for Google Maps Distance Matrix API
        const destinations = conversationsWithLocation
            .map(conv => `${conv.parkingLocation.lat},${conv.parkingLocation.lng}`)
            .join('|');

        console.log('Calculating distances for', conversationsWithLocation.length, 'conversations');

        // Use Google Maps Distance Matrix API
        const distanceMatrixResponse = await axios.get(
            'https://maps.googleapis.com/maps/api/distancematrix/json',
            {
                params: {
                    origins: `${valetLat},${valetLng}`,
                    destinations,
                    mode: 'walking',
                    units: 'imperial',
                    key: process.env.REACT_APP_GOOGLE_MAPS_APIKEY,
                },
            }
        );

        console.log('Distance Matrix API response status:', distanceMatrixResponse.data.status);

        if (distanceMatrixResponse.data.status !== 'OK') {
            console.error('Google Maps API error:', distanceMatrixResponse.data.error_message);
            return res.status(200).json({
                success: true,
                distances: {}
            });
        }

        // Create distance map
        const distances = {};
        conversationsWithLocation.forEach((conv, index) => {
            if (distanceMatrixResponse.data.rows[0]?.elements[index]) {
                const element = distanceMatrixResponse.data.rows[0].elements[index];
                distances[conv._id] = {
                    distance: element.distance?.value || null,
                    distanceText: element.distance?.text || null
                };
            }
        });

        return res.status(200).json({
            success: true,
            distances
        });
    } catch (err) {
        console.error('Error calculating conversation distances:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to calculate distances',
            error: err.message
        });
    }
};

// Subscriptions v2: attach the customer's live subscription (or null) for
// the per-order coverage decision inside createOrder. The pre-v2 behavior —
// a blanket req.hasSubscription that zeroed EVERY order for a subscriber —
// is retired; entitlements are now per-tier and per-usage, decided by
// subscriptionService.evaluateParkCoverage.
exports.validateSubscriptionForOrder = async (req, res, next) => {
    const { customer } = req.body;

    try {
        if (!customer) {
            return res.status(400).json({
                success: false,
                message: 'Customer ID is required',
            });
        }

        const user = await User.findById(customer);
        if (!user) {
            console.log('User not found with ID:', customer);
            return res.status(404).json({
                success: false,
                message: 'User not found',
            });
        }

        req.user = user;
        req.subscription = await subscriptionService.getActiveSubscription(customer);
        next();
    } catch (err) {
        console.error('Subscription validation error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to validate subscription',
            error: err.message,
        });
    }
};

// Generate OTP for returning keys
exports.generateReturnKeyOtp = async (req, res) => {
    const { orderId } = req.body;

    try {
        const order = await Order.findById(orderId);

        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found',
            });
        }

        // Generate OTP for key return (6-digit code)
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const otpCreatedAt = new Date();
        const otpExpiresAt = new Date(otpCreatedAt.getTime() + OTP_EXPIRY_RETURN_KEY);

        const updatedOrder = await Order.findByIdAndUpdate(
            orderId,
            {
                otp: {
                    code: otpCode,
                    createdAt: otpCreatedAt,
                    expiresAt: otpExpiresAt,
                    verified: false,
                    type: 'return_key',
                }
            },
            { new: true }
        ).populate('customer valet');

        const orderData = updatedOrder.toObject();
        
        // Don't send OTP code to valet, only to customer
        const orderForValet = { ...orderData };
        delete orderForValet.otp.code;

        // Emit socket events
        // Removed 2026-08-06: this broadcast went to EVERY connected socket,
        // including browsers. The room-targeted emits directly below deliver the
        // same payload to the only two parties that act on it, and the clients
        // ignore updates for orders that are not their own. Keeping it meant
        // handing every listener the full order document.
        req.io.to(order.customer.toString()).emit('orderUpdated', {
            ...orderData,
            type: 'RETURN_KEY_OTP_GENERATED',
        });
        req.io.to(order.valet.toString()).emit('orderUpdated', {
            ...orderForValet,
            type: 'RETURN_KEY_OTP_GENERATED',
        });

        res.status(200).json({
            success: true,
            message: 'Return key OTP generated successfully',
            order: {
                _id: orderData._id,
                otp: {
                    expiresAt: otpExpiresAt,
                    verified: false,
                    type: 'return_key',
                    // Don't send code in response
                }
            },
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Failed to generate return key OTP',
            error: err.message,
        });
    }
};

// Check ASP orders and handle notifications and automatic retrieval order creation
// Core ASP sweep pass — valet reminder pushes 10 min before asp_time, and
// the automatic return order at asp_time. Shared by the server interval
// (server.js, ASP_SWEEP_ENABLED gate) and the manual HTTP trigger below.
// The old EC2 deployment ran this on an interval; the Render migration lost
// that caller, which silently killed ASP auto-returns until now.
const runAspSweep = async (io, now = new Date()) => {
    {
        // Find all ASP orders that are parked and have asp_time set
        const aspOrders = await Order.find({
            aspMode: true,
            asp_time: { $exists: true, $ne: null },
            status: { $in: ['parked'] },
            linkedOrderId: { $exists: false } // Only original parking orders, not retrieval orders
        }).populate('valet customer');

        const results = {
            notificationsSent: [],
            retrievalOrdersCreated: [],
            errors: []
        };

        for (const order of aspOrders) {
            try {
                const aspTime = new Date(order.asp_time);
                const tenMinutesBeforeAsp = new Date(aspTime.getTime() - 10 * 60 * 1000);

                // Away mode: while the car is parked and the customer is
                // gone, remind the valet to move it for each scheduled
                // street-cleaning slot. Keys are already with the valet, so
                // this is a push + done — no customer interaction, no new
                // orders. Deduped per occurrence via awayReminderLastKey.
                if (order.awayMode && order.awayDays && order.awayDays.length > 0 && order.valet) {
                    const { nextNyOccurrence, nyDateKey } = require('../services/nyTime');
                    for (const day of order.awayDays) {
                        const occ = nextNyOccurrence(day, new Date(now.getTime() - 10 * 60 * 1000));
                        if (!occ) continue;
                        const distanceMs = occ.getTime() - now.getTime();
                        if (distanceMs > 15 * 60 * 1000 || distanceMs < -10 * 60 * 1000) continue;
                        if (occ.getTime() >= aspTime.getTime()) continue; // return day — normal flow handles it
                        const key = `${nyDateKey(occ)}:${day.hour}:${day.minute}`;
                        if (order.awayReminderLastKey === key) continue;
                        try {
                            const { sendPushNotification } = require('./notificationController');
                            await sendPushNotification(
                                order.valet.firebaseUid,
                                'Street cleaning — move the car',
                                `Away-mode car at ${order.customerLocation?.streetAddress || 'the saved address'}: sweep starts soon. Move it, then re-park after.`,
                                { orderId: order._id.toString(), type: 'AWAY_MOVE_REMINDER' }
                            );
                        } catch (pushErr) {
                            console.error('Away move push failed:', pushErr.message);
                        }
                        if (io) {
                            io.to(order.valet._id.toString()).emit('aspNotification', {
                                orderId: order._id,
                                message: 'Away-mode car: street cleaning starts soon — move and re-park it.',
                                type: 'AWAY_MOVE_REMINDER',
                            });
                        }
                        order.awayReminderLastKey = key;
                        await order.save();
                        results.notificationsSent.push({
                            orderId: order._id,
                            valetId: order.valet._id,
                            message: `Away move reminder (${key})`,
                        });
                    }
                }
                
                // Check if we should send notification (10 minutes before asp_time)
                if (now >= tenMinutesBeforeAsp && now < aspTime && !order.aspNotificationSent) {
                    // Send push notification to valet
                    if (order.valet) {
                        const { sendPushNotification } = require('./notificationController');
                        
                        const pushResult = await sendPushNotification(
                            order.valet.firebaseUid,
                            'ASP Service Reminder',
                            'Your ASP service will end in 10 minutes. Please prepare to move the car back to the original location.',
                            {
                                orderId: order._id.toString(),
                                type: 'ASP_REMINDER',
                                aspTime: aspTime.toISOString(),
                            }
                        );

                        console.log(`ASP push notification sent to valet ${order.valet._id}:`, pushResult);
                    }

                    // Also send Socket.IO notification for real-time updates
                    if (io && order.valet) {
                        io.to(order.valet._id.toString()).emit('aspNotification', {
                            orderId: order._id,
                            message: 'Your ASP service will end in 10 minutes. Please prepare to move the car back to the original location.',
                            type: 'ASP_REMINDER',
                            aspTime: aspTime,
                        });

                        console.log(`ASP Socket.IO notification sent to valet ${order.valet._id} for order ${order._id}`);
                    }

                    // Mark notification as sent
                    order.aspNotificationSent = true;
                    await order.save();

                    results.notificationsSent.push({
                        orderId: order._id,
                        valetId: order.valet?._id,
                        message: 'Push notification sent 10 minutes before ASP time'
                    });
                }

                // Check if asp_time has been reached - create automatic retrieval order
                if (now >= aspTime && !order.linkedOrderId) {
                    if (!order.valet) {
                        // A parked ASP order with no valet on record shouldn't
                        // exist; skip it rather than crash the whole sweep.
                        continue;
                    }
                    // This used to bail out if the valet had any other live
                    // order, which meant a busy valet's ASP car was never
                    // moved and nobody was told — the sweep just logged and
                    // walked away. Valets carry several jobs now, and this
                    // leg is theirs by definition (they're holding the keys),
                    // so it always gets minted.
                    {
                        // Generate OTP for the retrieval order
                        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
                        const otpCreatedAt = new Date();
                        const otpExpiresAt = new Date(otpCreatedAt.getTime() + OTP_EXPIRY_RETURN_KEY);

                        // Create automatic retrieval order
                        const retrievalOrderData = {
                            customer: order.customer._id,
                            customerLocation: order.customerLocation,
                            parkingType: 'retrieval',
                            orderType: 'retrieval',
                            parkingLocation: order.parkingLocation,
                            duration: 30,
                            pickUpTime: now,
                            status: 'accepted',
                            paymentMethod: order.paymentMethod,
                            totalAmount: 0,
                            paymentStatus: 'paid',
                            linkedOrderId: order._id,
                            eventCode: order.eventCode,
                            isFreeService: true,
                            serviceType: order.serviceType || 'standard',
                            // Carry the sweep flag onto the return leg. It's
                            // what tells the customer app there is no keys
                            // handoff to wait on (the valet has had them since
                            // the sweep started) and what stops `cancelOrder`
                            // from standing down a valet who is already in the
                            // car. Without it this leg looks like an ordinary
                            // retrieval that nobody has touched yet.
                            aspMode: true,
                            valet: order.valet._id, // Assign same valet
                            otp: {
                                code: otpCode,
                                createdAt: otpCreatedAt,
                                expiresAt: otpExpiresAt,
                                verified: false,
                                type: 'return_key',
                            }
                        };

                        // DB-level dedup for the return leg: one LIVE child
                        // per parent, enforced by the unique sparse
                        // autoBookKey index no matter how many sweep passes
                        // race. A cancelled child (valet backed out, then
                        // auto-cancel reaped it and restored the parent) must
                        // not satisfy the dedup — release its key and mint a
                        // fresh leg, or the parent gets re-linked to a dead
                        // order and the car never comes back.
                        retrievalOrderData.autoBookKey = `aspreturn:${order._id}`;

                        let retrievalOrder = new Order(retrievalOrderData);
                        try {
                            await retrievalOrder.save();
                        } catch (saveErr) {
                            if (saveErr && saveErr.code === 11000) {
                                const holder = await Order.findOne({
                                    autoBookKey: `aspreturn:${order._id}`,
                                });
                                if (holder && holder.status !== 'cancelled') {
                                    retrievalOrder = holder;
                                } else if (holder) {
                                    await Order.updateOne(
                                        { _id: holder._id },
                                        { $unset: { autoBookKey: 1 } }
                                    );
                                    retrievalOrder = new Order(retrievalOrderData);
                                    await retrievalOrder.save();
                                } else {
                                    throw saveErr;
                                }
                            } else {
                                throw saveErr;
                            }
                        }

                        // Update original order to link to retrieval and mark as completed
                        order.linkedOrderId = retrievalOrder._id;
                        order.aspOrderCreated = true;
                        order.status = 'parked';
                        // The sweep's park is finished at this point — the
                        // return leg is its own order now.
                        order.parkClosedAt = order.parkClosedAt || new Date();
                        await order.save();

                        // Emit socket events
                        if (io) {
                            io.emit('newOrder', retrievalOrder);
                            io.to(order.customer._id.toString()).emit('orderUpdated', retrievalOrder);

                            // Notify valet about automatic retrieval order
                            io.to(order.valet._id.toString()).emit('newRetrievalRequest', {
                                order: retrievalOrder,
                                message: 'Automatic retrieval order created for ASP service completion',
                                isAutomatic: true,
                            });
                        }

                        console.log(`Automatic retrieval order created for ASP order ${order._id}`);

                        results.retrievalOrdersCreated.push({
                            originalOrderId: order._id,
                            retrievalOrderId: retrievalOrder._id,
                            valetId: order.valet._id,
                            customerId: order.customer._id,
                            message: 'Automatic retrieval order created at ASP time'
                        });
                    }
                }
            } catch (orderError) {
                console.error(`Error processing ASP order ${order._id}:`, orderError);
                results.errors.push({
                    orderId: order._id,
                    error: orderError.message
                });
            }
        }

        return results;
    }
};

exports.runAspSweep = runAspSweep;

// --- Away charge ledger ------------------------------------------------
// An away order can be paid in two charges: the $1 deposit at booking and
// the balance once the valet sets the schedule. Refunds must be able to
// reach both, so they walk this ledger newest-first instead of assuming a
// single PaymentIntent.

// The ledger, seeding the deposit from the order if it isn't recorded yet.
// Safe to call before the first balance charge — at that point awayPaidCents
// is still exactly what the deposit charged.
const awayChargeLedger = (order) => {
    const ledger = (order.awayCharges || []).map((c) => ({
        paymentIntentId: c.paymentIntentId,
        amountCents: c.amountCents || 0,
        refundedCents: c.refundedCents || 0,
        at: c.at,
    }));
    if (!ledger.length && order.paymentIntentId && (order.awayPaidCents || 0) > 0) {
        ledger.push({
            paymentIntentId: order.paymentIntentId,
            amountCents: order.awayPaidCents,
            refundedCents: 0,
            at: order.createdAt,
        });
    }
    return ledger;
};

// Refund `cents` across an away order's charges, newest first. Returns what
// was actually refunded; the caller decides what a shortfall means.
const refundAwayCharges = async (order, cents) => {
    if (!stripe || cents <= 0) return { refundedCents: 0, ledger: awayChargeLedger(order) };
    const ledger = awayChargeLedger(order);
    let remaining = cents;
    let refunded = 0;
    for (let i = ledger.length - 1; i >= 0 && remaining > 0; i--) {
        const entry = ledger[i];
        const available = Math.max(0, (entry.amountCents || 0) - (entry.refundedCents || 0));
        if (!entry.paymentIntentId || available <= 0) continue;
        const take = Math.min(available, remaining);
        try {
            await stripe.refunds.create({ payment_intent: entry.paymentIntentId, amount: take });
            entry.refundedCents = (entry.refundedCents || 0) + take;
            remaining -= take;
            refunded += take;
        } catch (err) {
            console.error(
                `Away refund failed on ${entry.paymentIntentId} for ${take}c:`,
                err.message
            );
        }
    }
    return { refundedCents: refunded, shortfallCents: cents - refunded, ledger };
};

// How many scheduled sweep slots land inside an away window (NY time).
// The single pricing truth for away "moves" orders: booking, valet
// correction, and the reconciler below all count moves this way.
const countAwayMoves = (start, end, days) => {
    const { nextNyOccurrence } = require('../services/nyTime');
    let count = 0;
    for (const day of days || []) {
        let cursor = new Date(start.getTime() + 1000);
        for (;;) {
            const occ = nextNyOccurrence(day, cursor);
            if (!occ || occ.getTime() >= end.getTime()) break;
            count++;
            cursor = new Date(occ.getTime() + 60 * 1000);
        }
    }
    return count;
};
exports.countAwayMoves = countAwayMoves;

// Away mode: set or correct the street-cleaning schedule on a live away
// order, then TRUE UP THE BILL. Built for the valet who reads the signs at
// the car — customers who aren't sure of their sweep days book unbilled,
// and whoever holds the keys fills the schedule in here. What the valet
// saves is what the customer pays: the difference against anything already
// charged is collected from the saved card (or refunded to the original
// payment). Reminders pick the new days up on the next sweep tick.
exports.setAwaySchedule = async (req, res) => {
    const { orderId, awayDays } = req.body;
    try {
        if (!orderId || !Array.isArray(awayDays)) {
            return res.status(400).json({
                success: false,
                message: 'orderId and awayDays are required',
            });
        }
        for (const d of awayDays) {
            if (
                !d ||
                !Number.isInteger(d.weekday) || d.weekday < 0 || d.weekday > 6 ||
                !Number.isInteger(d.hour) || d.hour < 0 || d.hour > 23 ||
                !Number.isInteger(d.minute) || d.minute < 0 || d.minute > 59
            ) {
                return res.status(400).json({
                    success: false,
                    message: 'each away day needs weekday 0-6, hour 0-23, minute 0-59',
                });
            }
        }

        const order = await Order.findById(orderId);
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }
        if (!order.awayMode) {
            return res.status(400).json({ success: false, message: 'Not an away order' });
        }
        if (order.awayService === 'hold') {
            return res.status(400).json({
                success: false,
                message: "This away order is a flat hold — it doesn't include street-cleaning moves.",
            });
        }
        if (['completed', 'cancelled'].includes(order.status)) {
            return res.status(400).json({ success: false, message: 'Order is closed' });
        }

        order.awayDays = awayDays.map(({ weekday, hour, minute }) => ({ weekday, hour, minute }));
        order.awayReminderLastKey = undefined;

        // ---- billing true-up (skipped for free/test and covered orders) ----
        let billing = null;
        const billable =
            !order.isFreeService &&
            !order.coveredBySubscription &&
            order.paymentStatus === 'paid';
        if (billable) {
            const PricingConfig = require('../models/PricingConfig');
            let aspCents = 1500;
            try {
                aspCents = (await PricingConfig.getSingleton()).aspCents || 1500;
            } catch (cfgErr) {
                console.error('setAwaySchedule pricing config error:', cfgErr.message);
            }
            const priceCents =
                countAwayMoves(new Date(order.pickUpTime), new Date(order.asp_time), order.awayDays) *
                aspCents;
            const paidCents = Number.isFinite(order.awayPaidCents)
                ? order.awayPaidCents
                : order.totalAmount || 0;
            const delta = priceCents - paidCents;

            if (delta === 0) {
                order.awayBilling = { status: 'settled', lastDeltaCents: 0, at: new Date() };
            } else if (delta > 0) {
                // Charge the difference to the customer's saved card.
                try {
                    if (!stripe) throw new Error('Stripe not configured');
                    const customer = await User.findById(order.customer).select('stripeCustomerId');
                    if (!customer?.stripeCustomerId) throw new Error('No saved payment method on file');
                    const pms = await stripe.paymentMethods.list({
                        customer: customer.stripeCustomerId,
                        type: 'card',
                        limit: 1,
                    });
                    if (!pms.data.length) throw new Error('No saved card on file');
                    const pi = await stripe.paymentIntents.create({
                        amount: delta,
                        currency: 'usd',
                        customer: customer.stripeCustomerId,
                        payment_method: pms.data[0].id,
                        off_session: true,
                        confirm: true,
                        description: `Away-mode street-cleaning moves (order ${order._id})`,
                        metadata: {
                            type: 'away_moves',
                            orderId: order._id.toString(),
                            customerId: String(order.customer),
                        },
                    });
                    // Ledger the balance charge alongside the deposit (seeded
                    // here on first reconciliation) so refunds can reach both.
                    const ledger = awayChargeLedger(order);
                    ledger.push({
                        paymentIntentId: pi.id,
                        amountCents: delta,
                        refundedCents: 0,
                        at: new Date(),
                    });
                    order.awayCharges = ledger;
                    order.paymentIntentId = order.paymentIntentId || pi.id;
                    order.awayPaidCents = priceCents;
                    order.totalAmount = priceCents;
                    order.awayBilling = { status: 'settled', lastDeltaCents: delta, at: new Date() };
                } catch (chargeErr) {
                    console.error('Away schedule charge failed:', chargeErr.message);
                    order.awayBilling = {
                        status: 'charge_failed',
                        lastDeltaCents: delta,
                        at: new Date(),
                        error: chargeErr.message,
                    };
                }
            } else {
                // Schedule came out cheaper than what was charged — hand the
                // difference back across the charges that took it (the
                // balance charge first, then the deposit).
                try {
                    const result = await refundAwayCharges(order, -delta);
                    order.awayCharges = result.ledger;
                    order.awayPaidCents = priceCents;
                    order.totalAmount = priceCents;
                    if (result.shortfallCents > 0 && stripe) {
                        throw new Error(
                            `only ${result.refundedCents}c of ${-delta}c could be refunded`
                        );
                    }
                    order.awayBilling = { status: 'settled', lastDeltaCents: delta, at: new Date() };
                } catch (refundErr) {
                    console.error('Away schedule refund failed:', refundErr.message);
                    order.awayBilling = {
                        status: 'refund_failed',
                        lastDeltaCents: delta,
                        at: new Date(),
                        error: refundErr.message,
                    };
                }
            }
            billing = order.awayBilling;
        }

        await order.save();

        // Tell the customer their schedule (and bill) is set — best-effort.
        try {
            const customer = await User.findById(order.customer).select('firebaseUid');
            if (customer?.firebaseUid) {
                const { sendPushNotification } = require('./notificationController');
                const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                const daysLabel = order.awayDays
                    .map((d) => `${dayNames[d.weekday]} ${d.hour}:${String(d.minute).padStart(2, '0')}`)
                    .join(', ');
                const billLine =
                    billing?.status === 'settled' && billing.lastDeltaCents > 0
                        ? ` You've been charged $${(billing.lastDeltaCents / 100).toFixed(2)}.`
                        : billing?.status === 'settled' && billing.lastDeltaCents < 0
                        ? ` $${(-billing.lastDeltaCents / 100).toFixed(2)} is on its way back to your card.`
                        : '';
                await sendPushNotification(
                    customer.firebaseUid,
                    'Sweep schedule set',
                    `Your valet set the street-cleaning schedule: ${daysLabel}.${billLine}`,
                    { orderId: String(order._id), type: 'AWAY_SCHEDULE_SET' }
                );
            }
        } catch (pushErr) {
            console.error('Away schedule push failed:', pushErr.message);
        }

        if (req.io) {
            req.io.to(String(order.customer)).emit('orderUpdated', {
                type: 'ORDER_UPDATE',
                order,
            });
        }

        res.status(200).json({ success: true, order, billing });
    } catch (err) {
        console.error('setAwaySchedule error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to set away schedule',
            error: err.message,
        });
    }
};

// Manual HTTP trigger (admin/debug); the interval in server.js is the real caller.
exports.checkAspOrders = async (req, res) => {
    try {
        const now = new Date();
        const results = await runAspSweep(req.io, now);
        res.status(200).json({
            success: true,
            message: 'ASP orders checked successfully',
            data: results,
            timestamp: now,
        });
    } catch (err) {
        console.error('ASP order check error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to check ASP orders',
            error: err.message,
        });
    }
};

// --- Cancel order (customer-initiated) ---
// Marks the order cancelled, issues a Stripe refund if payment was taken, and emits
// ORDER_CANCELLED socket events so:
//   - Other valets drop this order from their pending-orders list (global emit)
//   - The assigned valet (if any) gets kicked out of their active-order view
//   - The customer's UI clears the active-order state
exports.cancelOrder = async (req, res) => {
    const { orderId, userId } = req.body;
    try {
        if (!orderId || !userId) {
            return res.status(400).json({
                success: false,
                message: 'orderId and userId are required',
            });
        }

        const order = await Order.findById(orderId);
        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found',
            });
        }

        // Authz: only the customer who created the order can cancel it.
        if (String(order.customer) !== String(userId)) {
            return res.status(403).json({
                success: false,
                message: 'You can only cancel your own orders',
            });
        }

        // Can only cancel orders that aren't already done. Completed/cancelled orders are terminal.
        const cancellableStatuses = ['pending', 'accepted', 'in-progress', 'in_progress', 'parked'];
        if (!cancellableStatuses.includes(order.status)) {
            return res.status(400).json({
                success: false,
                message: `Cannot cancel an order that is ${order.status}`,
            });
        }

        // A retrieval stays on 'accepted' from the moment a valet takes it
        // until the car is handed back, so status alone can't tell "a valet is
        // walking over" from "a valet is driving your car". The key-handoff
        // stamp can. Once it's set, cancelling would strand a valet holding
        // keys to a car nobody is expecting back.
        if (await retrievalHasCustody(order)) {
            return res.status(400).json({
                success: false,
                code: 'RETRIEVAL_IN_CUSTODY',
                message:
                    'Your valet already has the keys and is bringing the car to you. Message or call them to sort out a change.',
            });
        }

        // Attempt Stripe refund if payment was taken. Don't block cancellation if refund fails —
        // the order should still be cancelled so the valet doesn't show up. Any failed refund
        // can be handled manually from the Stripe dashboard.
        let refundResult = null;
        if (order.paymentStatus === 'paid' && order.awayMode && stripe) {
            // Away orders can hold two charges (deposit + the balance the
            // valet's schedule triggered). Give back everything they took,
            // not just the PaymentIntent on the order.
            try {
                const owed = order.awayPaidCents ?? order.totalAmount ?? 0;
                const result = await refundAwayCharges(order, owed);
                order.awayCharges = result.ledger;
                refundResult = {
                    amount: result.refundedCents,
                    status: result.shortfallCents > 0 ? 'partial' : 'succeeded',
                };
                if (result.shortfallCents > 0) {
                    console.error(
                        'Away cancel refund short by',
                        result.shortfallCents,
                        'cents on order',
                        orderId
                    );
                }
                console.log('Away refund issued for cancelled order:', orderId, result.refundedCents);
            } catch (refundErr) {
                console.error('Away refund failed for cancelled order:', orderId, refundErr.message);
                refundResult = { error: refundErr.message };
            }
        } else if (order.paymentStatus === 'paid' && order.paymentIntentId && stripe) {
            try {
                const refund = await stripe.refunds.create({
                    payment_intent: order.paymentIntentId,
                    reason: 'requested_by_customer',
                });
                refundResult = {
                    id: refund.id,
                    amount: refund.amount,
                    status: refund.status,
                };
                console.log('Refund issued for cancelled order:', orderId, '->', refund.id);
            } catch (refundErr) {
                console.error('Refund failed for cancelled order:', orderId, refundErr.message);
                refundResult = { error: refundErr.message };
            }
        }

        // Mark cancelled
        order.status = 'cancelled';
        await order.save();

        // If this is a linked retrieval order (parking → retrieval pair), put
        // the parking order back exactly where it was so the customer can ask
        // again. Same helper the auto-cancel cron uses for stale retrievals.
        const restoredParkingOrder = await restoreParkingAfterRetrievalCancel(order);

        // Socket notifications
        const cancelledPayload = { type: 'ORDER_CANCELLED', order };
        // Global emit — any valet with this order in their pending list drops it
        req.io.emit('orderUpdated', cancelledPayload);
        // Direct emit to customer's room so their UI clears the active order
        req.io.to(String(order.customer)).emit('orderUpdated', cancelledPayload);
        // Direct emit to assigned valet's room (if any)
        if (order.valet) {
            req.io.to(String(order.valet)).emit('orderUpdated', cancelledPayload);
        }
        // Hand the customer their park back in the same breath. Without this
        // the app clears the retrieval and has nothing to show until the next
        // poll lands, which reads as "my car disappeared".
        if (restoredParkingOrder) {
            req.io
                .to(String(order.customer))
                .emit('orderUpdated', {
                    type: 'RETRIEVAL_CANCELLED_PARK_RESTORED',
                    order: restoredParkingOrder,
                });
        }

        res.status(200).json({
            success: true,
            message: 'Order cancelled successfully',
            order,
            restoredParkingOrder,
            refund: refundResult,
        });
    } catch (err) {
        console.error('Cancel order error:', err);
        res.status(500).json({
            success: false,
            message: err.message || 'Failed to cancel order',
        });
    }
};

// --- Valet cancellation -----------------------------------------------------
//
// A valet who has accepted an order can back out — but only after a cooldown
// to discourage accept-then-immediately-cancel gaming. Cooldown is the LATER of:
//   • 3 minutes after they accepted, OR
//   • 3 minutes after the order's pickUpTime (for scheduled orders)
//
// On valet cancel, the order is reset to `pending` and the assigned valet is
// cleared so other valets see it again. Customer is NOT refunded — they still
// want a valet, the platform is just re-broadcasting.
const VALET_CANCEL_COOLDOWN_MS = 3 * 60 * 1000;

exports.valetCancelOrder = async (req, res) => {
    const { orderId, valetId } = req.body;
    try {
        if (!orderId || !valetId) {
            return res.status(400).json({
                success: false,
                message: 'orderId and valetId are required',
            });
        }
        const order = await Order.findById(orderId);
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }
        // Authz: only the currently assigned valet can valet-cancel
        if (!order.valet || String(order.valet) !== String(valetId)) {
            return res.status(403).json({
                success: false,
                message: 'You are not the assigned valet for this order',
            });
        }
        // Only cancellable from accepted state — once you've parked the car etc., you can't bail
        if (order.status !== 'accepted') {
            return res.status(400).json({
                success: false,
                message: `Cannot cancel an order that is ${order.status}. Once you've started servicing, contact support.`,
            });
        }
        // Cooldown: max(acceptedAt + 3min, pickUpTime + 3min)
        const now = Date.now();
        const acceptedAt = order.acceptedAt
            ? new Date(order.acceptedAt).getTime()
            : 0;
        const pickUpTime = order.pickUpTime
            ? new Date(order.pickUpTime).getTime()
            : 0;
        const cooldownEndsAt = Math.max(
            acceptedAt + VALET_CANCEL_COOLDOWN_MS,
            pickUpTime + VALET_CANCEL_COOLDOWN_MS
        );
        if (now < cooldownEndsAt) {
            const secondsLeft = Math.ceil((cooldownEndsAt - now) / 1000);
            return res.status(400).json({
                success: false,
                message: `Please wait ${secondsLeft}s before cancelling.`,
                cooldownEndsAt,
                secondsLeft,
            });
        }

        // Reset order to pending so it re-broadcasts to other valets
        order.status = 'pending';
        order.valet = undefined;
        order.acceptedAt = undefined;
        order.acceptanceLocation = undefined;
        order.pickupDistance = undefined;
        order.valetLocation = undefined;
        order.conversationId = undefined;
        await order.save();

        // Notify everyone — valets get the new pending broadcast, customer gets an update
        if (req.io) {
            req.io.emit('newOrder', order); // re-broadcast to valets
            req.io
                .to(String(order.customer))
                .emit('orderUpdated', { type: 'VALET_RELEASED_ORDER', order });
        }

        res.status(200).json({
            success: true,
            message: 'Order released. Other valets can now accept it.',
            order,
        });
    } catch (err) {
        console.error('Valet cancel error:', err);
        res.status(500).json({
            success: false,
            message: err.message || 'Failed to release order',
        });
    }
};

// --- Auto-cancel stale pending orders ---------------------------------------
//
// Background job (called from server.js setInterval every 60s). Finds orders
// stuck in `pending` for >30 min with no valet assigned, cancels them, and
// refunds the customer if they paid. Prevents the "stuck order" issue where
// abandoned orders pollute the valet pending feed forever.
const AUTO_CANCEL_STALE_AFTER_MS = 30 * 60 * 1000; // 30 minutes

exports.autoCancelStaleOrders = async (io) => {
    try {
        const cutoff = new Date(Date.now() - AUTO_CANCEL_STALE_AFTER_MS);
        const stale = await Order.find({
            status: 'pending',
            createdAt: { $lt: cutoff },
            $or: [
                // A scheduled order (auto-ASP books ~45 min ahead; "pick a
                // time" and away bookings too) isn't stale until its pickup
                // time has also been missed by 30 minutes. Don't cancel the
                // future...
                { pickUpTime: { $lt: cutoff } },
                // ...unless it was never paid for. That's an abandoned
                // checkout whatever date it claims, and leaving it pending
                // forever would litter the customer's list.
                { paymentStatus: { $ne: 'paid' } },
            ],
        });
        if (stale.length === 0) return { cancelled: 0 };

        let cancelledCount = 0;
        for (const order of stale) {
            try {
                // Refund if paid (best-effort)
                if (
                    order.paymentStatus === 'paid' &&
                    order.paymentIntentId &&
                    stripe
                ) {
                    try {
                        await stripe.refunds.create({
                            payment_intent: order.paymentIntentId,
                            reason: 'requested_by_customer',
                        });
                        console.log(
                            'Auto-refunded stale order',
                            order._id.toString()
                        );
                    } catch (refundErr) {
                        console.error(
                            'Auto-refund failed for stale order',
                            order._id.toString(),
                            refundErr.message
                        );
                    }
                }
                order.status = 'cancelled';
                await order.save();
                cancelledCount++;

                // If a retrieval order auto-cancels, recover the linked parking
                // order so the customer / front desk can ask again. We marked
                // the parking 'completed' when retrieval was requested (for
                // Enterprise) — undo that and clear the link.
                const restoredParkingOrder =
                    await restoreParkingAfterRetrievalCancel(order);

                // Notify listeners so any open valet/customer screens drop the order
                if (io) {
                    const payload = { type: 'ORDER_CANCELLED', order };
                    io.emit('orderUpdated', payload);
                    io.to(String(order.customer)).emit('orderUpdated', payload);
                    if (restoredParkingOrder) {
                        io.to(String(order.customer)).emit('orderUpdated', {
                            type: 'RETRIEVAL_CANCELLED_PARK_RESTORED',
                            order: restoredParkingOrder,
                        });
                    }
                }
            } catch (e) {
                console.error(
                    'Auto-cancel error for order',
                    order._id.toString(),
                    e.message
                );
            }
        }
        if (cancelledCount > 0) {
            console.log(
                `Auto-cancelled ${cancelledCount} stale pending order(s) older than 30min`
            );
        }
        return { cancelled: cancelledCount };
    } catch (err) {
        console.error('autoCancelStaleOrders job error:', err.message);
        return { cancelled: 0, error: err.message };
    }
};

/**
 * POST /api/order/:orderId/key-dropoff
 * Body: { lat, lng, streetAddress, valetId }
 *
 * Captures where the valet physically took possession of the keys at
 * order start. The retrieval flow defaults its pickup pin to this
 * coordinate so customers/doormen don't have to re-enter the address.
 *
 * Idempotent — re-recording overwrites. Caller should fire this once
 * the collect-keys OTP verifies in chat.
 */
/**
 * POST /api/order/:orderId/key-return/request
 * Valet hits this after physically arriving back at the front desk
 * (or right after pressing "End parking" on park-and-hold orders).
 * Flips order to `keys-returning` and pushes the enterprise account to
 * generate an OTP.
 */
exports.requestKeyReturn = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { valetId } = req.body;

        const order = await Order.findById(orderId).populate('user');
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const orderValetId = order.valet?._id?.toString() || order.valet?.toString();
        if (!orderValetId || orderValetId !== valetId) {
            return res.status(403).json({
                success: false,
                message: 'Only the assigned valet may request key return.',
            });
        }
        if (!['parked'].includes(order.status)) {
            return res.status(400).json({
                success: false,
                message: `Order must be parked to start key return (was ${order.status}).`,
            });
        }

        order.status = 'keys-returning';
        order.keyReturn = order.keyReturn || {};
        // Reset OTP state in case this is a re-request after expiry
        order.keyReturn.otp = undefined;
        order.keyReturn.otpGeneratedAt = undefined;
        order.keyReturn.otpExpiresAt = undefined;
        order.keyReturn.otpAttempts = 0;
        await order.save();

        // Push the enterprise/front-desk account that owns this order to
        // generate the OTP from their app. user = the order creator
        // (enterprise account holder for enterprise orders).
        if (order.user?.firebaseUid) {
            try {
                const { sendPushNotification } = require('./notificationController');
                await sendPushNotification(
                    order.user.firebaseUid,
                    'Keys returning',
                    'Driver is returning keys — open the order to share the pickup code.',
                    {
                        type: 'KEY_RETURN_REQUESTED',
                        orderId: order._id.toString(),
                    }
                );
            } catch (pushErr) {
                console.warn(
                    `key-return push to front desk failed: ${pushErr.message}`
                );
            }
        }

        return res.json({ success: true, status: order.status });
    } catch (err) {
        console.error('requestKeyReturn error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to start key return.',
        });
    }
};

/**
 * POST /api/order/:orderId/key-return/generate-otp
 * Front-desk / enterprise account generates the OTP. Returns the plain
 * 4-digit code to the caller. The valet never sees it via the API —
 * they receive it from the human across the counter.
 *
 * Body: { generatedById }  (the user generating, usually the order's
 * enterprise account holder; not strictly enforced — any authenticated
 * user can in principle hit this, but we record who).
 */
exports.generateKeyReturnOtp = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { generatedById } = req.body || {};

        const order = await Order.findById(orderId);
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }
        if (order.status !== 'keys-returning') {
            return res.status(400).json({
                success: false,
                message: `Order is not in key-return state (was ${order.status}).`,
            });
        }

        const otp = String(Math.floor(1000 + Math.random() * 9000));
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15 min

        order.keyReturn = order.keyReturn || {};
        order.keyReturn.otp = otp;
        order.keyReturn.otpGeneratedAt = now;
        order.keyReturn.otpExpiresAt = expiresAt;
        order.keyReturn.otpAttempts = 0;
        if (generatedById) order.keyReturn.generatedBy = generatedById;
        await order.save();

        return res.json({
            success: true,
            otp,
            expiresAt,
        });
    } catch (err) {
        console.error('generateKeyReturnOtp error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to generate OTP.',
        });
    }
};

/**
 * POST /api/order/:orderId/key-return/verify-otp
 * Valet submits the OTP the front desk just shared. If it matches and
 * isn't expired, order → `completed` and the key handoff is recorded.
 *
 * Body: { valetId, otp }
 */
exports.verifyKeyReturnOtp = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { valetId, otp } = req.body || {};

        if (!otp || typeof otp !== 'string') {
            return res.status(400).json({
                success: false,
                message: 'OTP is required.',
            });
        }

        const order = await Order.findById(orderId);
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const orderValetId = order.valet?._id?.toString() || order.valet?.toString();
        if (!orderValetId || orderValetId !== valetId) {
            return res.status(403).json({
                success: false,
                message: 'Only the assigned valet may verify key return.',
            });
        }
        if (order.status !== 'keys-returning') {
            return res.status(400).json({
                success: false,
                message: `Order is not in key-return state (was ${order.status}).`,
            });
        }
        if (!order.keyReturn?.otp) {
            return res.status(400).json({
                success: false,
                message: 'No OTP has been generated yet — ask the front desk to generate one.',
            });
        }
        if (order.keyReturn.otpExpiresAt && order.keyReturn.otpExpiresAt < new Date()) {
            return res.status(400).json({
                success: false,
                message: 'OTP expired. Ask the front desk to generate a new one.',
            });
        }
        if ((order.keyReturn.otpAttempts || 0) >= 5) {
            return res.status(400).json({
                success: false,
                message: 'Too many incorrect attempts. Ask the front desk for a new OTP.',
            });
        }

        if (order.keyReturn.otp !== otp.trim()) {
            order.keyReturn.otpAttempts = (order.keyReturn.otpAttempts || 0) + 1;
            await order.save();
            return res.status(400).json({
                success: false,
                message: 'OTP did not match.',
                attemptsRemaining: 5 - order.keyReturn.otpAttempts,
            });
        }

        order.status = 'completed';
        order.keyReturn.completedAt = new Date();
        order.keyReturn.verifiedBy = valetId;
        // Clear the OTP so it's no longer usable
        order.keyReturn.otp = undefined;
        await order.save();

        return res.json({
            success: true,
            status: order.status,
            completedAt: order.keyReturn.completedAt,
        });
    } catch (err) {
        console.error('verifyKeyReturnOtp error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to verify OTP.',
        });
    }
};

exports.recordKeyDropoff = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { lat, lng, streetAddress, valetId } = req.body;

        if (
            !orderId ||
            !valetId ||
            typeof lat !== 'number' ||
            typeof lng !== 'number'
        ) {
            return res.status(400).json({
                success: false,
                message: 'orderId, valetId, lat, and lng are required.',
            });
        }

        const order = await Order.findById(orderId);
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const orderValetId = order.valet?._id?.toString() || order.valet?.toString();
        if (orderValetId && orderValetId !== valetId) {
            return res.status(403).json({
                success: false,
                message: 'Only the assigned valet on this order may record the key-drop-off.',
            });
        }

        order.keyDropoffLocation = {
            lat,
            lng,
            streetAddress: streetAddress || '',
            recordedAt: new Date(),
        };
        await order.save();

        return res.json({
            success: true,
            keyDropoffLocation: order.keyDropoffLocation,
        });
    } catch (err) {
        console.error('recordKeyDropoff error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to record key drop-off location.',
        });
    }
};

//


// --- Park & Retrieve: cancel only the prepaid return trip -------------------
//
// A Park & Retrieve order is ONE document. The customer pays $13 up front:
// $10 buys the park, $3 buys the trip back. Until they ask for the car, that
// $3 is unspent money — the parking valet was already credited
// (totalAmount - $3) x 70% the moment they finished parking, and a retrieval
// valet is only ever credited when a retrieval order of their own reaches
// 'completed'. So calling the return off refunds cleanly: nobody has to give
// anything back.
//
// The refund is PARTIAL and is issued against this order's own PaymentIntent —
// a linked retrieval order never has one of its own (createRetrievalOrder
// writes it isFreeService with totalAmount 300 purely so the retrieval valet's
// 70% can be computed later).
//
// What this deliberately does NOT touch: totalAmount, serviceType,
// paymentStatus. Both clients subtract the retrieval portion from a
// park-and-hold total to print the parking receipt and to size tip presets, and
// iOS drops the keys-held ticket from home the moment paymentStatus stops being
// 'paid'. The refund lives in its own field instead.
//
// The order does move from 'parked' to 'completed'. That is what ends the
// parking-reminder pushes (services/parkingAlerts.js only looks at 'parked'),
// and it is why the client has to tell the customer they'll stop hearing about
// the car before they tap.
exports.cancelRetrievalLeg = async (req, res) => {
    const { orderId } = req.params;
    const { userId } = req.body || {};
    try {
        if (!orderId || !userId) {
            return res.status(400).json({
                success: false,
                message: 'orderId and userId are required',
            });
        }

        const order = await Order.findById(orderId);
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        // Same authz as cancelOrder: the customer on the order, by id.
        if (String(order.customer) !== String(userId)) {
            return res.status(403).json({
                success: false,
                message: 'You can only change your own orders',
            });
        }

        if (order.orderType !== 'parking' || order.serviceType !== 'park-and-hold') {
            return res.status(400).json({
                success: false,
                message: "This order doesn't include a return trip.",
            });
        }

        // An ASP move is priced as one flat service, not two legs.
        if (order.aspMode) {
            return res.status(400).json({
                success: false,
                message: "A street-cleaning move can't drop its return trip.",
            });
        }

        if (order.retrievalCancelled) {
            return res.status(400).json({
                success: false,
                message: 'The return trip was already cancelled.',
            });
        }

        // Only once the car is actually parked. Before that the whole order is
        // still cancellable through /cancelOrder for the full amount.
        const cancellableFrom = ['parked'];
        if (!cancellableFrom.includes(order.status)) {
            return res.status(400).json({
                success: false,
                message: `Cannot cancel the return trip on an order that is ${order.status}`,
            });
        }

        // ...and only once the VALET has closed the park out. Between parking
        // the car and walking the keys back they are still working the job, and
        // finishing this leg moves the order to 'completed' — which takes it off
        // their screen mid-task and leaves nobody able to move it. Same shape as
        // the lockout on 2026-08-11. Until they close out, the customer's route
        // is /cancelOrder, which refunds the whole thing.
        if (!order.parkClosedAt) {
            return res.status(400).json({
                success: false,
                code: 'PARK_NOT_CLOSED',
                message:
                    'Your valet is still finishing up. You can do this once they have handed your keys back.',
            });
        }

        // If the car was already requested back, the return can only be called
        // off while the valet still hasn't taken the keys.
        let liveRetrieval = null;
        if (order.linkedOrderId) {
            const child = await Order.findById(order.linkedOrderId);
            if (child && child.status === 'completed') {
                return res.status(400).json({
                    success: false,
                    message: 'Your car has already been brought back.',
                });
            }
            if (child && child.status !== 'cancelled') {
                const keysCollected = !!(child.otpVerifiedTimes && child.otpVerifiedTimes.returnKey);
                if (keysCollected || !['pending', 'accepted'].includes(child.status)) {
                    return res.status(400).json({
                        success: false,
                        message: 'Your car is already on its way back — call your valet if you need to stop it.',
                    });
                }
                liveRetrieval = child;
            }
        }

        // What the return leg is worth. Prices are dashboard-editable, so read
        // the live config rather than trusting the $3 hardcoded in the create
        // path, and never refund into the parking half: a legacy $10
        // park-and-hold order never paid for a return, so it gets nothing back.
        let portionCents = 300;
        let parkingCents = null;
        try {
            const PricingConfig = require('../models/PricingConfig');
            const cfg = await PricingConfig.getSingleton();
            const spread = Math.round(Number(cfg.parkAndRetrieveCents) - Number(cfg.parkingCents));
            if (Number.isFinite(spread) && spread > 0) {
                portionCents = spread;
            }
            const park = Math.round(Number(cfg.parkingCents));
            if (Number.isFinite(park) && park >= 0) {
                parkingCents = park;
            }
        } catch (cfgErr) {
            console.error('cancelRetrievalLeg: pricing config unavailable, using $3 -', cfgErr.message);
        }

        const total = Number(order.totalAmount) || 0;
        const headroom = parkingCents === null ? total : Math.max(0, total - parkingCents);
        const refundCents = Math.max(0, Math.min(portionCents, headroom));
        console.log(
            'cancelRetrievalLeg:', String(order._id),
            'total', total, 'portion', portionCents, 'headroom', headroom, 'refund', refundCents
        );

        // Claim the cancellation before touching Stripe, so a double-tap can't
        // issue two refunds. Nothing else in this codebase records a refund, so
        // this flag IS the idempotency guard.
        const claimed = await Order.findOneAndUpdate(
            { _id: order._id, retrievalCancelled: { $ne: true } },
            { $set: { retrievalCancelled: true, retrievalCancelledAt: new Date() } },
            { new: true }
        );
        if (!claimed) {
            return res.status(400).json({
                success: false,
                message: 'The return trip was already cancelled.',
            });
        }

        let refundInfo = { amountCents: 0, status: 'not_applicable' };
        const chargeable =
            refundCents > 0 &&
            !order.isFreeService &&
            order.paymentStatus === 'paid' &&
            !!order.paymentIntentId &&
            !!stripe;

        if (chargeable) {
            try {
                const refund = await stripe.refunds.create({
                    payment_intent: order.paymentIntentId,
                    amount: refundCents,
                    reason: 'requested_by_customer',
                    metadata: { orderId: String(order._id), leg: 'retrieval' },
                });
                refundInfo = {
                    amountCents: refund.amount,
                    refundId: refund.id,
                    status: refund.status,
                    refundedAt: new Date(),
                };
                console.log('Retrieval leg refunded:', String(order._id), '->', refund.id, refund.amount);
            } catch (refundErr) {
                // Unlike cancelOrder, a failed refund here is fatal: the whole
                // point of the action is the money. Put the order back exactly
                // as it was and let the customer try again.
                console.error('cancelRetrievalLeg refund failed:', String(order._id), refundErr.message);
                await Order.findByIdAndUpdate(order._id, {
                    $set: { retrievalCancelled: false },
                    $unset: { retrievalCancelledAt: '' },
                });
                return res.status(502).json({
                    success: false,
                    message: "We couldn't refund the return trip, so nothing was changed. Try again in a moment.",
                });
            }
        }

        // Stand down a retrieval that was already requested. No valet has been
        // credited for it — that only happens at 'completed' — so cancelling it
        // costs nobody anything.
        if (liveRetrieval) {
            try {
                liveRetrieval.status = 'cancelled';
                await liveRetrieval.save();
                if (req.io) {
                    const standDown = { type: 'ORDER_CANCELLED', order: liveRetrieval };
                    req.io.emit('orderUpdated', standDown);
                    req.io.to(String(liveRetrieval.customer)).emit('orderUpdated', standDown);
                    if (liveRetrieval.valet) {
                        req.io.to(String(liveRetrieval.valet)).emit('orderUpdated', standDown);
                    }
                }
            } catch (childErr) {
                console.error('cancelRetrievalLeg: failed to stand down retrieval', childErr.message);
            }
        }

        // The parking half is done and paid for, so the order closes. The
        // linkedOrderId is kept as a record of the retrieval that was called
        // off; 'completed' already keeps the ASP cron and the alert service
        // away from this order.
        const finished = await Order.findByIdAndUpdate(
            order._id,
            { $set: { status: 'completed', retrievalRefund: refundInfo } },
            { new: true }
        );

        if (req.io) {
            const payload = { ...finished.toObject(), type: 'RETRIEVAL_CANCELLED' };
            req.io.to(String(finished.customer)).emit('orderUpdated', payload);
            if (finished.valet) {
                req.io.to(String(finished.valet)).emit('orderUpdated', payload);
            }
        }

        return res.status(200).json({
            success: true,
            message: refundInfo.amountCents
                ? 'Return trip cancelled and refunded.'
                : 'Return trip cancelled.',
            order: finished,
            refund: refundInfo,
        });
    } catch (err) {
        console.error('cancelRetrievalLeg error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to cancel the return trip',
        });
    }
};
