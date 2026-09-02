/**
 * Backfill `acceptedAt` on street-cleaning return legs minted without one.
 *
 * The sweep creates its return leg already `accepted` with a valet on it, so
 * the leg never passes through `acceptOrder` — the only thing that ever wrote
 * this field. Every leg minted before today is therefore assigned to a valet
 * who accepted it at no time at all, and two things read that as the epoch:
 * `valetCancelOrder`'s three-minute cooldown, which a valet could then walk
 * straight past, and anything asking whether the job has really been taken.
 *
 * Only touches sweep legs — a retrieval carrying the parent's `aspreturn:` key
 * — that are still live and still missing the stamp. `pickUpTime` is the
 * closest real record of when the sweep handed the leg over, because the sweep
 * sets it to the moment it minted the leg.
 *
 *   NODE_ENV=development node scripts/backfill-asp-leg-accepted-at.js --dry-run
 *   NODE_ENV=development node scripts/backfill-asp-leg-accepted-at.js
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
    const orders = mongoose.connection.db.collection('orders');

    const query = {
        orderType: 'retrieval',
        autoBookKey: { $regex: '^aspreturn:' },
        valet: { $exists: true },
        acceptedAt: { $exists: false },
        status: { $nin: ['cancelled', 'completed'] },
    };

    const candidates = await orders.find(query).toArray();
    console.log(`sweep legs missing an accept stamp: ${candidates.length}`);
    for (const o of candidates) {
        console.log(
            ` ${o._id}  status=${o.status}  minted=${(o.pickUpTime || o.createdAt).toISOString()}`
        );
    }

    if (DRY_RUN) {
        console.log('\n--dry-run: nothing written.');
        await mongoose.disconnect();
        return;
    }

    let n = 0;
    for (const o of candidates) {
        // Idempotent: the filter re-checks the field, so a second run over a
        // leg somebody has since stamped writes nothing.
        const result = await orders.updateOne(
            { _id: o._id, acceptedAt: { $exists: false } },
            { $set: { acceptedAt: o.pickUpTime || o.createdAt } }
        );
        n += result.modifiedCount;
    }
    console.log(`\nstamped ${n} leg(s)`);

    const left = await orders.countDocuments(query);
    console.log(`remaining: ${left}`);
    await mongoose.disconnect();
    process.exit(left === 0 ? 0 : 1);
})().catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
});
