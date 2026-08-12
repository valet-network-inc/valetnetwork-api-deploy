const mongoose = require('mongoose');

// Retry rather than exit. On a managed host the outbound IP can change on any
// redeploy, and a fresh IP that is not yet on the Atlas allowlist used to kill
// the process on boot — which reads as a crash loop with no useful message.
// Backs off 2s, 4s, 8s ... capped at 30s, and keeps saying why it failed.
const MAX_DELAY_MS = 30 * 1000;

const connectDB = async () => {
    let attempt = 0;

    for (;;) {
        try {
            await mongoose.connect(process.env.MONGO_URI);
            console.log('MongoDB Connected...');
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
