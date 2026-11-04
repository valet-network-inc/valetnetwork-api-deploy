/**
 * extensionController
 *
 * Customer-initiated parking-duration extensions. Pricing tier:
 *   - First additional hour: $5
 *   - Each additional hour after that: +$1
 *   (24h extension = $5 + 23×$1 = $28)
 *
 * Two-phase flow so the existing PaymentSheet machinery is reused
 * unchanged on mobile:
 *
 *   1. POST /api/order/:orderId/extend
 *      Creates a Stripe PaymentIntent for the extension cost (separate
 *      from the original parking PaymentIntent which is already captured).
 *      Returns clientSecret + ephemeralKey + amountCents so the mobile
 *      PaymentSheet can render with saved cards.
 *
 *   2. POST /api/order/:orderId/extend/confirm
 *      Mobile calls this once PaymentSheet reports success. We retrieve
 *      the PaymentIntent from Stripe to verify it's actually `succeeded`
 *      (don't trust the client), then bump order.duration and push the
 *      assigned valet. Idempotent — re-applying the same paymentIntentId
 *      is a no-op.
 *
 * Both customer and Enterprise/doorman accounts use these endpoints; the
 * difference is purely UI surface (where the "Extend" button lives).
 *
 * A park the plan already paid for takes neither phase. This file had no
 * reference to subscriptions at all, so a customer on the $250 plan — whose
 * park was created $0 by `evaluateParkCoverage` — was billed $5 for the first
 * extra hour on a car we are already holding for them under a flat monthly
 * fee. That is money taken for something already paid for. `coveredByPlan`
 * below is now the first question both phases ask.
 *
 * A linked partner (models/AccountLink.js) can extend a park the other one
 * booked, and the extension goes on the BOOKER's card — money follows the
 * park, whoever tapped. That one takes neither phase either: it is charged
 * off-session on the booker's saved card and applied at once, so the booker's
 * cards never appear on the partner's phone. See `resolveCaller`.
 */

const stripeModule = require('stripe');
const stripe = process.env.STRIPE_API_KEY
    ? stripeModule(process.env.STRIPE_API_KEY)
    : null;

const Order = require('../models/Order');
const User = require('../models/User');
const giftBalance = require('../services/giftBalance');
const { sendPushNotification } = require('./notificationController');
const { callerFirebaseUid } = require('../middleware/requireSelf');
const { partnerIdOf } = require('../services/accountLinks');

const ACTIVE_STATUSES = ['accepted', 'in-progress', 'in_progress', 'parked'];

// Pricing in cents. Centralized so a future tier change happens in one place.
const calcExtensionCents = (additionalHours) => {
    const h = Math.max(1, Math.floor(additionalHours));
    return 500 + (h - 1) * 100;
};

/**
 * Did a subscription pay for this park?
 *
 * Read off the stamp, never by re-asking the coverage question. `coveredBySubscription`
 * is written once at creation by the single coverage decision in
 * services/subscriptionService.evaluateParkCoverage, and the answer to that
 * question has already changed by the time we get here — the park itself spent
 * the customer's free park for the day, so asking again returns
 * 'daily_free_park_used' and we would charge for the extension of an order we
 * gave away an hour ago. The stamp is the record of what we actually charged
 * for THIS order, which is the only thing that decides whether more of it costs
 * anything.
 *
 * True for a covered street-cleaning move on the $50/$100 tier too. That tier's
 * ordinary parks and retrievals stay full price — this is not about tiers, it is
 * about an order we already handed over for nothing.
 */
const coveredByPlan = (order) => !!(order && order.coveredBySubscription);

// A park with no end time has nothing to extend. Distinct from covered: a
// SECOND park of the day is paid for and still indefinite, so keying this on
// coverage would sell an hour on a park that never ends.
const hasNoEndTime = (order) => !!order.indefinite;

/**
 * Tell the assigned valet the car is staying longer.
 *
 * Non-fatal by design — the duration is already saved by the time this runs.
 * Takes the valet from the document when it is populated and looks it up when
 * it is not, so both phases can use it without changing what either one
 * populates.
 */
const pushValetExtension = async (order, additionalHours) => {
    try {
        let valet = order.valet;
        if (valet && !valet.firebaseUid) {
            valet = await User.findById(valet).select('firebaseUid');
        }
        if (!valet || !valet.firebaseUid) return;

        await sendPushNotification(
            valet.firebaseUid,
            'Customer extended parking',
            `+${additionalHours}h. New end time updated.`,
            {
                orderId: String(order._id),
                purpose: 'extension',
                additionalHours: String(additionalHours),
            }
        );
    } catch (err) {
        console.error('extension valet push failed:', err.message);
    }
};

/**
 * Who is asking for the time, as far as the request can prove it.
 *
 * These routes have never asked. The shipped iOS app calls them with raw
 * `fetch` and no token (services/extensionService.js), so gating them would
 * take "add more time" off every phone in the field — and for the person who
 * booked the park, nothing changes here: an unproven caller is answered exactly
 * as before, on their own saved cards.
 *
 * A linked partner is different, because money follows the park. An extension
 * on a park the OTHER one booked goes on the booker's card, and the normal
 * answer would hand the partner's phone the booker's Stripe customer and an
 * ephemeral key — their saved cards, on somebody else's screen. So a partner
 * is charged off-session on the booker's saved card instead (the way a tip
 * is), and that only happens for a caller whose token proves they are that
 * partner. `requestedBy` naming the partner without a token is a claim, not a
 * proof, and it moves nobody's money.
 *
 *   { kind: 'owner' }                     — proven, or unproven as today
 *   { kind: 'partner', callerId }         — proven linked partner
 *   { kind: 'unproven_partner' }          — names the partner, proves nothing
 *
 * Never throws; a failed lookup reads as the old, unproven answer.
 */
async function resolveCaller(req, order) {
    const ownerId = String((order.customer && order.customer._id) || order.customer);
    const named = req.body && req.body.requestedBy ? String(req.body.requestedBy) : null;
    try {
        const partnerId = await partnerIdOf(ownerId);
        if (!partnerId) return { kind: 'owner' };

        const uid = await callerFirebaseUid(req);
        if (uid) {
            const partner = await User.findById(partnerId).select('firebaseUid').lean();
            if (partner && partner.firebaseUid && partner.firebaseUid === uid) {
                return { kind: 'partner', callerId: partnerId };
            }
            const owner = await User.findById(ownerId).select('firebaseUid').lean();
            if (owner && owner.firebaseUid && owner.firebaseUid === uid) {
                return { kind: 'owner' };
            }
        }
        if (named && named === partnerId) return { kind: 'unproven_partner' };
        return { kind: 'owner' };
    } catch (err) {
        console.error('extension: caller lookup failed:', err.message);
        return { kind: 'owner' };
    }
}

/**
 * The partner's extension: charged off-session to the BOOKER's saved card and
 * applied on the spot, so there is no PaymentSheet (and no second phase) on the
 * partner's phone. Answers with no clientSecret — both clients already read
 * that as "nothing left to pay here", and `applied` as "the time is on".
 */
async function extendForPartner({ order, hours, callerId, res }) {
    const booker = order.customer;
    const bookerName = ((booker && booker.firstName) || '').trim();
    // "Sam's" / "Their" — the start of a sentence either way.
    const theirs = bookerName ? `${bookerName}'s` : 'Their';
    const noCard = bookerName
        ? `${bookerName} has no card saved. Time on their park goes on their card.`
        : 'They have no card saved. Time on their park goes on their card.';

    if (!booker || !booker.stripeCustomerId) {
        return res.status(400).json({ success: false, message: noCard });
    }
    const methods = await stripe.paymentMethods.list({
        customer: booker.stripeCustomerId,
        type: 'card',
        limit: 1,
    });
    if (!methods.data.length) {
        return res.status(400).json({ success: false, message: noCard });
    }

    const amountCents = calcExtensionCents(hours);
    let intent;
    try {
        intent = await stripe.paymentIntents.create(
            {
                amount: amountCents,
                currency: 'usd',
                customer: booker.stripeCustomerId,
                payment_method: methods.data[0].id,
                off_session: true,
                confirm: true,
                description: `Parking extension (order ${order._id})`,
                // `purpose: 'extension'` is what keeps the Stripe webhook from
                // writing this charge over the order's own payment
                // (paymentController.handleStripeWebhook).
                metadata: {
                    orderId: String(order._id),
                    customerId: String(booker._id),
                    purpose: 'extension',
                    additionalHours: String(hours),
                    requestedBy: String(callerId),
                    actedBy: String(callerId),
                },
            },
            // There is no PaymentSheet between the tap and the charge here, so
            // nothing stops a double tap except this: the same partner asking
            // for the same hours on the same park inside one minute is the
            // same charge, and Stripe answers the second with the first.
            {
                idempotencyKey: `extension-${order._id}-${callerId}-${hours}-${Math.floor(
                    Date.now() / 60000
                )}`,
            }
        );
    } catch (stripeErr) {
        // The booker's bank wants a challenge. Their 3-D Secure prompt does
        // not belong on the partner's phone, so nothing is charged and the
        // partner is told who can finish it.
        if (stripeErr.code === 'authentication_required') {
            const strandedId = stripeErr.raw && stripeErr.raw.payment_intent && stripeErr.raw.payment_intent.id;
            if (strandedId) {
                try {
                    await stripe.paymentIntents.cancel(strandedId);
                } catch (cancelErr) {
                    console.error('extension: could not cancel the unconfirmed intent', strandedId, cancelErr.message);
                }
            }
            return res.status(402).json({
                success: false,
                message: `${theirs} bank wants them to approve this. Ask them to add the time from their phone.`,
            });
        }
        console.error('extension: partner charge failed:', stripeErr.message);
        return res.status(402).json({
            success: false,
            message: stripeErr.message || 'Payment failed',
        });
    }

    if (intent.status !== 'succeeded') {
        // Off-session and confirmed in one call, so anything else is a
        // charge that did not land. Do not add time we were not paid for.
        return res.status(402).json({
            success: false,
            message: `${theirs} card didn't go through. Ask them to add the time from their phone.`,
        });
    }

    const charged = intent.amount_received || intent.amount || amountCents;
    // Applied once per intent, atomically: a double tap that Stripe answered
    // with the same intent must not add the hours twice.
    const applied = await Order.findOneAndUpdate(
        { _id: order._id, 'extensions.paymentIntentId': { $ne: intent.id } },
        {
            $inc: { duration: hours * 60 },
            $push: {
                extensions: {
                    additionalHours: hours,
                    amountCents: charged,
                    paymentIntentId: intent.id,
                    chargedAt: new Date(),
                    requestedBy: callerId,
                },
            },
            // Audit only. The order, the charge and the receipt stay the booker's.
            $set: { actedBy: callerId },
        },
        { new: true }
    );
    const current = applied || (await Order.findById(order._id));

    if (applied) await pushValetExtension(applied, hours);

    return res.json({
        success: true,
        covered: false,
        charged: true,
        applied: true,
        ...(applied ? {} : { alreadyApplied: true }),
        amountCents: charged,
        additionalHours: hours,
        newDurationMinutes: current.duration,
        // The ledger without its PaymentIntent ids: those charges are the
        // booker's, and no Stripe id of one reaches the other.
        extensions: (current.extensions || []).map((e) => {
            const { paymentIntentId, ...row } = typeof e.toObject === 'function' ? e.toObject() : e;
            return row;
        }),
        // Printed verbatim by both clients, like the covered answer's.
        message: bookerName
            ? `Time added. It went on ${bookerName}'s card.`
            : 'Time added. It went on their card.',
    });
}

/**
 * POST /api/order/:orderId/extend
 * Body: { additionalHours, requestedBy? }
 */
exports.createExtensionIntent = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { additionalHours, requestedBy } = req.body;
        const hours = Number(additionalHours);

        if (!orderId || !Number.isFinite(hours) || hours < 1) {
            return res.status(400).json({
                success: false,
                message: 'orderId and a positive additionalHours are required.',
            });
        }

        const order = await Order.findById(orderId).populate('customer');
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }
        if (!ACTIVE_STATUSES.includes(order.status)) {
            return res.status(400).json({
                success: false,
                message: `Cannot extend an order with status '${order.status}'.`,
            });
        }
        if (order.orderType === 'retrieval') {
            return res.status(400).json({
                success: false,
                message: 'Extensions apply to parking orders, not retrieval orders.',
            });
        }

        // Covered park: give the time, take no money, skip Stripe entirely.
        //
        // On the $250 and $300 plans the valet keeps the keys and holds the car
        // until the customer asks for it, so there is no expiry to buy off. The
        // one thing `duration` still drives on such an order is the "your park
        // is ending soon" nudge (services/parkingAlerts.js), and moving that is
        // exactly what a customer tapping "add more time" is asking for.
        //
        // The alternative was refusing the request as meaningless. It loses on
        // both counts: the customer's actual intent — stop nudging me, keep the
        // car — goes unserved, and a 400 hands every client an error banner for
        // something that is simply free. So the request is honoured and costs
        // nothing.
        //
        // Applied here rather than in the confirm phase because there is no
        // PaymentIntent to confirm. A client that calls confirm anyway is
        // answered from the saved state (see confirmExtension).
        // A park with no end time cannot be extended, because it never ends.
        // Answered as success so no client draws an error banner over a
        // non-problem, and no money moves.
        if (hasNoEndTime(order)) {
            return res.json({
                success: true,
                covered: true,
                charged: false,
                applied: false,
                amountCents: 0,
                indefinite: true,
                message: 'Your plan parks this car until you ask for it back. There is no time to add.',
            });
        }

        // Owner or linked partner — see resolveCaller. Asked once, here,
        // because both the free answer below and the paid one record it.
        const caller = await resolveCaller(req, order);

        if (coveredByPlan(order)) {
            order.duration = (order.duration || 0) + hours * 60;
            // Ownership gate widened for the linked partner: audit who added
            // the time when it was not the booker. Nothing is charged here.
            if (caller.kind === 'partner') order.actedBy = caller.callerId;
            await order.save();

            // No `extensions` row is written. That array is the ledger of
            // extension CHARGES — every row requires a paymentIntentId
            // (models/Order.js) — and nothing was charged.
            await pushValetExtension(order, hours);

            return res.json({
                success: true,
                covered: true,
                charged: false,
                applied: true,
                amountCents: 0,
                additionalHours: hours,
                newDurationMinutes: order.duration,
                // Printed verbatim. One wording so three clients cannot invent
                // three, and no number, because there is nothing to pay.
                message: 'Your plan covers this. Nothing to pay.',
            });
        }

        if (!stripe) {
            return res.status(500).json({
                success: false,
                message: 'Stripe is not configured.',
            });
        }

        // Money follows the park: a partner's extension goes on the booker's
        // saved card, charged here, never through a PaymentSheet on the
        // partner's phone. Someone merely NAMING the partner gets nothing —
        // not the booker's Stripe customer, not an off-session charge.
        if (caller.kind === 'unproven_partner') {
            return res.status(401).json({
                success: false,
                message: 'Sign in again to continue.',
            });
        }
        if (caller.kind === 'partner') {
            return extendForPartner({ order, hours, callerId: caller.callerId, res });
        }

        // Ensure Stripe customer exists (mirrors createPaymentIntent flow).
        let stripeCustomerId = order.customer.stripeCustomerId;
        if (!stripeCustomerId) {
            const newStripeCustomer = await stripe.customers.create({
                metadata: {
                    userId: order.customer._id.toString(),
                    phone: order.customer.phone || '',
                },
                name:
                    [order.customer.firstName, order.customer.lastName]
                        .filter(Boolean)
                        .join(' ') ||
                    order.customer.establishmentName ||
                    undefined,
                phone: order.customer.phone || undefined,
            });
            stripeCustomerId = newStripeCustomer.id;
            await User.findByIdAndUpdate(order.customer._id, { stripeCustomerId });
        }

        const amountCents = calcExtensionCents(hours);
        // Gift card money pays first. An extension it covers in full is
        // applied now with nothing to pay, the same as a plan-covered one; one
        // it covers in part leaves the rest for the card, and the gift part is
        // taken once that payment is confirmed.
        const gift = await giftBalance.giftFor(order.customer._id);
        if (gift.cents >= amountCents) {
            const before = order.duration || 0;
            const extended = await Order.findOneAndUpdate(
                { _id: order._id, duration: order.duration },
                { $set: { duration: before + hours * 60 } },
                { new: true }
            );
            if (extended) {
                const tag = `ext-${before}-${hours}`;
                const taken = await giftBalance.takeGift(extended, amountCents, tag);
                if (taken === amountCents) {
                    order.duration = extended.duration;
                    await pushValetExtension(order, hours);
                    return res.json({
                        success: true,
                        covered: true,
                        charged: false,
                        applied: true,
                        amountCents: 0,
                        giftCents: taken,
                        additionalHours: hours,
                        newDurationMinutes: extended.duration,
                        message: 'Your gift card paid for this. Nothing to pay.',
                    });
                }
                // The balance moved under us: undo it, and the card pays.
                if (taken > 0) await giftBalance.giveBack(extended, taken, `${tag}-undo`);
                await Order.updateOne({ _id: order._id, duration: extended.duration }, { $set: { duration: before } });
            }
        }
        const giftCents = Math.max(0, Math.min(gift.cents, amountCents - giftBalance.MIN_CARD_CENTS));
        const cardCents = amountCents - giftCents;

        const ephemeralKey = await stripe.ephemeralKeys.create(
            { customer: stripeCustomerId },
            { apiVersion: '2024-06-20' }
        );

        const paymentIntent = await stripe.paymentIntents.create({
            amount: cardCents,
            currency: 'usd',
            automatic_payment_methods: { enabled: true },
            customer: stripeCustomerId,
            setup_future_usage: 'off_session',
            metadata: {
                orderId: String(orderId),
                customerId: order.customer._id.toString(),
                purpose: 'extension',
                additionalHours: String(hours),
                giftCents: String(giftCents),
                requestedBy: requestedBy ? String(requestedBy) : '',
            },
        });

        return res.json({
            success: true,
            paymentIntentId: paymentIntent.id,
            clientSecret: paymentIntent.client_secret,
            customerId: stripeCustomerId,
            customerEphemeralKeySecret: ephemeralKey.secret,
            amountCents: cardCents,
            giftCents,
            additionalHours: hours,
        });
    } catch (err) {
        console.error('createExtensionIntent error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to create extension PaymentIntent.',
        });
    }
};

/**
 * POST /api/order/:orderId/extend/confirm
 * Body: { paymentIntentId, requestedBy? }
 *
 * Verifies the PaymentIntent succeeded server-side, then bumps duration,
 * records the extension on the order, and pushes the assigned valet.
 */
exports.confirmExtension = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { paymentIntentId, requestedBy } = req.body;

        if (!orderId) {
            return res.status(400).json({
                success: false,
                message: 'orderId and paymentIntentId are required.',
            });
        }

        const order = await Order.findById(orderId).populate('valet', 'firebaseUid firstName');
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        // Covered park: the create phase already applied the time and never
        // minted a PaymentIntent, so there is nothing to verify and nothing to
        // charge. Answer from the saved state rather than reaching for Stripe —
        // a client walking the normal two-phase flow ends up here whether or not
        // it read `covered` on the first response.
        if (coveredByPlan(order)) {
            return res.json({
                success: true,
                covered: true,
                charged: false,
                applied: true,
                alreadyApplied: true,
                newDurationMinutes: order.duration,
                extensions: order.extensions,
                message: 'Your plan covers this. Nothing to pay.',
            });
        }

        if (!paymentIntentId) {
            return res.status(400).json({
                success: false,
                message: 'orderId and paymentIntentId are required.',
            });
        }

        if (!stripe) {
            return res.status(500).json({
                success: false,
                message: 'Stripe is not configured.',
            });
        }

        // Idempotency — if we've already applied this exact PaymentIntent,
        // return the current state as success rather than double-extending.
        const alreadyApplied = (order.extensions || []).some(
            (e) => e.paymentIntentId === paymentIntentId
        );
        if (alreadyApplied) {
            return res.json({
                success: true,
                applied: true,
                alreadyApplied: true,
                newDurationMinutes: order.duration,
                extensions: order.extensions,
            });
        }

        const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (intent.status !== 'succeeded') {
            return res.status(400).json({
                success: false,
                message: `PaymentIntent status is '${intent.status}', not 'succeeded'.`,
            });
        }
        if (intent.metadata?.orderId !== String(orderId)) {
            return res.status(400).json({
                success: false,
                message: 'PaymentIntent does not belong to this order.',
            });
        }
        if (intent.metadata?.purpose !== 'extension') {
            return res.status(400).json({
                success: false,
                message: 'PaymentIntent was not created for an extension.',
            });
        }

        const additionalHours = Math.max(
            1,
            parseInt(intent.metadata.additionalHours || '1', 10)
        );
        const amountCents = intent.amount_received || intent.amount || 0;

        // The gift card part of a partly covered extension is taken now that
        // the card part has gone through.
        const giftCents = Number(intent.metadata.giftCents) || 0;
        if (giftCents > 0) await giftBalance.takeGift(order, giftCents, `ext-${intent.id}`);
        order.duration = (order.duration || 0) + additionalHours * 60;
        order.extensions.push({
            additionalHours,
            amountCents,
            paymentIntentId,
            chargedAt: new Date(),
            requestedBy: requestedBy || undefined,
        });
        await order.save();

        // Push the assigned valet so they know the customer just bought
        // more time. Non-fatal if it fails — the duration is already saved.
        await pushValetExtension(order, additionalHours);

        return res.json({
            success: true,
            applied: true,
            newDurationMinutes: order.duration,
            extensions: order.extensions,
        });
    } catch (err) {
        console.error('confirmExtension error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to confirm extension.',
        });
    }
};
