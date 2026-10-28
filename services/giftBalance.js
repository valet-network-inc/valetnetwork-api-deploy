const GiftCard = require('../models/GiftCard');
const Order = require('../models/Order');
const User = require('../models/User');
const stripeClient = require('./stripeClient');

const stripe = () => stripeClient.get();

/**
 * Gift card money is already paid for, so spending it is not a charge. It
 * sits as a credit on the customer's Stripe balance, which plan bills use on
 * their own. Everything else we charge for (moves, away bookings, scheduled
 * pick-ups, extensions) spends it here first and puts only the rest on the
 * card, and a cancel or refund gives it back.
 *
 * Each spend is recorded on the order (giftSpends, one per tag) before Stripe
 * hears of it, so a retry or a double tap never takes it twice. Only customers
 * who have redeemed a gift card are looked up at all: every other booking goes
 * on exactly as before, without waiting on Stripe.
 */

// Stripe will not charge a card less than 50 cents, so a charge the gift
// balance only nearly covers leaves this much on the card.
const MIN_CARD_CENTS = 50;

const customerIdOf = (order) => order.customer && (order.customer._id || order.customer);

/** The gift money this customer can spend now: { cents, customerId }. */
async function giftFor(userId) {
    const none = { cents: 0, customerId: null };
    if (!stripe() || !userId) return none;
    const user = await User.findById(userId).select('stripeCustomerId').lean();
    if (!user || !user.stripeCustomerId) return none;
    const redeemed = await GiftCard.exists({ redeemedBy: user._id, stripeBalanceTransactionId: { $ne: null } });
    if (!redeemed) return none;
    const customer = await stripe().customers.retrieve(user.stripeCustomerId);
    if (!customer || customer.deleted || !(customer.balance < 0)) return none;
    return { cents: -customer.balance, customerId: user.stripeCustomerId };
}

async function spend(customerId, orderId, cents, tag) {
    await stripe().customers.createBalanceTransaction(
        customerId,
        {
            amount: cents,
            currency: 'usd',
            description: `Gift card spent on order ${orderId} (${tag})`,
            metadata: { orderId: String(orderId), tag },
        },
        { idempotencyKey: `gift-spend-${tag}-${orderId}` }
    );
}

/**
 * A booking the gift balance covers in full is paid for from it before the
 * order is first saved, with no card payment at all. Sets the gift fields on
 * the unsaved order and returns true, or returns false and the card pays.
 */
async function payInFull(order) {
    try {
        const cents = Math.round(Number(order.totalAmount) || 0);
        if (cents <= 0) return false;
        const gift = await giftFor(customerIdOf(order));
        if (gift.cents < cents) return false;
        await spend(gift.customerId, order._id, cents, 'order');
        order.giftSpends = [{ tag: 'order', cents, at: new Date() }];
        order.giftPaidCents = cents;
        order.giftCustomerId = gift.customerId;
        order.paymentStatus = 'paid';
        return true;
    } catch (err) {
        console.error('giftBalance.payInFull failed, the card pays instead:', String(order._id), err.message);
        return false;
    }
}

/**
 * Spend up to `maxCents` of gift money on a saved order, once per `tag`: a
 * retry gets back what the first call took. With `minCardCents`, a charge the
 * balance only nearly covers leaves that much for the card. Returns the cents
 * taken, or 0 when there is no gift money or anything goes wrong.
 */
async function takeGift(order, maxCents, tag, { minCardCents = 0 } = {}) {
    try {
        const total = Math.round(Number(maxCents) || 0);
        if (total <= 0) return 0;
        const prior = (order.giftSpends || []).find((s) => s.tag === tag);
        if (prior) return prior.cents;
        const gift = await giftFor(customerIdOf(order));
        let take = Math.min(gift.cents, total);
        if (take < total && minCardCents) take = Math.min(take, total - minCardCents);
        if (take <= 0) return 0;
        const claimed = await Order.findOneAndUpdate(
            { _id: order._id, 'giftSpends.tag': { $ne: tag } },
            {
                $push: { giftSpends: { tag, cents: take, at: new Date() } },
                $inc: { giftPaidCents: take },
                $set: { giftCustomerId: gift.customerId },
            },
            { new: true }
        ).lean();
        if (!claimed) {
            const fresh = await Order.findById(order._id).select('giftSpends').lean();
            const done = fresh && (fresh.giftSpends || []).find((s) => s.tag === tag);
            return done ? done.cents : 0;
        }
        try {
            await spend(gift.customerId, order._id, take, tag);
        } catch (err) {
            await Order.updateOne({ _id: order._id }, { $pull: { giftSpends: { tag } }, $inc: { giftPaidCents: -take } });
            throw err;
        }
        // The caller's copy too, so a later save keeps the same numbers.
        order.giftPaidCents = claimed.giftPaidCents;
        order.giftCustomerId = gift.customerId;
        return take;
    } catch (err) {
        console.error('giftBalance.takeGift failed, the card pays instead:', String(order._id), tag, err.message);
        return 0;
    }
}

/**
 * What the card still pays on an order's own charge after gift money. The
 * card keeps at least 50 cents here: the customer is already looking at the
 * card screen. An away booking's $1 deposit stays on the card, because it is
 * what saves the card for the balance charged once the valet sets the days.
 */
async function cardCentsAfterGift(order) {
    const total = Math.round(Number(order.totalAmount) || 0);
    if (order.awayBilling && order.awayBilling.status === 'pending_schedule') return total;
    if (total <= MIN_CARD_CENTS) return total;
    return total - (await takeGift(order, total - MIN_CARD_CENTS, 'order'));
}

/**
 * Give gift money spent on an order back to the balance: all of what is left
 * when `cents` is omitted. Claimed on the order first, so two refunds can never
 * both return it. Returns the cents given back.
 */
async function giveBack(order, cents, why) {
    const left = (order.giftPaidCents || 0) - (order.giftReturnedCents || 0);
    const amount = Math.min(cents === undefined ? left : cents, left);
    if (!(amount > 0) || !order.giftCustomerId || !stripe()) return 0;
    try {
        const claimed = await Order.updateOne(
            {
                _id: order._id,
                $expr: { $lte: [{ $add: [{ $ifNull: ['$giftReturnedCents', 0] }, amount] }, '$giftPaidCents'] },
            },
            { $inc: { giftReturnedCents: amount } }
        );
        if (!claimed.modifiedCount) return 0;
        try {
            await stripe().customers.createBalanceTransaction(
                order.giftCustomerId,
                {
                    amount: -amount,
                    currency: 'usd',
                    description: `Gift card money back from order ${order._id} (${why})`,
                    metadata: { orderId: String(order._id), why },
                },
                { idempotencyKey: `gift-back-${why}-${order._id}` }
            );
        } catch (err) {
            await Order.updateOne({ _id: order._id }, { $inc: { giftReturnedCents: -amount } });
            throw err;
        }
        order.giftReturnedCents = (order.giftReturnedCents || 0) + amount;
        return amount;
    } catch (err) {
        console.error('giftBalance.giveBack failed:', String(order._id), why, err.message);
        return 0;
    }
}

/** The order never saved, so put back what payInFull spent on it. */
async function refundUnsaved(order) {
    try {
        await stripe().customers.createBalanceTransaction(
            order.giftCustomerId,
            {
                amount: -order.giftPaidCents,
                currency: 'usd',
                description: `Gift card money back: order ${order._id} was never saved`,
                metadata: { orderId: String(order._id) },
            },
            { idempotencyKey: `gift-unsaved-${order._id}` }
        );
    } catch (err) {
        console.error('giftBalance.refundUnsaved failed:', String(order._id), err.message);
    }
}

module.exports = { giftFor, payInFull, takeGift, cardCentsAfterGift, giveBack, refundUnsaved, MIN_CARD_CENTS };
