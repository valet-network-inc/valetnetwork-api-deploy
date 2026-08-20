// Subscriptions v2 (2026-08-14): Stripe Billing recurring plans.
//
// Purchase flow (mobile PaymentSheet):
//   POST /create  → Stripe subscription with payment_behavior
//                   'default_incomplete' + expand latest_invoice.payment_intent
//                   (stripe-node v17 / acacia — no confirmation_secret here),
//                   returns the PaymentSheet trio. The local doc sits
//                   'incomplete' until the first invoice settles.
//   webhook invoice.paid → doc flips 'active', user.activeSubscription set.
//   The app polls GET /status/:userId until it sees active.
//
// Cancel keeps the period the customer paid for: cancel_at_period_end on
// Stripe, local flag mirrored, entitlements run to period end, then the
// customer.subscription.deleted webhook closes it out. After that they simply
// pay per-use again.
//
// This file replaced the pre-v2 doorman-referral system (manual off-session
// renewals via an open /process-billing endpoint). None of that survives.

const dotenv = require('dotenv');
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });
const Subscription = require('../models/Subscription');
const { adoptFromSubscription } = require('../services/cleaningSchedule');
const User = require('../models/User');
const Order = require('../models/Order');
const stripeModule = require('stripe');
const stripe = process.env.STRIPE_API_KEY ? stripeModule(process.env.STRIPE_API_KEY) : null;
const { PLANS, getPlan, priceFor , SUSPENSION_GUARANTEE } = require('../services/subscriptionPlans');
const {
    isEntitled,
    buildStatusPayload,
} = require('../services/subscriptionService');
const { nyClock } = require('../services/nyTime');

// Must match the version paymentController/extensionController use — the
// mobile PaymentSheet's saved-card listing breaks on a mismatch.
const EPHEMERAL_KEY_API_VERSION = '2024-06-20';

// Resolved lookup_key → Stripe price id, cached for the process lifetime
// (prices are immutable; a catalog change redeploys anyway).
const priceIdCache = new Map();

async function resolvePriceId(lookupKey) {
    if (priceIdCache.has(lookupKey)) return priceIdCache.get(lookupKey);
    const prices = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
    if (!prices.data.length || !prices.data[0].active) {
        throw new Error(`Stripe price not found for lookup key ${lookupKey}`);
    }
    priceIdCache.set(lookupKey, prices.data[0].id);
    return prices.data[0].id;
}

function validateAspSchedule(aspSchedule) {
    if (!aspSchedule || typeof aspSchedule !== 'object') return 'aspSchedule is required';
    const a = aspSchedule.address;
    if (!a || typeof a.lat !== 'number' || typeof a.lng !== 'number' || !a.streetAddress) {
        return 'aspSchedule.address needs streetAddress, lat and lng';
    }
    const days = aspSchedule.days;
    if (!Array.isArray(days) || days.length < 1 || days.length > 2) {
        return 'aspSchedule.days needs 1 or 2 entries';
    }
    for (const d of days) {
        if (
            !d ||
            !Number.isInteger(d.weekday) || d.weekday < 0 || d.weekday > 6 ||
            !Number.isInteger(d.hour) || d.hour < 0 || d.hour > 23 ||
            !Number.isInteger(d.minute) || d.minute < 0 || d.minute > 59
        ) {
            return 'each schedule day needs weekday 0-6, hour 0-23, minute 0-59';
        }
    }
    return null;
}

function validateAddress(addr, label) {
    if (!addr || typeof addr.lat !== 'number' || typeof addr.lng !== 'number' || !addr.streetAddress) {
        return `${label} needs streetAddress, lat and lng`;
    }
    return null;
}

async function ensureStripeCustomer(user) {
    if (user.stripeCustomerId) {
        try {
            const existing = await stripe.customers.retrieve(user.stripeCustomerId);
            if (!existing.deleted) return user.stripeCustomerId;
        } catch (err) {
            // Stale id (test→live switch etc.) — fall through and recreate.
            console.log('Stripe customer', user.stripeCustomerId, 'not retrievable, recreating');
        }
    }
    const created = await stripe.customers.create({
        metadata: { userId: user._id.toString(), phone: user.phone || '' },
        name: [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined,
        phone: user.phone || undefined,
    });
    await User.findByIdAndUpdate(user._id, { stripeCustomerId: created.id });
    return created.id;
}

// GET /api/subscription/plans
exports.getPlans = async (req, res) => {
    const plans = Object.values(PLANS)
        .sort((a, b) => a.rank - b.rank)
        .map((p) => ({
            tier: p.tier,
            name: p.name,
            blurb: p.blurb,
            features: p.features,
            // Per-move plans are bought with quantity = moves/week (1-2);
            // amounts here are PER MOVE for those.
            perMove: !!p.perMove,
            weekly: { amountCents: p.weekly.amountCents },
            monthly: { amountCents: p.monthly.amountCents },
            // $30/wk ≈ $130/mo vs $100/mo — same ratio on every tier.
            monthlySavesPct: 23,
        }));
    res.status(200).json({
        success: true,
        plans,
        suspensionGuarantee: SUSPENSION_GUARANTEE,

        cancelPolicy:
            'Cancel anytime — you are refunded for services not rendered, priced at regular per-park rates.',
    });
};

// Resolve the Stripe item config + local amount for a plan choice.
// street_cleaning is priced per weekly move (quantity 1-2); other tiers are
// flat (quantity 1).
async function resolvePlanPurchase(tier, interval, movesPerWeek) {
    const plan = getPlan(tier);
    const price = priceFor(tier, interval);
    if (!plan || !price) return null;
    const quantity = plan.perMove ? (movesPerWeek === 1 ? 1 : 2) : 1;
    const priceId = await resolvePriceId(price.lookupKey);
    return {
        plan,
        quantity,
        priceId,
        amountCents: price.amountCents * quantity,
        movesPerWeek: plan.perMove ? quantity : 2,
    };
}

// POST /api/subscription/create
// { userId, tier, interval, movesPerWeek?, aspSchedule, homeAddress?, promoCode? }
exports.createSubscription = async (req, res) => {
    const { userId, tier, interval, aspSchedule, homeAddress, promoCode, movesPerWeek } = req.body;

    try {
        if (!stripe) {
            return res.status(503).json({
                success: false,
                message: 'Stripe API key not configured. Payment service unavailable.',
            });
        }
        if (!userId || !tier || !interval) {
            return res.status(400).json({ success: false, message: 'userId, tier and interval are required' });
        }
        const purchase = await resolvePlanPurchase(tier, interval, movesPerWeek);
        if (!purchase) {
            return res.status(400).json({ success: false, message: 'Unknown tier or interval' });
        }

        const scheduleError = validateAspSchedule(aspSchedule);
        if (scheduleError) {
            return res.status(400).json({ success: false, message: scheduleError });
        }
        if (aspSchedule.days.length > purchase.movesPerWeek) {
            return res.status(400).json({
                success: false,
                message: `Your plan covers ${purchase.movesPerWeek} move${purchase.movesPerWeek === 1 ? '' : 's'} a week — pick at most that many days.`,
            });
        }
        if (tier === 'home_garage') {
            const homeError = validateAddress(homeAddress, 'homeAddress');
            if (homeError) return res.status(400).json({ success: false, message: homeError });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const existing = await Subscription.findOne({
            user: userId,
            status: { $in: ['active', 'past_due'] },
        });
        if (existing) {
            return res.status(400).json({
                success: false,
                message: 'You already have a subscription. Manage it from your profile.',
            });
        }

        // A previous abandoned purchase leaves an 'incomplete' doc + Stripe
        // subscription. Void it so the retry starts clean.
        const abandoned = await Subscription.find({ user: userId, status: 'incomplete' });
        for (const old of abandoned) {
            if (old.stripeSubscriptionId) {
                try {
                    await stripe.subscriptions.cancel(old.stripeSubscriptionId);
                } catch (err) {
                    // Already canceled/expired on Stripe's side — fine.
                }
            }
            old.status = 'cancelled';
            old.cancelledAt = new Date();
            await old.save();
        }

        const stripeCustomerId = await ensureStripeCustomer(user);
        const priceId = purchase.priceId;

        // Test/promo hook: a promo code matching the env-configured value
        // attaches its coupon (e.g. a 100%-off coupon for E2E runs against
        // live mode). Invalid codes are rejected, not ignored.
        let discounts;
        if (promoCode) {
            const configured = (process.env.SUB_PROMO_CODES || '')
                .split(',')
                .map((pair) => pair.trim().split(':'))
                .filter((pair) => pair.length === 2);
            const match = configured.find(
                ([code]) => code.toUpperCase() === String(promoCode).toUpperCase()
            );
            if (!match) {
                return res.status(400).json({ success: false, message: 'Invalid promo code' });
            }
            discounts = [{ coupon: match[1] }];
        }

        const stripeSub = await stripe.subscriptions.create({
            customer: stripeCustomerId,
            items: [{ price: priceId, quantity: purchase.quantity }],
            payment_behavior: 'default_incomplete',
            payment_settings: {
                save_default_payment_method: 'on_subscription',
            },
            ...(discounts ? { discounts } : {}),
            metadata: { userId: user._id.toString(), tier, interval },
            expand: ['latest_invoice.payment_intent'],
        });

        const sub = new Subscription({
            user: user._id,
            tier,
            interval,
            status: 'incomplete',
            amountCents: purchase.amountCents,
            movesPerWeek: purchase.movesPerWeek,
            stripeCustomerId,
            stripeSubscriptionId: stripeSub.id,
            stripePriceId: priceId,
            currentPeriodStart: stripeSub.current_period_start
                ? new Date(stripeSub.current_period_start * 1000)
                : undefined,
            currentPeriodEnd: stripeSub.current_period_end
                ? new Date(stripeSub.current_period_end * 1000)
                : undefined,
            aspSchedule: { ...aspSchedule, source: aspSchedule.source || 'onboarding' },
            ...(homeAddress ? { homeAddress } : {}),
        });
        await sub.save();

        // The schedule belongs to the person, not to the plan. Someone who
        // subscribes without ever touching the home screen still ends up with
        // a free street-cleaning alarm on the same days — and it keeps firing
        // if they later cancel.
        await adoptFromSubscription(userId, sub.aspSchedule);

        const invoice = stripeSub.latest_invoice;
        const paymentIntent = invoice && typeof invoice === 'object' ? invoice.payment_intent : null;

        // A fully-discounted (or otherwise $0) first invoice settles with no
        // PaymentIntent and the subscription is already active — no sheet to
        // present. Activate locally right away rather than waiting on the
        // webhook.
        if (!paymentIntent) {
            if (stripeSub.status === 'active' || stripeSub.status === 'trialing') {
                await activateLocal(sub, invoice && typeof invoice === 'object' ? invoice : null, stripeSub);
                return res.status(201).json({
                    success: true,
                    status: 'active',
                    noPaymentNeeded: true,
                    subscription: await buildStatusPayload(sub),
                });
            }
            return res.status(500).json({
                success: false,
                message: `Subscription created but no payment intent available (status ${stripeSub.status})`,
            });
        }

        const ephemeralKey = await stripe.ephemeralKeys.create(
            { customer: stripeCustomerId },
            { apiVersion: EPHEMERAL_KEY_API_VERSION }
        );

        res.status(201).json({
            success: true,
            status: 'incomplete',
            subscriptionId: sub._id,
            stripeSubscriptionId: stripeSub.id,
            clientSecret: paymentIntent.client_secret,
            customerId: stripeCustomerId,
            customerEphemeralKeySecret: ephemeralKey.secret,
            amountCents: purchase.amountCents,
        });
    } catch (err) {
        console.error('createSubscription error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to create subscription',
            error: err.message,
        });
    }
};

// GET /api/subscription/status/:userId
exports.getSubscriptionStatus = async (req, res) => {
    const { userId } = req.params;
    try {
        const sub = await Subscription.findOne({
            user: userId,
            status: { $in: ['active', 'past_due', 'incomplete'] },
        }).sort({ createdAt: -1 });

        if (!sub) {
            return res.status(200).json({
                success: true,
                hasActiveSubscription: false,
                subscription: null,
            });
        }

        // An incomplete doc can be waiting on webhook delivery — reconcile
        // against Stripe so the post-purchase poll converges fast.
        if (sub.status === 'incomplete' && stripe && sub.stripeSubscriptionId) {
            try {
                const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
                if (stripeSub.status === 'active' || stripeSub.status === 'trialing') {
                    await activateLocal(sub, null, stripeSub);
                } else if (['canceled', 'incomplete_expired'].includes(stripeSub.status)) {
                    sub.status = 'cancelled';
                    sub.cancelledAt = new Date();
                    await sub.save();
                }
            } catch (err) {
                console.error('status reconcile error:', err.message);
            }
        }

        if (!['active', 'past_due'].includes(sub.status)) {
            return res.status(200).json({
                success: true,
                hasActiveSubscription: false,
                subscription: null,
            });
        }

        res.status(200).json({
            success: true,
            hasActiveSubscription: isEntitled(sub),
            subscription: await buildStatusPayload(sub),
        });
    } catch (err) {
        console.error('getSubscriptionStatus error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to get subscription status',
            error: err.message,
        });
    }
};

// Usage inside the current billing period, priced at per-use rates.
async function periodUsageCents(sub) {
    const agg = await Order.aggregate([
        {
            $match: {
                coveredBySubscription: sub._id,
                status: { $ne: 'cancelled' },
                ...(sub.currentPeriodStart ? { createdAt: { $gte: sub.currentPeriodStart } } : {}),
            },
        },
        { $group: { _id: null, cents: { $sum: { $ifNull: ['$listPriceCents', 0] } } } },
    ]);
    return agg.length ? agg[0].cents : 0;
}

// POST /api/subscription/cancel  { userId }
//
// Cancel is IMMEDIATE and refunds services not rendered: the customer keeps
// paying only for what they actually used, priced at per-use rates, and the
// rest of the period's payment goes back to their card. ($300 plan, 5 daily
// park-and-retrievals used, cancel → $65 kept, $235 refunded.)
exports.cancelSubscription = async (req, res) => {
    const { userId } = req.body;
    try {
        const sub = await Subscription.findOne({
            user: userId,
            status: { $in: ['active', 'past_due'] },
        });
        if (!sub) {
            return res.status(404).json({ success: false, message: 'No subscription to cancel' });
        }

        const usedCents = await periodUsageCents(sub);
        const paidCents = sub.amountCents || 0;
        const refundCents = Math.max(0, Math.min(paidCents, paidCents - usedCents));

        let refund = { requestedCents: refundCents, status: 'none' };
        if (stripe && sub.stripeSubscriptionId) {
            // Refund against the period's paid invoice, then cancel at Stripe.
            if (refundCents > 0) {
                try {
                    const invoices = await stripe.invoices.list({
                        subscription: sub.stripeSubscriptionId,
                        status: 'paid',
                        limit: 1,
                    });
                    const inv = invoices.data[0];
                    const piId =
                        inv &&
                        (typeof inv.payment_intent === 'string'
                            ? inv.payment_intent
                            : inv.payment_intent?.id);
                    if (piId && (inv.amount_paid || 0) >= refundCents) {
                        await stripe.refunds.create({ payment_intent: piId, amount: refundCents });
                        refund.status = 'refunded';
                    } else if ((inv?.amount_paid || 0) === 0) {
                        // Promo/$0 period — nothing was paid, nothing to refund.
                        refund = { requestedCents: 0, status: 'none' };
                    } else {
                        refund.status = 'failed';
                        refund.error = 'No refundable payment found for this period';
                    }
                } catch (refundErr) {
                    console.error('Cancel refund failed:', refundErr.message);
                    refund.status = 'failed';
                    refund.error = refundErr.message;
                }
            }
            try {
                await stripe.subscriptions.cancel(sub.stripeSubscriptionId);
            } catch (cancelErr) {
                // Already canceled at Stripe is fine; anything else is logged
                // but the local cancel still proceeds (webhook would confirm).
                console.error('Stripe cancel error:', cancelErr.message);
            }
        }

        sub.status = 'cancelled';
        sub.cancelledAt = new Date();
        await sub.save();
        await User.findOneAndUpdate(
            { _id: sub.user, activeSubscription: sub._id },
            { $unset: { activeSubscription: 1 } }
        );

        res.status(200).json({
            success: true,
            message:
                refund.status === 'refunded'
                    ? `Cancelled — $${(refundCents / 100).toFixed(2)} is on its way back to your card.`
                    : 'Cancelled. You pay regular rates per park from now on.',
            usedCents,
            refund,
        });
    } catch (err) {
        console.error('cancelSubscription error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to cancel subscription',
            error: err.message,
        });
    }
};

// POST /api/subscription/change  { userId, tier, interval, movesPerWeek?, homeAddress? }
//
// Seamless upgrade/downgrade: swaps the Stripe price in place with immediate
// proration (the saved card is charged or credited the difference), then
// mirrors the new plan locally. No new payment sheet needed.
exports.changePlan = async (req, res) => {
    const { userId, tier, interval, movesPerWeek, homeAddress } = req.body;
    try {
        if (!stripe) {
            return res.status(503).json({ success: false, message: 'Payment service unavailable' });
        }
        const sub = await Subscription.findOne({
            user: userId,
            status: { $in: ['active', 'past_due'] },
        });
        if (!sub) {
            return res.status(404).json({ success: false, message: 'No subscription to change' });
        }

        const purchase = await resolvePlanPurchase(
            tier || sub.tier,
            interval || sub.interval,
            movesPerWeek ?? sub.movesPerWeek
        );
        if (!purchase) {
            return res.status(400).json({ success: false, message: 'Unknown tier or interval' });
        }

        // Moving into Fixed garage needs the fixed spot.
        const targetTier = tier || sub.tier;
        if (targetTier === 'home_garage' && !sub.homeAddress?.streetAddress && !homeAddress) {
            const homeError = validateAddress(homeAddress, 'homeAddress');
            return res.status(400).json({ success: false, message: homeError });
        }
        if (homeAddress) {
            const homeError = validateAddress(homeAddress, 'homeAddress');
            if (homeError) return res.status(400).json({ success: false, message: homeError });
        }
        // Schedule can't exceed the new plan's weekly moves.
        if ((sub.aspSchedule?.days?.length || 0) > purchase.movesPerWeek) {
            return res.status(400).json({
                success: false,
                message: `Your schedule has ${sub.aspSchedule.days.length} days but the new plan covers ${purchase.movesPerWeek}/week — trim the schedule first.`,
            });
        }

        const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
        const itemId = stripeSub.items.data[0].id;
        const updated = await stripe.subscriptions.update(sub.stripeSubscriptionId, {
            items: [{ id: itemId, price: purchase.priceId, quantity: purchase.quantity }],
            proration_behavior: 'always_invoice',
            payment_behavior: 'allow_incomplete',
            metadata: { userId: String(sub.user), tier: targetTier, interval: interval || sub.interval },
        });

        sub.tier = targetTier;
        sub.interval = interval || sub.interval;
        sub.amountCents = purchase.amountCents;
        sub.movesPerWeek = purchase.movesPerWeek;
        sub.stripePriceId = purchase.priceId;
        if (homeAddress) {
            sub.homeAddress = homeAddress;
            sub.homeAddressChangedAt = sub.homeAddressChangedAt || new Date();
        }
        if (updated.current_period_end) {
            sub.currentPeriodEnd = new Date(updated.current_period_end * 1000);
        }
        if (updated.current_period_start) {
            sub.currentPeriodStart = new Date(updated.current_period_start * 1000);
        }
        await sub.save();

        res.status(200).json({
            success: true,
            message: 'Plan updated — the difference is settled on your card automatically.',
            subscription: await buildStatusPayload(sub),
        });
    } catch (err) {
        console.error('changePlan error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to change plan',
            error: err.message,
        });
    }
};

// PUT /api/subscription/schedule  { userId, aspSchedule?, homeAddress? }
exports.updateSchedule = async (req, res) => {
    const { userId, aspSchedule, homeAddress } = req.body;
    try {
        const sub = await Subscription.findOne({
            user: userId,
            status: { $in: ['active', 'past_due'] },
        });
        if (!sub) {
            return res.status(404).json({ success: false, message: 'No subscription found' });
        }

        if (aspSchedule) {
            const scheduleError = validateAspSchedule(aspSchedule);
            if (scheduleError) {
                return res.status(400).json({ success: false, message: scheduleError });
            }
            const cap = sub.movesPerWeek || 2;
            if (aspSchedule.days.length > cap) {
                return res.status(400).json({
                    success: false,
                    message: `Your plan covers ${cap} move${cap === 1 ? '' : 's'} a week — pick at most that many days.`,
                });
            }
            sub.aspSchedule = { ...aspSchedule, source: 'edited' };
            // Same record, edited from the other end.
            await adoptFromSubscription(userId, sub.aspSchedule);
        }
        if (homeAddress) {
            const homeError = validateAddress(homeAddress, 'homeAddress');
            if (homeError) return res.status(400).json({ success: false, message: homeError });
            // The Fixed garage spot moves once every 30 days — that's the
            // deal. First set is free; each change starts the clock.
            const changed =
                sub.homeAddress?.streetAddress &&
                (sub.homeAddress.streetAddress !== homeAddress.streetAddress ||
                    sub.homeAddress.lat !== homeAddress.lat);
            if (changed) {
                const lockUntil = sub.homeAddressChangedAt
                    ? sub.homeAddressChangedAt.getTime() + 30 * 24 * 60 * 60 * 1000
                    : 0;
                if (Date.now() < lockUntil) {
                    const days = Math.ceil((lockUntil - Date.now()) / (24 * 60 * 60 * 1000));
                    return res.status(400).json({
                        success: false,
                        message: `Your fixed spot can change once a month — next change in ${days} day${days === 1 ? '' : 's'}.`,
                    });
                }
                sub.homeAddressChangedAt = new Date();
            }
            sub.homeAddress = homeAddress;
        }
        await sub.save();

        res.status(200).json({
            success: true,
            subscription: await buildStatusPayload(sub),
        });
    } catch (err) {
        console.error('updateSchedule error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to update schedule',
            error: err.message,
        });
    }
};

// GET /api/subscription/prefill/:userId
// Seed the onboarding form so the subscription wizard's days step arrives
// pre-answered.
//
// The customer's own cleaning schedule is the answer whenever it exists —
// they set it on the home screen and it is the same record the scheduler
// books against, so the wizard should be confirming it rather than asking
// again. Guessing from an old booking is now only the fallback for someone
// who has never set one.
exports.getPrefill = async (req, res) => {
    const { userId } = req.params;
    try {
        const owner = await User.findById(userId).select('cleaningSchedule').lean();
        const cs = owner && owner.cleaningSchedule;
        if (cs && (cs.days || []).length && cs.address) {
            return res.status(200).json({
                success: true,
                prefill: {
                    address: cs.address,
                    // `day` kept for the existing app build, which reads a
                    // single day; `days` is the full schedule.
                    day: cs.days[0],
                    days: cs.days,
                    reminderLeadMin: cs.reminderLeadMin ?? 60,
                    source: 'cleaning_schedule',
                },
            });
        }

        const lastAsp = await Order.findOne({
            customer: userId,
            aspMode: true,
            orderType: 'parking',
            autoBookKey: { $exists: false }, // manual bookings only
        }).sort({ createdAt: -1 });

        if (!lastAsp) {
            return res.status(200).json({ success: true, prefill: null });
        }

        const c = nyClock(new Date(lastAsp.pickUpTime));
        res.status(200).json({
            success: true,
            prefill: {
                address: lastAsp.customerLocation,
                day: { weekday: c.weekday, hour: c.hour, minute: c.minute },
                source: 'first_booking',
            },
        });
    } catch (err) {
        console.error('getPrefill error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to load prefill',
            error: err.message,
        });
    }
};

// ---------------------------------------------------------------------------
// Webhook appliers — called from paymentController.handleStripeWebhook with
// an already-verified event. Idempotent: replaying an event converges on the
// same state.
// ---------------------------------------------------------------------------

async function activateLocal(sub, invoice, stripeSub) {
    // Terminal docs stay terminal — Stripe retries deliveries for days and
    // guarantees no ordering, so a late invoice.paid must never resurrect a
    // subscription that customer.subscription.deleted already closed.
    if (sub.status === 'cancelled') {
        console.log(`Subscription ${sub._id} is cancelled — ignoring late activation`);
        return;
    }
    sub.status = 'active';
    if (stripeSub) {
        if (stripeSub.current_period_start) {
            sub.currentPeriodStart = new Date(stripeSub.current_period_start * 1000);
        }
        if (stripeSub.current_period_end) {
            sub.currentPeriodEnd = new Date(stripeSub.current_period_end * 1000);
        }
        sub.cancelAtPeriodEnd = !!stripeSub.cancel_at_period_end;
    }
    if (invoice && invoice.id && !(sub.payments || []).some((p) => p.invoiceId === invoice.id)) {
        sub.payments.push({
            invoiceId: invoice.id,
            amountCents: invoice.amount_paid || 0,
            paidAt: new Date(),
        });
    }
    try {
        await sub.save();
    } catch (err) {
        if (err && err.code === 11000) {
            // The partial unique index says this user already has a live
            // subscription — a concurrent purchase won the race. Void this
            // one on Stripe so nobody is double-billed, and shout: the
            // already-paid first invoice needs a manual refund.
            console.error(
                `CRITICAL: duplicate active subscription for user ${sub.user} — ` +
                    `voiding stripe sub ${sub.stripeSubscriptionId}; refund its paid invoice manually`
            );
            sub.status = 'cancelled';
            sub.cancelledAt = new Date();
            await sub.save();
            if (stripe && sub.stripeSubscriptionId) {
                try {
                    await stripe.subscriptions.cancel(sub.stripeSubscriptionId);
                } catch (cancelErr) {
                    console.error('Failed to void duplicate stripe sub:', cancelErr.message);
                }
            }
            return;
        }
        throw err;
    }
    await User.findByIdAndUpdate(sub.user, { activeSubscription: sub._id });
    console.log(`Subscription ${sub._id} active (tier ${sub.tier}, user ${sub.user})`);
}

function subscriptionIdFromInvoice(invoice) {
    if (invoice.subscription) {
        return typeof invoice.subscription === 'string'
            ? invoice.subscription
            : invoice.subscription.id;
    }
    // basil/clover payload shape (2025-03-31+): the link moved to
    // invoice.parent. Our endpoint is pinned to acacia, but a re-created or
    // dashboard-made endpoint would default to the account version — read
    // both so a version drift degrades to nothing worse than an extra fetch.
    const parentSub =
        invoice.parent &&
        invoice.parent.subscription_details &&
        invoice.parent.subscription_details.subscription;
    if (parentSub) return typeof parentSub === 'string' ? parentSub : parentSub.id;
    const line = invoice.lines && invoice.lines.data && invoice.lines.data[0];
    if (line && line.subscription) return line.subscription;
    return null;
}

// invoice.paid — first invoice activates; renewals extend the period and
// record the payment for the value indicator.
async function applyInvoicePaid(invoice) {
    let stripeSubId = subscriptionIdFromInvoice(invoice);
    if (!stripeSubId && stripe && invoice.id) {
        // Unrecognized payload shape — re-fetch through the pinned SDK,
        // whose response shape we control.
        try {
            const fresh = await stripe.invoices.retrieve(invoice.id);
            stripeSubId = subscriptionIdFromInvoice(fresh);
        } catch (err) {
            console.error('invoice.paid: invoice refetch failed', invoice.id, err.message);
        }
    }
    if (!stripeSubId) return { handled: false, reason: 'not_a_subscription_invoice' };

    const sub = await Subscription.findOne({ stripeSubscriptionId: stripeSubId });
    if (!sub) return { handled: false, reason: 'unknown_subscription' };
    if (sub.status === 'cancelled') {
        return { handled: true, subscriptionId: sub._id, ignored: 'terminal' };
    }

    let stripeSub = null;
    if (stripe) {
        try {
            stripeSub = await stripe.subscriptions.retrieve(stripeSubId);
        } catch (err) {
            console.error('invoice.paid: could not retrieve subscription', stripeSubId, err.message);
        }
    }
    // The retrieve reflects CURRENT state — if Stripe already considers this
    // subscription dead, mirror that instead of activating off a stale event.
    if (stripeSub && ['canceled', 'incomplete_expired'].includes(stripeSub.status)) {
        return applySubscriptionUpdated(stripeSub, true);
    }
    await activateLocal(sub, invoice, stripeSub);
    return { handled: true, subscriptionId: sub._id };
}

// invoice.payment_failed — entitlements pause; Stripe keeps retrying the
// card and either a later invoice.paid re-activates or the subscription is
// cancelled by Stripe's dunning settings (customer.subscription.deleted).
async function applyInvoicePaymentFailed(invoice) {
    const stripeSubId = subscriptionIdFromInvoice(invoice);
    if (!stripeSubId) return { handled: false, reason: 'not_a_subscription_invoice' };

    const sub = await Subscription.findOne({ stripeSubscriptionId: stripeSubId });
    if (!sub) return { handled: false, reason: 'unknown_subscription' };
    if (sub.status === 'incomplete' || sub.status === 'cancelled') {
        // First payment never went through (a retry purchase voids the doc)
        // or the sub is already terminal — nothing to pause.
        return { handled: true, subscriptionId: sub._id };
    }

    // Deliveries are unordered and retried for days — check what Stripe
    // thinks NOW before pausing entitlements off a possibly-stale failure.
    if (stripe) {
        try {
            const fresh = await stripe.subscriptions.retrieve(stripeSubId);
            if (['active', 'trialing'].includes(fresh.status)) {
                return { handled: true, subscriptionId: sub._id, ignored: 'stale_event' };
            }
        } catch (err) {
            console.error('payment_failed: subscription refetch failed', stripeSubId, err.message);
        }
    }

    sub.status = 'past_due';
    await sub.save();
    console.log(`Subscription ${sub._id} past_due (invoice ${invoice.id})`);
    return { handled: true, subscriptionId: sub._id };
}

const STRIPE_STATUS_MAP = {
    active: 'active',
    trialing: 'active',
    past_due: 'past_due',
    unpaid: 'past_due',
    canceled: 'cancelled',
    incomplete: 'incomplete',
    incomplete_expired: 'cancelled',
};

// customer.subscription.updated / .deleted — keep the mirror honest.
async function applySubscriptionUpdated(stripeSub, isDeletion = false) {
    const sub = await Subscription.findOne({ stripeSubscriptionId: stripeSub.id });
    if (!sub) return { handled: false, reason: 'unknown_subscription' };

    // For live updates, mirror Stripe's CURRENT state rather than the event
    // payload — deliveries are unordered, and a refetch through the pinned
    // SDK also normalizes payload-shape differences across API versions.
    if (!isDeletion && stripe) {
        try {
            stripeSub = await stripe.subscriptions.retrieve(stripeSub.id);
        } catch (err) {
            console.error('subscription.updated: refetch failed', stripeSub.id, err.message);
        }
    }

    const mapped = isDeletion ? 'cancelled' : STRIPE_STATUS_MAP[stripeSub.status] || sub.status;

    // Never resurrect a terminal doc, and don't let an out-of-order 'updated'
    // event downgrade an activation that invoice.paid already applied.
    if (sub.status === 'cancelled' && mapped !== 'cancelled') {
        return { handled: true, subscriptionId: sub._id, ignored: 'terminal' };
    }

    sub.status = mapped;
    if (stripeSub.current_period_start) {
        sub.currentPeriodStart = new Date(stripeSub.current_period_start * 1000);
    }
    if (stripeSub.current_period_end) {
        sub.currentPeriodEnd = new Date(stripeSub.current_period_end * 1000);
    }
    sub.cancelAtPeriodEnd = !!stripeSub.cancel_at_period_end;
    if (mapped === 'cancelled' && !sub.cancelledAt) sub.cancelledAt = new Date();
    await sub.save();

    if (mapped === 'cancelled') {
        await User.findOneAndUpdate(
            { _id: sub.user, activeSubscription: sub._id },
            { $unset: { activeSubscription: 1 } }
        );
    } else if (mapped === 'active') {
        await User.findByIdAndUpdate(sub.user, { activeSubscription: sub._id });
    }

    console.log(`Subscription ${sub._id} → ${mapped} (stripe ${stripeSub.status})`);
    return { handled: true, subscriptionId: sub._id };
}

// Entry point for paymentController's webhook switch.
async function applyStripeSubscriptionEvent(event) {
    const obj = event.data && event.data.object;
    if (!obj) return { handled: false, reason: 'no_object' };
    switch (event.type) {
        case 'invoice.paid':
            return applyInvoicePaid(obj);
        case 'invoice.payment_failed':
            return applyInvoicePaymentFailed(obj);
        case 'customer.subscription.updated':
            return applySubscriptionUpdated(obj, false);
        case 'customer.subscription.deleted':
            return applySubscriptionUpdated(obj, true);
        default:
            return { handled: false, reason: 'unhandled_type' };
    }
}

exports.applyStripeSubscriptionEvent = applyStripeSubscriptionEvent;
exports.applyInvoicePaid = applyInvoicePaid;
exports.applyInvoicePaymentFailed = applyInvoicePaymentFailed;
exports.applySubscriptionUpdated = applySubscriptionUpdated;
exports.SUBSCRIPTION_EVENT_TYPES = [
    'invoice.paid',
    'invoice.payment_failed',
    'customer.subscription.updated',
    'customer.subscription.deleted',
];
