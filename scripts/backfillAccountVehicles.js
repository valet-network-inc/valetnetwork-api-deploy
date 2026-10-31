/**
 * One-off, Oct 30 2026: give each account the car its valet last logged.
 *
 * Until today the account had no car (see services/accountVehicle.js), so
 * the app's Your car screen showed grey sample text to everyone. This copies
 * the most recent complete car on each customer's own orders onto their
 * account. It skips doorman/enterprise orders and valet accounts, and never
 * touches an account that already has a car.
 *
 * Dry run by default; --apply writes. Needs MONGO_URI. Writes the plan to
 * $SNAPSHOT (every touched account had no car before, so undo = $unset).
 */
require('dns').setServers(['8.8.8.8', '1.1.1.1']);
const fs = require('fs');
const mongoose = require('mongoose');
const User = require('../models/User');
const Order = require('../models/Order');
const { normalizeVehicle, looksLikeACar, orderCarBelongsToCustomer } = require('../services/accountVehicle');

(async () => {
    const apply = process.argv.includes('--apply');
    await mongoose.connect(process.env.MONGO_URI);
    const filled = { $exists: true, $nin: [null, ''] };
    const rows = await Order.aggregate([
        { $match: { 'vehicle.color': filled, 'vehicle.model': filled, 'vehicle.licensePlate': filled } },
        { $sort: { updatedAt: -1 } },
        { $group: { _id: '$customer', order: { $first: '$$ROOT' } } },
    ]);
    const users = await User.find({ _id: { $in: rows.map((r) => r._id) } })
        .select('_id firstName vehicle isDoorman isValet enterpriseCode')
        .lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    const plan = [];
    let hasCar = 0;
    let notTheirs = 0;
    let notACar = 0;
    for (const r of rows) {
        const user = byId.get(String(r._id));
        if (!user) continue;
        if (user.vehicle && user.vehicle.licensePlate) { hasCar++; continue; }
        if (!orderCarBelongsToCustomer(r.order, user)) { notTheirs++; continue; }
        const v = normalizeVehicle(r.order.vehicle);
        if (!looksLikeACar(v)) { notACar++; continue; }
        plan.push({
            userId: String(user._id),
            name: user.firstName || '',
            orderId: String(r.order._id),
            vehicle: { ...v, source: 'valet', ...(r.order.valet ? { by: r.order.valet } : {}), at: r.order.updatedAt || new Date() },
        });
    }
    let applied = 0;
    if (apply) {
        for (const p of plan) {
            const res = await User.updateOne(
                { _id: p.userId, 'vehicle.licensePlate': { $exists: false } },
                { $set: { vehicle: p.vehicle } }
            );
            applied += res.modifiedCount;
        }
    }
    fs.writeFileSync(process.env.SNAPSHOT || 'account-vehicles-plan.json', JSON.stringify(plan, null, 2));
    console.log(JSON.stringify({
        customersWithACarOnAnOrder: rows.length,
        alreadyHaveACar: hasCar,
        skippedNotTheirCar: notTheirs,
        skippedNotACar: notACar,
        toFill: plan.length,
        applied: apply ? applied : 'dry run',
        sample: plan.slice(0, 4).map((p) => `${p.name}: ${p.vehicle.color} ${p.vehicle.model}`),
    }, null, 2));
    await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
