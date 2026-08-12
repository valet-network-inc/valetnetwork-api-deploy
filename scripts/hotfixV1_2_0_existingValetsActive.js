/**
 * hotfixV1_2_0_existingValetsActive
 *
 * Run this AFTER migrateValetsToV1_2_0.js if existing operating valets
 * got stuck at `pending_certn` (which happens when Certn was dormant
 * pre-v1.2.0 and no one ever had backgroundCheck.status='passed').
 *
 * Logic: if the valet was operating before v1.2.0 (`isActive=true` and
 * `!isDeleted`), stamp them `active` regardless of Certn status. They
 * were already accepting orders pre-v1.2.0; the new gate would otherwise
 * lock them out.
 *
 * Idempotent — appends a separate hotfix history entry, will skip on re-run.
 */

const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', `.env.${process.env.NODE_ENV || 'development'}`) });

const mongoose = require('mongoose');
const User = require('../models/User');

const HOTFIX_REASON = 'Hotfix: pre-v1.2.0 operating valet re-stamped active';

(async () => {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
        console.error('MONGO_URI not set. Aborting.');
        process.exit(1);
    }

    console.log('Connecting...');
    await mongoose.connect(mongoUri);

    // Find valets stuck at pending_certn who are actually currently
    // operating (isActive + !isDeleted).
    const targets = await User.find({
        isValet: true,
        isDeleted: { $ne: true },
        isActive: true,
        valetOnboardingStatus: 'pending_certn',
    });

    console.log(`Found ${targets.length} operating valets stuck at pending_certn.`);

    let updated = 0;
    let skipped = 0;

    for (const valet of targets) {
        // Idempotency check
        if (valet.statusHistory?.some((h) => h.reason === HOTFIX_REASON)) {
            skipped += 1;
            continue;
        }

        valet.valetOnboardingStatus = 'active';
        valet.statusHistory.push({
            from: 'pending_certn',
            to: 'active',
            at: new Date(),
            triggerSource: 'system',
            reason: HOTFIX_REASON,
        });
        // Stamp authorization timestamp as a sane approximation
        valet.providerAuthorization = valet.providerAuthorization || {};
        if (!valet.providerAuthorization.authorizedAt) {
            valet.providerAuthorization.authorizedAt = new Date();
        }
        await valet.save();
        updated += 1;
    }

    console.log(`Updated: ${updated}`);
    console.log(`Skipped: ${skipped} (already hotfixed)`);

    await mongoose.disconnect();
    process.exit(0);
})().catch((err) => {
    console.error('Hotfix failed:', err);
    process.exit(1);
});
