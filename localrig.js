/**
 * localrig.js — throwaway backend for screenshotting the app.
 *
 * Lives INSIDE the backend clone on purpose: node cannot resolve this repo's
 * modules from anywhere else. In-memory Mongo on :27099, API on :8099, every
 * scheduler off so nothing dispatches a real valet or moves real money.
 *
 * Run:  node localrig.js
 * Stop: ctrl-c (the data dies with it)
 */
const { MongoMemoryServer } = require('mongodb-memory-server');

(async () => {
  const mongod = await MongoMemoryServer.create({ instance: { port: 27099 } });
  const uri = mongod.getUri();
  console.log('[rig] mongo:', uri);

  process.env.MONGO_URI = uri;
  process.env.MONGODB_URI = uri;
  process.env.PORT = '8099';
  process.env.NODE_ENV = 'development';

  // Nothing periodic. A sweep or an auto-cancel firing mid-screenshot would
  // rewrite the very state we are trying to photograph.
  process.env.SUBS_SCHEDULER_ENABLED = 'false';
  process.env.ASP_SWEEP_ENABLED = 'false';
  process.env.AUTO_CANCEL_ENABLED = 'false';
  process.env.CLEANING_SCHEDULER_ENABLED = 'false';
  // The curb-sweep MOVER would book a real move order mid-screenshot. The
  // WATCHDOG stays on deliberately: it is read-mostly, and its reconciler is
  // what gives a seeded managed car its custody row without extra setup.
  process.env.CURB_SWEEP_ENABLED = 'false';

  // Never a live key here. Nothing in the screenshot path charges anything —
  // order state is written straight into mongo by seed.js.
  process.env.STRIPE_API_KEY =
    process.env.STRIPE_API_KEY || 'sk_test_placeholder_not_used_by_the_rig';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_placeholder';
  process.env.ADMIN_API_KEY = 'localrig';

  // Firebase is not configured here, and getSignedUrl throws without it — which
  // 500s the parking-note GET and makes the valet screens untestable. Stub it:
  // the rig never stores a real photo, and no screenshot depends on one loading.
  const storage = require('./services/firebaseStorage');
  storage.getSignedUrl = async (path) => `https://rig.local/${path}`;
  storage.uploadFile = async (buf, path) => ({ bucket: 'rig-bucket', path });
  storage.deleteFile = async () => true;

  require('./server.js');

  const stop = async () => {
    await mongod.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((e) => {
  console.error('[rig] failed:', e);
  process.exit(1);
});
