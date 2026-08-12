/**
 * One-shot migration: fold the retired `parked-with-keys` status into `parked`.
 *
 * A park ends with the keys back in the customer's hand — always — so the two
 * statuses described the same physical situation. Live orders written before
 * this change still carry the old value, and the Order schema no longer lists
 * it, so anything that loads and re-saves one of those docs would fail
 * validation. Rewrite them once.
 *
 * Also drops `statusBeforeRetrieval`, which only existed to remember which of
 * the two a park had been sitting on.
 *
 * Safe to run repeatedly. Run:
 *   NODE_ENV=development node scripts/migrate-drop-parked-with-keys.js
 *   NODE_ENV=development node scripts/migrate-drop-parked-with-keys.js --dry-run
 */

const dotenv = require('dotenv');
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });
const mongoose = require('mongoose');

const DRY_RUN = process.argv.includes('--dry-run');

(async () => {
    const uri = process.env.MONGO_URI;
    if (!uri) {
        console.error('MONGO_URI missing — check .env.' + process.env.NODE_ENV);
        process.exit(1);
    }

    await mongoose.connect(uri);
    // Go through the raw collection, not the model: the model's enum no longer
    // accepts the value we're looking for.
    const orders = mongoose.connection.db.collection('orders');

    const stale = await orders.countDocuments({ status: 'parked-with-keys' });
    const snapshots = await orders.countDocuments({
        statusBeforeRetrieval: { $exists: true },
    });
    console.log(`orders on 'parked-with-keys': ${stale}`);
    console.log(`orders carrying statusBeforeRetrieval: ${snapshots}`);

    if (DRY_RUN) {
        console.log('\n--dry-run: nothing written.');
        await mongoose.disconnect();
        return;
    }

    if (stale > 0) {
        const r = await orders.updateMany(
            { status: 'parked-with-keys' },
            { $set: { status: 'parked' } }
        );
        console.log(`rewrote ${r.modifiedCount} order(s) to 'parked'`);
    }

    if (snapshots > 0) {
        const r = await orders.updateMany(
            { statusBeforeRetrieval: { $exists: true } },
            { $unset: { statusBeforeRetrieval: '' } }
        );
        console.log(`dropped statusBeforeRetrieval from ${r.modifiedCount} order(s)`);
    }

    const left = await orders.countDocuments({ status: 'parked-with-keys' });
    console.log(`\nremaining on the old status: ${left}`);
    await mongoose.disconnect();
    process.exit(left === 0 ? 0 : 1);
})().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
});
