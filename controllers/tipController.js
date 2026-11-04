/**
 * tipController
 *
 * Customer-paid tips for valets, 100% pass-through.
 *
 * Flow:
 *   1. Customer (mobile) sends amount (cents), optional percentagePreset, optional context.
 *   2. Backend validates the order is tip-eligible (not cancelled, has a valet).
 *   3. Backend creates an off-session PaymentIntent on the customer's saved card.
 *      (Customer already authorized it during the order — same card is
 *      reusable for the tip without re-prompting.)
 *   4. On Stripe success: Tip record created, valet's currentBalance and
 *      totalEarnings credited with the NET amount (gross minus Stripe fee).
 *   5. On 3DS-required: returns clientSecret so mobile can finish the
 *      authentication via Stripe SDK.
 *
 * Stripe fee math: standard US rate of 2.9% + 30¢ per transaction.
 * Borne by the valet (deducted from gross before crediting), not VNI —
 * keeps the platform fully hands-off the contractor's compensation.
 */

const dotenv = require('dotenv');
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });

const mongoose = require('mongoose');
const stripeModule = require('stripe');
const stripe = process.env.STRIPE_API_KEY ? stripeModule(process.env.STRIPE_API_KEY) : null;

const Tip = require('../models/Tip');
const Order = require('../models/Order');
const User = require('../models/User');

// US Stripe pricing (as of 2026): 2.9% + 30¢ per successful card charge.
// Encoded here so it's easy to update if pricing changes.
const STRIPE_FEE_PERCENT = 0.029;
const STRIPE_FEE_FLAT_CENTS = 30;

const calculateStripeFee = (amountCents) =>
    Math.round(amountCents * STRIPE_FEE_PERCENT) + STRIPE_FEE_FLAT_CENTS;

// Order statuses where tipping is allowed. Tipping is blocked for orders
// that haven't been picked up yet (no valet assigned) or have been
// cancelled/refunded.
const TIP_ELIGIBLE_STATUSES = [
    'accepted',
    'in-progress',
    'in_progress',
    'parked',
    'completed',
];

const VALID_CONTEXTS = [
    'during_park',
    'after_park',
    'during_retrieve',
    'after_retrieve',
    'post_completion',
    'general',
];

const VALID_PRESETS = [15, 20, 25];

// Sanity bounds — customer can't tip $0 or more than $500 in a single tap.
const MIN_TIP_CENTS = 100;     // $1
const MAX_TIP_CENTS = 50000;   // $500

/**
 * POST /api/order/:orderId/tip
 * Body: { amountCents, percentagePreset?, context? }
 *
 * Returns:
 *   - { success: true, tip, requiresAction: false }            on instant success
 *   - { success: true, tip, requiresAction: true, clientSecret } when 3DS is needed
 *   - { success: false, message }                               on validation/Stripe failure
 */
exports.createTip = async (req, res) => {
    try {
        if (!stripe) {
            return res.status(503).json({ success: false, message: 'Payments not configured' });
        }

        const { orderId } = req.params;
        const { amountCents, percentagePreset, context } = req.body;

        // -- Validation
        if (!Number.isInteger(amountCents) || amountCents < MIN_TIP_CENTS || amountCents > MAX_TIP_CENTS) {
            return res.status(400).json({
                success: false,
                message: `Tip amount must be between $${MIN_TIP_CENTS / 100} and $${MAX_TIP_CENTS / 100} (in cents).`,
            });
        }
        if (percentagePreset !== undefined && percentagePreset !== null && !VALID_PRESETS.includes(percentagePreset)) {
            return res.status(400).json({
                success: false,
                message: `percentagePreset must be one of: ${VALID_PRESETS.join(', ')}, or null for custom`,
            });
        }
        if (context && !VALID_CONTEXTS.includes(context)) {
            return res.status(400).json({
                success: false,
                message: `context must be one of: ${VALID_CONTEXTS.join(', ')}`,
            });
        }
        if (!mongoose.Types.ObjectId.isValid(orderId)) {
            return res.status(400).json({ success: false, message: 'Invalid orderId' });
        }

        // -- Load order + check eligibility
        const order = await Order.findById(orderId)
            .populate('customer')
            .populate('valet');
        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }
        if (!order.valet) {
            return res.status(400).json({
                success: false,
                message: 'Order has not been accepted by a valet yet — nothing to tip.',
            });
        }
        if (!TIP_ELIGIBLE_STATUSES.includes(order.status)) {
            return res.status(400).json({
                success: false,
                message: `Order in status '${order.status}' cannot be tipped.`,
            });
        }
        // Money follows the park. A linked partner (routes/order.js mounts
        // requireOrderOwner, which lets them through) may tip on a park the
        // other one booked, and the tip still goes on the BOOKER's card —
        // `order.customer`, never the caller. `byPartner` only changes what we
        // say and what we record, never whose card is charged.
        const ownerId = String(order.customer._id);
        const callerId = req.callerUserId ? String(req.callerUserId) : ownerId;
        const byPartner = callerId !== ownerId;
        const ownerFirstName = (order.customer.firstName || '').trim();
        const partnerNoCard = ownerFirstName
            ? `${ownerFirstName} has no card saved. A tip on their park goes on their card.`
            : 'They have no card saved. A tip on their park goes on their card.';

        if (!order.customer.stripeCustomerId) {
            return res.status(400).json({
                success: false,
                message: byPartner
                    ? partnerNoCard
                    : 'No saved payment method on file for this customer.',
            });
        }

        // -- Resolve a default payment method for off-session charging
        const paymentMethods = await stripe.paymentMethods.list({
            customer: order.customer.stripeCustomerId,
            type: 'card',
            limit: 1,
        });
        if (!paymentMethods.data.length) {
            return res.status(400).json({
                success: false,
                message: byPartner
                    ? partnerNoCard
                    : 'No saved card for this customer — please add one in the order flow first.',
            });
        }
        const paymentMethodId = paymentMethods.data[0].id;

        // -- Create + confirm the PaymentIntent off-session
        let paymentIntent;
        try {
            paymentIntent = await stripe.paymentIntents.create({
                amount: amountCents,
                currency: 'usd',
                customer: order.customer.stripeCustomerId,
                payment_method: paymentMethodId,
                off_session: true,
                confirm: true,
                description: `Tip for valet (order ${orderId})`,
                metadata: {
                    type: 'tip',
                    orderId,
                    valetId: order.valet._id.toString(),
                    customerId: order.customer._id.toString(),
                    percentagePreset: percentagePreset ?? '',
                    context: context || 'general',
                    // Audit only: who tapped, when it was not the booker.
                    ...(byPartner ? { actedBy: callerId } : {}),
                },
            });
        } catch (stripeErr) {
            // The booker's bank wants a challenge, and the partner is holding
            // the phone. Handing them the intent's client secret would put a
            // 3-D Secure prompt for somebody else's card on their screen — the
            // one thing a linked pair never shares. The intent is left
            // unconfirmed (nothing is charged) and they are told who can
            // finish it.
            if (byPartner && stripeErr.code === 'authentication_required') {
                const strandedId = stripeErr.raw?.payment_intent?.id;
                if (strandedId) {
                    try {
                        await stripe.paymentIntents.cancel(strandedId);
                    } catch (cancelErr) {
                        console.error('Tip: could not cancel the unconfirmed intent', strandedId, cancelErr.message);
                    }
                }
                return res.status(402).json({
                    success: false,
                    requiresAction: false,
                    message: `${ownerFirstName ? `${ownerFirstName}'s` : 'Their'} bank wants them to approve this. Ask them to tip from their phone.`,
                });
            }
            // Card requires 3DS / authentication — return clientSecret so
            // mobile can use the Stripe SDK to complete the challenge.
            if (stripeErr.code === 'authentication_required' && stripeErr.raw?.payment_intent?.client_secret) {
                return res.json({
                    success: false,
                    requiresAction: true,
                    clientSecret: stripeErr.raw.payment_intent.client_secret,
                    message: 'Customer must complete card authentication.',
                });
            }
            console.error('Tip PaymentIntent failed:', stripeErr.message);
            return res.status(402).json({
                success: false,
                message: stripeErr.message || 'Payment failed',
            });
        }

        // -- Compute Stripe fee + valet's net
        const stripeFee = calculateStripeFee(amountCents);
        const amountNet = amountCents - stripeFee;

        // -- Create the Tip record
        const tip = await Tip.create({
            order: orderId,
            customer: order.customer._id,
            valet: order.valet._id,
            amountGross: amountCents,
            stripeFee,
            amountNet,
            percentagePreset: percentagePreset ?? null,
            context: context || 'general',
            paymentIntentId: paymentIntent.id,
            chargeId: paymentIntent.latest_charge,
            currency: 'usd',
            status: paymentIntent.status === 'succeeded' ? 'succeeded' : 'pending',
        });

        // -- Credit the valet's TIP counters (only on confirmed success)
        // Tips intentionally do NOT increment currentBalance or totalEarnings —
        // those track BASE earnings only. The earnings card displays:
        //    Total available  = currentBalance + currentTipsBalance
        //    Earnings         = currentBalance
        //    Tips             = currentTipsBalance
        //    Lifetime total   = totalEarnings + totalTips
        // Keeping the columns separate here prevents double-counting and
        // makes "tips received" a clean, auditable number.
        if (paymentIntent.status === 'succeeded') {
            await User.findByIdAndUpdate(order.valet._id, {
                $inc: {
                    currentTipsBalance: amountNet,
                    totalTips: amountNet,
                },
            });
        }

        // Ownership-adjacent audit: the linked partner tipped on the booker's
        // park. The order, the Tip row and the charge all stay the booker's.
        if (byPartner) {
            try {
                await Order.updateOne({ _id: order._id }, { $set: { actedBy: callerId } });
            } catch (stampErr) {
                console.error('Tip: actedBy stamp failed:', stampErr.message);
            }
        }

        return res.json({
            success: true,
            requiresAction: false,
            tip: {
                id: tip._id,
                amountGross: tip.amountGross,
                stripeFee: tip.stripeFee,
                amountNet: tip.amountNet,
                status: tip.status,
                percentagePreset: tip.percentagePreset,
                context: tip.context,
            },
        });
    } catch (err) {
        console.error('createTip error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * GET /api/valet/tips?limit=<n>
 * Returns the calling valet's tip history (newest first).
 *
 * Auth note: matches existing valet route pattern — caller passes valetId
 * via query param. Replace with a proper auth middleware later.
 */
exports.getValetTips = async (req, res) => {
    try {
        const { valetId } = req.query;
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

        if (!valetId) {
            return res.status(400).json({ success: false, message: 'valetId is required' });
        }

        const tips = await Tip
            .find({ valet: valetId, status: 'succeeded' })
            .sort({ createdAt: -1 })
            .limit(limit)
            .populate('order', 'orderType status createdAt')
            .lean();

        // Aggregate stats
        const totalReceivedCents = tips.reduce((sum, t) => sum + (t.amountNet || 0), 0);

        return res.json({
            success: true,
            totalReceivedCents,
            tipCount: tips.length,
            tips: tips.map((t) => ({
                id: t._id,
                amountGross: t.amountGross,
                stripeFee: t.stripeFee,
                amountNet: t.amountNet,
                percentagePreset: t.percentagePreset,
                context: t.context,
                status: t.status,
                receivedAt: t.createdAt,
                order: t.order
                    ? { id: t.order._id, orderType: t.order.orderType, status: t.order.status }
                    : null,
            })),
        });
    } catch (err) {
        console.error('getValetTips error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * GET /api/order/:orderId/tips
 * Returns all tips for one order (used by mobile to display "you've tipped
 * $X on this order so far").
 */
exports.getOrderTips = async (req, res) => {
    try {
        const { orderId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(orderId)) {
            return res.status(400).json({ success: false, message: 'Invalid orderId' });
        }

        const tips = await Tip
            .find({ order: orderId, status: 'succeeded' })
            .sort({ createdAt: -1 })
            .lean();

        const totalGrossCents = tips.reduce((sum, t) => sum + (t.amountGross || 0), 0);

        return res.json({
            success: true,
            totalGrossCents,
            tipCount: tips.length,
            tips: tips.map((t) => ({
                id: t._id,
                amountGross: t.amountGross,
                amountNet: t.amountNet,
                percentagePreset: t.percentagePreset,
                context: t.context,
                receivedAt: t.createdAt,
            })),
        });
    } catch (err) {
        console.error('getOrderTips error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};
