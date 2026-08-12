/**
 * Backfill `parkClosedAt` on parks that were already finished before the field
 * existed.
 *
 * `parkClosedAt` is what marks a park as closed out by the valet. It drives
 * three things: the valet's job leaving their screen, the keys-held ticket
 * appearing for the customer, and the compatibility status older clients read.
 * Parks that finished before today carry none of it — the earlier migration
 * rewrote their status and left them looking permanently mid-park, which costs
 * those customers the free return trip they already paid for.
 *
 * Only touches parks with a verified key handoff (`otpVerifiedTimes.returnKey`)
 * that haven't been updated in the last hour. A park still in progress has no
 * handoff stamp, so it can't be caught by this.
 *
 *   NODE_ENV=development node scripts/backfill-park-closed-at.js --dry-run
 *   NODE_ENV=development node scripts/backfill-park-closed-at.js
 */

const dotenv = require('dotenv');
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });
const mongoose = require('mongoose');

const DRY_RUN = process.argv.includes('--dry-run');
const SETTLED_FOR_MS = 60 * 60 * 1000;

(async () => {
    const uri = process.env.MONGO_URI;
    if (!uri) {
        console.error('MONGO_URI missing — check .env.' + process.env.NODE_ENV);
        process.exit(1);
    }
    await mongoose.connect(uri);
    const orders = mongoose.connection.db.collection('orders');

    const query = {
        status: 'parked',
        orderType: 'parking',
        serviceType: 'park-and-hold',
        parkClosedAt: { $exists: false },
        'otpVerifiedTimes.returnKey': { $exists: true },
        updatedAt: { $lt: new Date(Date.now() - SETTLED_FOR_MS) },
    };

    const candidates = await orders.find(query).toArray();
    console.log(`parks needing a close-out stamp: ${candidates.length}`);
    for (const o of candidates) {
        console.log(
            ` ${o._id}  handoff=${o.otpVerifiedTimes.returnKey.toISOString()}  updated=${o.updatedAt.toISOString()}`
        );
    }

    if (DRY_RUN) {
        console.log('\n--dry-run: nothing written.');
        await mongoose.disconnect();
        return;
    }

    let n = 0;
    for (const o of candidates) {
        // The handoff is the closest real record of when the park ended.
        await orders.updateOne(
            { _id: o._id },
            { $set: { parkClosedAt: o.otpVerifiedTimes.returnKey } }
        );
        n++;
    }
    console.log(`\nstamped ${n} park(s)`);

    const left = await orders.countDocuments(query);
    console.log(`remaining: ${left}`);
    await mongoose.disconnect();
    process.exit(left === 0 ? 0 : 1);
})().catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
});
