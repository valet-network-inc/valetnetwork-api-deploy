/**
 * grandfatherExistingValetsForYardstik
 *
 * Run this script BEFORE deploying the new iOS build that adds the Yardstik
 * background-check gate (the build with the updated AuthLoadingScreen +
 * CreateAccountScreen + BackgroundCheckScreen).
 *
 * Why: AuthLoadingScreen now routes valets to BackgroundCheckScreen unless
 * `backgroundCheck.status === 'passed'`. Existing production valets have no
 * `backgroundCheck` object at all (the gate was deferred until Yardstik was
 * integrated). Without this migration, they'd open the new build and be
 * dumped into the background-check flow, blocked from their accounts.
 *
 * What this does: for every valet User document where
 *   isValet=true AND backgroundCheck.status is not 'passed'
 * stamps `backgroundCheck.status = 'passed'` with provider='grandfathered'
 * and a history entry. New valets created AFTER this script runs are
 * unaffected (they start with default `not_started` and go through Yardstik).
 *
 * Idempotent — skips valets that already have status='passed'.
 *
 * Usage:
 *   NODE_ENV=development node scripts/grandfatherExistingValetsForYardstik.js   # dev DB
 *   NODE_ENV=production  node scripts/grandfatherExistingValetsForYardstik.js   # prod DB (DANGER)
 *
 * Always dry-run first by setting DRY_RUN=1:
 *   DRY_RUN=1 NODE_ENV=production node scripts/grandfatherExistingValetsForYardstik.js
 */

const path = require('path');
const dotenv = require('dotenv');
dotenv.config({
    path: path.join(__dirname, '..', `.env.${process.env.NODE_ENV || 'development'}`),
});

const mongoose = require('mongoose');
const User = require('../models/User');

const GRANDFATHER_REASON =
    'Grandfathered for Yardstik migration: existing valet stamped passed before new gate ships';
const DRY_RUN = process.env.DRY_RUN === '1';

(async () => {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
        console.error('MONGO_URI not set. Aborting.');
        process.exit(1);
    }

    console.log(`Connecting to MongoDB (NODE_ENV=${process.env.NODE_ENV})...`);
    console.log(`DRY_RUN: ${DRY_RUN ? 'YES (no writes will happen)' : 'NO'}`);
    await mongoose.connect(mongoUri);

    // Target: valets whose backgroundCheck.status is missing OR not 'passed'.
    // We explicitly exclude already-passed valets so re-runs are no-ops.
    const targets = await User.find({
        isValet: true,
        isDeleted: { $ne: true },
        $or: [
            { 'backgroundCheck.status': { $exists: false } },
            { 'backgroundCheck.status': { $ne: 'passed' } },
        ],
    });

    console.log(`Found ${targets.length} valet(s) needing grandfathering.`);

    if (DRY_RUN) {
        // Print up to 20 sample IDs so operator can sanity-check.
        targets.slice(0, 20).forEach((v) => {
            console.log(
                `  - ${v._id}  status=${v.backgroundCheck?.status || '(none)'}  onboarding=${v.valetOnboardingStatus}`
            );
        });
        if (targets.length > 20) {
            console.log(`  (… and ${targets.length - 20} more)`);
        }
        console.log('\nDRY_RUN=1, no writes performed. Re-run without DRY_RUN to apply.');
        await mongoose.disconnect();
        process.exit(0);
    }

    let updated = 0;
    let skipped = 0;

    for (const valet of targets) {
        // Defensive idempotency check (should never hit because of the query
        // filter, but harmless to verify before writing).
        if (valet.backgroundCheck?.status === 'passed') {
            skipped += 1;
            continue;
        }

        valet.backgroundCheck = valet.backgroundCheck || {};
        valet.backgroundCheck.status = 'passed';
        valet.backgroundCheck.provider = 'grandfathered';
        valet.backgroundCheck.completedAt =
            valet.backgroundCheck.completedAt || new Date();

        valet.statusHistory.push({
            from: valet.valetOnboardingStatus,
            to: valet.valetOnboardingStatus, // not changing onboarding state
            at: new Date(),
            triggerSource: 'system',
            reason: GRANDFATHER_REASON,
        });

        await valet.save();
        updated += 1;
    }

    console.log(`Updated: ${updated}`);
    console.log(`Skipped: ${skipped}`);

    await mongoose.disconnect();
    process.exit(0);
})().catch((err) => {
    console.error('Grandfather migration failed:', err);
    process.exit(1);
});
