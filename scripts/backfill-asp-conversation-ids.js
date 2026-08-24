/**
 * Give the already-minted ASP return legs the conversation they never got.
 *
 * The sweep creates the return leg directly at status 'accepted', so it never
 * passes through acceptOrder — the one place that stamped conversationId. Every
 * leg minted before that was fixed is walking around with no chat thread, and
 * anything the valet app writes to the conversation for that order (arrival
 * notice, parked message, payment link) throws on an empty document path.
 *
 * The leg is the return trip of its parent park: same customer, same valet. Its
 * thread is the parent's thread.
 *
 * Usage:  MONGO_URI=... node scripts/backfill-asp-conversation-ids.js [--apply]
 * Without --apply it only reports what it would change.
 */

const mongoose = require('mongoose');
const Order = require('../models/Order');

const DEAD_STATUSES = ['completed', 'cancelled'];

const run = async () => {
    const apply = process.argv.includes('--apply');
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error('MONGO_URI is required');

    await mongoose.connect(uri);

    const orphans = await Order.find({
        orderType: 'retrieval',
        linkedOrderId: { $exists: true, $ne: null },
        status: { $nin: DEAD_STATUSES },
        $or: [{ conversationId: { $exists: false } }, { conversationId: null }, { conversationId: '' }],
    });

    console.log(`${orphans.length} live return leg(s) with no conversation`);

    let repaired = 0;
    let unfixable = 0;

    for (const order of orphans) {
        const parent = await Order.findById(order.linkedOrderId).select('conversationId');
        if (!parent?.conversationId) {
            console.log(`  ${order._id} — parent ${order.linkedOrderId} has no conversation either, skipping`);
            unfixable++;
            continue;
        }

        console.log(`  ${order._id} (${order.status}) → ${parent.conversationId}`);
        if (apply) {
            await Order.updateOne(
                { _id: order._id },
                { $set: { conversationId: parent.conversationId } }
            );
        }
        repaired++;
    }

    console.log(
        apply
            ? `Repaired ${repaired}, could not repair ${unfixable}`
            : `Would repair ${repaired}, could not repair ${unfixable} (dry run — pass --apply)`
    );

    await mongoose.disconnect();
};

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
