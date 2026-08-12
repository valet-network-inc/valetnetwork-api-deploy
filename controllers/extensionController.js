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
 * POST /api/order/:orderId/extend
 * Body: { additionalHours, requestedBy? }
 */
exports.createExtensionIntent = async (req, res) => {
    try {
        if (!stripe) {
            return res.status(500).json({
                success: false,
                message: 'Stripe is not configured.',
            });
        }

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
        if (!stripe) {
            return res.status(500).json({
                success: false,
                message: 'Stripe is not configured.',
            });
        }

        const { orderId } = req.params;
        const { paymentIntentId, requestedBy } = req.body;

        if (!orderId || !paymentIntentId) {
            return res.status(400).json({
                success: false,
                message: 'orderId and paymentIntentId are required.',
            });
        }

        const order = await Order.findById(orderId).populate('valet', 'firebaseUid firstName');
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
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
        if (order.valet?.firebaseUid) {
            try {
                await sendPushNotification(
                    order.valet.firebaseUid,
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
        }

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
