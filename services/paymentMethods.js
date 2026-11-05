/**
 * The payment methods a user has saved, for the app's "Pay with" row (Nov 5
 * 2026, Rishi: "a small box ... where people can choose / change their payment
 * preference. sort of like how uber does it ... default it to whatever payment
 * option they've already saved").
 *
 * Cards live on the user's Stripe customer: every per-use PaymentIntent saves
 * its card (`setup_future_usage: 'off_session'`), Apple Pay included, and the
 * plans save theirs. A card paid through Apple Pay is still listed, marked
 * `wallet: 'apple_pay'`, so the app can fold it into its Apple Pay row rather
 * than show the same card twice.
 */
const User = require('../models/User');
const stripeClient = require('./stripeClient');

const view = (pm, defaultId) => ({
    id: pm.id,
    brand: pm.card?.brand || 'card',
    last4: pm.card?.last4 || '',
    expMonth: pm.card?.exp_month || null,
    expYear: pm.card?.exp_year || null,
    wallet: pm.card?.wallet?.type || null,
    isDefault: pm.id === defaultId,
});

/** { methods, defaultId, balanceCents } for the user; empty when Stripe is off or they have no customer yet. */
async function list(userId) {
    const empty = { methods: [], defaultId: null, balanceCents: 0 };
    const stripe = stripeClient.get();
    if (!stripe) return empty;
    const user = await User.findById(userId).select('stripeCustomerId').lean();
    if (!user || !user.stripeCustomerId) return empty;
    const customer = await stripe.customers.retrieve(user.stripeCustomerId);
    if (!customer || customer.deleted) return empty;
    const preferred = customer.invoice_settings && customer.invoice_settings.default_payment_method;
    const defaultId = typeof preferred === 'string' ? preferred : preferred?.id || null;
    const res = await stripe.paymentMethods.list({ customer: user.stripeCustomerId, type: 'card', limit: 20 });
    // One row per card: the same card saved twice (two checkouts) shows once,
    // the default copy or else the newest.
    const seen = new Map();
    for (const pm of res?.data || []) {
        const key = pm.card?.fingerprint ? `${pm.card.fingerprint}:${pm.card?.wallet?.type || ''}` : pm.id;
        const kept = seen.get(key);
        const newer = kept && kept.id !== defaultId && (pm.created || 0) > (kept.created || 0);
        if (!kept || pm.id === defaultId || newer) seen.set(key, pm);
    }
    const methods = [...seen.values()]
        .sort((a, b) => (b.id === defaultId) - (a.id === defaultId) || (b.created || 0) - (a.created || 0))
        .map((pm) => view(pm, defaultId));
    // Gift cards and refunds sit on the Stripe customer as a credit, a negative balance.
    const balanceCents = Math.max(0, -(Number(customer.balance) || 0));
    return { methods, defaultId, balanceCents };
}

/** Make one of the user's own cards the default (plans, scheduled runs and tips charge it). */
async function setDefault(userId, paymentMethodId) {
    const stripe = stripeClient.get();
    if (!stripe) return { status: 503, error: 'Payments are unavailable right now. Try again soon.' };
    const user = await User.findById(userId).select('stripeCustomerId').lean();
    if (!user || !user.stripeCustomerId) return { status: 404, error: 'No saved cards yet.' };
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId).catch(() => null);
    if (!pm || pm.customer !== user.stripeCustomerId) return { status: 404, error: 'That card isn’t on your account.' };
    await stripe.customers.update(user.stripeCustomerId, { invoice_settings: { default_payment_method: pm.id } });
    return { defaultId: pm.id };
}

module.exports = { list, setDefault };
