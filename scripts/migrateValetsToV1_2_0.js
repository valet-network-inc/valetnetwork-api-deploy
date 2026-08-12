/**
 * migrateValetsToV1_2_0
 *
 * One-time migration: stamp every existing valet with a sensible
 * `valetOnboardingStatus` value before v1.2.0 deploy.
 *
 * Why: v1.2.0 introduces a new top-level status enum that gates job
 * acceptance (see orderController.acceptOrder). Existing valets created
 * before v1.2.0 default to `pending_certn` — without this migration,
 * every existing operating valet would lose access to accept jobs the
 * moment v1.2.0 ships.
 *
 * Mapping rules (existing fields → new status):
 *   - isDeleted=true                                  → suspended_admin
 *   - backgroundCheck.status='failed'                 → certn_failed
 *   - isActive=true + backgroundCheck.status='passed' → active   (the
 *       valets currently working — we don't want to lock them out)
 *   - backgroundCheck.status='passed' + !isActive     → pending_provider_approval
 *   - backgroundCheck.status='pending'                → pending_certn
 *   - default (everything else)                       → pending_certn
 *
 * Each affected user gets a single row appended to statusHistory with
 * triggerSource='system' and a "migrated to v1.2.0 status model" reason.
 *
 * Run from the backend directory:
 *   node scripts/migrateValetsToV1_2_0.js
 *
 * Reads MONGO_URI from .env (or .env.development if NODE_ENV is set).
 * Idempotent: safe to run multiple times. Skips users whose
 * statusHistory already contains a v1.2.0 migration entry.
 */

const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', `.env.${process.env.NODE_ENV || 'development'}`) });

const mongoose = require('mongoose');
const User = require('../models/User');

const MIGRATION_REASON = 'Migrated to v1.2.0 status model';

const decideStatus = (user) => {
    if (user.isDeleted) return 'suspended_admin';
    const certnStatus = user.backgroundCheck?.status;
    if (certnStatus === 'failed') return 'certn_failed';
    if (user.isActive && certnStatus === 'passed') return 'active';
    if (certnStatus === 'passed') return 'pending_provider_approval';
    if (certnStatus === 'pending') return 'pending_certn';
    return 'pending_certn';
};

const alreadyMigrated = (user) =>
    Array.isArray(user.statusHistory) &&
    user.statusHistory.some((h) => h.reason === MIGRATION_REASON);

(async () => {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
        console.error('MONGO_URI not set. Aborting.');
        process.exit(1);
    }

    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('Connected.');

    const valets = await User.find({ isValet: true });
    console.log(`Found ${valets.length} valet accounts.`);

    let updated = 0;
    let skipped = 0;
    const counts = {};

    for (const valet of valets) {
        if (alreadyMigrated(valet)) {
            skipped += 1;
            continue;
        }

        const fromStatus = valet.valetOnboardingStatus || 'pending_certn';
        const toStatus = decideStatus(valet);

        valet.valetOnboardingStatus = toStatus;
        valet.statusHistory = valet.statusHistory || [];
        valet.statusHistory.push({
            from: fromStatus,
            to: toStatus,
            at: new Date(),
            triggerSource: 'system',
            reason: MIGRATION_REASON,
        });

        // For valets being stamped 'active' as part of the migration,
        // also fill in providerAuthorization.authorizedAt so the audit
        // trail reflects when they became authorized (using their
        // backgroundCheck.completedAt as a reasonable approximation,
        // falling back to "now" if missing).
        if (toStatus === 'active') {
            valet.providerAuthorization = valet.providerAuthorization || {};
            if (!valet.providerAuthorization.authorizedAt) {
                valet.providerAuthorization.authorizedAt =
                    valet.backgroundCheck?.completedAt || new Date();
            }
        }

        await valet.save();
        updated += 1;
        counts[toStatus] = (counts[toStatus] || 0) + 1;
    }

    console.log('\n=== Migration complete ===');
    console.log(`Updated:   ${updated}`);
    console.log(`Skipped:   ${skipped} (already migrated)`);
    console.log('\nStatus distribution after migration:');
    Object.entries(counts).forEach(([k, v]) => console.log(`  ${k.padEnd(28)} ${v}`));

    await mongoose.disconnect();
    console.log('\nDisconnected.');
    process.exit(0);
})().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
});
