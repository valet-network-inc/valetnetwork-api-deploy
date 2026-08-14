/**
 * Idempotently create the Stripe Billing catalog for subscriptions v2.
 *
 * Three products, each with a weekly and a monthly recurring price. Prices are
 * found by lookup_key, so re-running never duplicates anything. If a price
 * exists with the wrong amount it is left alone and reported — Stripe prices
 * are immutable, so an amount change means minting a new price and moving the
 * lookup_key (do that deliberately, not from this script).
 *
 * Run:  STRIPE_API_KEY=sk_... node scripts/ensureSubscriptionCatalog.js
 */
const stripeModule = require('stripe');

const CATALOG = [
    {
        productKey: 'vn_sub_street_cleaning',
        name: 'Street-cleaning moves',
        prices: [
            // Legacy flat 2-move prices (kept; unused after per-move launch)
            { lookupKey: 'vn_street_cleaning_weekly', amount: 3000, interval: 'week' },
            { lookupKey: 'vn_street_cleaning_monthly', amount: 10000, interval: 'month' },
            // Per-move prices, bought with quantity = moves/week (1 or 2)
            { lookupKey: 'vn_street_move_weekly', amount: 1500, interval: 'week' },
            { lookupKey: 'vn_street_move_monthly', amount: 5000, interval: 'month' },
        ],
    },
    {
        productKey: 'vn_sub_home_garage',
        name: 'Home garage',
        prices: [
            { lookupKey: 'vn_home_garage_weekly', amount: 7500, interval: 'week' },
            { lookupKey: 'vn_home_garage_monthly', amount: 25000, interval: 'month' },
        ],
    },
    {
        productKey: 'vn_sub_valet_anywhere',
        name: 'Valet anywhere',
        prices: [
            { lookupKey: 'vn_valet_anywhere_weekly', amount: 9000, interval: 'week' },
            { lookupKey: 'vn_valet_anywhere_monthly', amount: 30000, interval: 'month' },
        ],
    },
];

async function main() {
    if (!process.env.STRIPE_API_KEY) throw new Error('STRIPE_API_KEY not set');
    const stripe = stripeModule(process.env.STRIPE_API_KEY);

    const allLookupKeys = CATALOG.flatMap((p) => p.prices.map((x) => x.lookupKey));
    const existing = await stripe.prices.list({
        lookup_keys: allLookupKeys,
        limit: 100,
        expand: ['data.product'],
    });
    const byLookup = new Map(existing.data.map((p) => [p.lookup_key, p]));

    for (const product of CATALOG) {
        let productId = null;
        for (const price of product.prices) {
            const found = byLookup.get(price.lookupKey);
            if (found) {
                const ok =
                    found.unit_amount === price.amount &&
                    found.recurring &&
                    found.recurring.interval === price.interval &&
                    found.currency === 'usd' &&
                    found.active;
                console.log(
                    `${ok ? 'OK  ' : 'DRIFT'} ${price.lookupKey} -> ${found.id} ` +
                        `($${(found.unit_amount / 100).toFixed(2)}/${found.recurring?.interval})`
                );
                productId = typeof found.product === 'string' ? found.product : found.product.id;
                continue;
            }
            if (!productId) {
                const search = await stripe.products.search({
                    query: `metadata['productKey']:'${product.productKey}'`,
                });
                if (search.data.length > 0) {
                    productId = search.data[0].id;
                } else {
                    const created = await stripe.products.create({
                        name: product.name,
                        metadata: { productKey: product.productKey },
                    });
                    productId = created.id;
                    console.log(`CREATED product ${product.productKey} -> ${productId}`);
                }
            }
            const createdPrice = await stripe.prices.create({
                product: productId,
                unit_amount: price.amount,
                currency: 'usd',
                recurring: { interval: price.interval },
                lookup_key: price.lookupKey,
                metadata: { lookupKey: price.lookupKey },
            });
            console.log(
                `CREATED price ${price.lookupKey} -> ${createdPrice.id} ($${(price.amount / 100).toFixed(2)}/${price.interval})`
            );
        }
    }
    console.log('Catalog ensured.');
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
