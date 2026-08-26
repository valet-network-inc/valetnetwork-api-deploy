/**
 * e2erig.js — isolated full-stack backend for end-to-end testing.
 *
 * Same idea as localrig.js (in-memory mongo, schedulers off) with two
 * differences that matter for a payments test:
 *
 *   - Stripe gets the REAL key, so createPaymentIntent exercises the real
 *     Stripe call path. Every intent the suite creates is cancelled before it
 *     is ever confirmed, so nothing is ever charged.
 *   - STRIPE_WEBHOOK_SECRET is a local value the suite signs its own events
 *     with, so the webhook handler runs its real signature check against a
 *     real Stripe event payload.
 *
 * Run: STRIPE_API_KEY=sk_... node e2erig.js
 */
const { MongoMemoryServer } = require('mongodb-memory-server');

(async () => {
  const mongod = await MongoMemoryServer.create({ instance: { port: 27098 } });
  const uri = mongod.getUri();
  console.log('[e2e] mongo:', uri);

  process.env.MONGO_URI = uri;
  process.env.MONGODB_URI = uri;
  process.env.PORT = '8098';
  process.env.NODE_ENV = 'development';

  // Nothing periodic: a sweep firing mid-assertion rewrites the state under test.
  process.env.SUBS_SCHEDULER_ENABLED = 'false';
  process.env.ASP_SWEEP_ENABLED = 'false';
  process.env.AUTO_CANCEL_ENABLED = 'false';
  process.env.CLEANING_SCHEDULER_ENABLED = 'false';

  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_e2erig_local_only';
  process.env.ADMIN_API_KEY = 'e2erig';
  // Firebase stays initialised so the dispatch path runs for real, but no
  // push can reach a phone: every user in this database is synthetic, their
  // firebaseUids are made up, and no FCMToken row exists to send to.
  delete process.env.RESEND_API_KEY;
  delete process.env.SLACK_WEBHOOK_URL;

  require('./server.js');

  const stop = async () => { await mongod.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((e) => { console.error('[e2e] failed:', e); process.exit(1); });
