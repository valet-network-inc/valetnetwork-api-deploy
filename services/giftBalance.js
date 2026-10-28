const GiftCard = require('../models/GiftCard');
const Order = require('../models/Order');
const User = require('../models/User');
const stripeClient = require('./stripeClient');

const stripe = () => stripeClient.get();

/**
 * Gift card money is already paid for, so spending it is not a charge. It
 * sits as a credit on the customer's Stripe balance, which plan bills use on
 * their own. One-off moves are card payments, which Stripe never takes from
 * the balance, so these helpers let a move spend it and a cancel give it back.
 *
 * Only customers who have redeemed a gift card are looked up at all: every
 * other booking goes on exactly as before, without waiting on Stripe.
 */

// Stripe will not charge a card less than 50 cents, so a move the gift
// balance only nearly covers leaves this much on the card.
const MIN_CARD_CENTS = 50;

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

/** Take `cents` off the balance for an order. Once per order, retries included. */
async function spend(customerId, orderId, cents) {
    await stripe().customers.createBalanceTransaction(
        customerId,
        {
            amount: cents,
            currency: 'usd',
            description: `Gift card spent on order ${orderId}`,
            metadata: { orderId: String(orderId) },
        },
        { idempotencyKey: `gift-spend-${orderId}` }
    );
}

/**
 * A move the gift balance covers in full is paid for from it at booking, with
 * no card payment at all. Sets the order's gift fields and returns true, or
 * returns false (balance too small, or Stripe unreachable) and the card pays.
 */
async function payInFull(order) {
    try {
        const cents = Number(order.totalAmount) || 0;
        if (cents <= 0) return false;
        const gift = await giftFor(order.customer);
        if (gift.cents < cents) return false;
        await spend(gift.customerId, order._id, cents);
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
 * For a move the balance only partly covers: what the card still has to pay.
 * The gift part is claimed on the order before it is spent, so a second
 * payment attempt for the same order reuses it instead of spending again.
 */
async function cardCentsAfterGift(order) {
    const total = Number(order.totalAmount) || 0;
    if (order.giftPaidCents > 0) return Math.max(0, total - order.giftPaidCents);
    if (total <= MIN_CARD_CENTS || order.awayMode) return total;
    try {
        const customerId = order.customer && (order.customer._id || order.customer);
        const gift = await giftFor(customerId);
        const use = Math.min(gift.cents, total - MIN_CARD_CENTS);
        if (use <= 0) return total;
        const claimed = await Order.findOneAndUpdate(
            { _id: order._id, giftPaidCents: { $in: [null, 0] } },
            { $set: { giftPaidCents: use, giftCustomerId: gift.customerId } },
            { new: true }
        );
        if (!claimed) {
            const fresh = await Order.findById(order._id).select('giftPaidCents').lean();
            return Math.max(0, total - ((fresh && fresh.giftPaidCents) || 0));
        }
        try {
            await spend(gift.customerId, order._id, use);
        } catch (err) {
            await Order.updateOne({ _id: order._id }, { $unset: { giftPaidCents: '', giftCustomerId: '' } });
            throw err;
        }
        order.giftPaidCents = use;
        order.giftCustomerId = gift.customerId;
        return total - use;
    } catch (err) {
        console.error('giftBalance.cardCentsAfterGift failed, the card pays it all:', String(order._id), err.message);
        return total;
    }
}

/**
 * Give gift money spent on an order back to the balance — all of what is left
 * when `cents` is omitted. Claimed on the order first, so two cancels can never
 * both return it. Returns the cents given back.
 */
async function giveBack(order, cents, why) {
    const left = (order.giftPaidCents || 0) - (order.giftReturnedCents || 0);
    const amount = Math.min(cents === undefined ? left : cents, left);
    if (!(amount > 0) || !order.giftCustomerId || !stripe()) return 0;
    try {
        return await giveBackClaimed(order, amount, why);
    } catch (err) {
        console.error('giftBalance.giveBack failed:', String(order._id), why, err.message);
        return 0;
    }
}

async function giveBackClaimed(order, amount, why) {
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
        console.error('giftBalance.giveBack failed:', String(order._id), why, err.message);
        return 0;
    }
    order.giftReturnedCents = (order.giftReturnedCents || 0) + amount;
    return amount;
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

module.exports = { giftFor, payInFull, cardCentsAfterGift, giveBack, refundUnsaved, MIN_CARD_CENTS };
