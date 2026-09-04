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
 */

const stripeModule = require('stripe');
const stripe = process.env.STRIPE_API_KEY
    ? stripeModule(process.env.STRIPE_API_KEY)
    : null;

const Order = require('../models/Order');
const User = require('../models/User');
const { sendPushNotification } = require('./notificationController');

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

        if (coveredByPlan(order)) {
            order.duration = (order.duration || 0) + hours * 60;
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

        const ephemeralKey = await stripe.ephemeralKeys.create(
            { customer: stripeCustomerId },
            { apiVersion: '2024-06-20' }
        );

        const paymentIntent = await stripe.paymentIntents.create({
            amount: amountCents,
            currency: 'usd',
            automatic_payment_methods: { enabled: true },
            customer: stripeCustomerId,
            setup_future_usage: 'off_session',
            metadata: {
                orderId: String(orderId),
                customerId: order.customer._id.toString(),
                purpose: 'extension',
                additionalHours: String(hours),
                requestedBy: requestedBy ? String(requestedBy) : '',
            },
        });

        return res.json({
            success: true,
            paymentIntentId: paymentIntent.id,
            clientSecret: paymentIntent.client_secret,
            customerId: stripeCustomerId,
            customerEphemeralKeySecret: ephemeralKey.secret,
            amountCents,
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
