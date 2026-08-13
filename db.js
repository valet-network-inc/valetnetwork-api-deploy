const mongoose = require('mongoose');

// Retry rather than exit. On a managed host the outbound IP can change on any
// redeploy, and a fresh IP that is not yet on the Atlas allowlist used to kill
// the process on boot — which reads as a crash loop with no useful message.
// Backs off 2s, 4s, 8s ... capped at 30s, and keeps saying why it failed.
const MAX_DELAY_MS = 30 * 1000;

// One-time repairs for indexes that block schema-declared ones from
// building. FreeSpace previously declared a plain {createdAt: 1} index;
// the schema now wants the same key pattern WITH a TTL, and Mongo
// rejects that as IndexOptionsConflict while the old index exists.
// Dropping it here lets autoIndex create the TTL version. Safe to run
// every boot: once the old index is gone this is a no-op.
const repairLegacyIndexes = async () => {
    try {
        const freespaces = mongoose.connection.db.collection('freespaces');
        const indexes = await freespaces.indexes();
        const legacy = indexes.find(
            (ix) =>
                ix.key &&
                ix.key.createdAt === 1 &&
                Object.keys(ix.key).length === 1 &&
                ix.expireAfterSeconds === undefined
        );
        if (legacy) {
            await freespaces.dropIndex(legacy.name);
            console.log(
                `Dropped legacy freespaces index ${legacy.name} so the TTL index can build.`
            );
        }
    } catch (err) {
        // Missing collection on a fresh database is fine; anything else is
        // worth a log line but must not block boot.
        if (err.codeName !== 'NamespaceNotFound') {
            console.warn('Legacy index repair skipped:', err.message);
        }
    }
};

const connectDB = async () => {
    let attempt = 0;

    for (;;) {
        try {
            await mongoose.connect(process.env.MONGO_URI);
            console.log('MongoDB Connected...');
            await repairLegacyIndexes();
            return;
        } catch (err) {
            attempt += 1;
            const delay = Math.min(1000 * 2 ** attempt, MAX_DELAY_MS);
            console.error(
                `MongoDB connect failed (attempt ${attempt}): ${err.message}. ` +
                `Retrying in ${delay / 1000}s. ` +
                `If this repeats, check the Atlas Network Access allowlist.`
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
};

module.exports = connectDB;
