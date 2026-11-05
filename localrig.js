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
  // Photo and video share links (/api/photo/<token>) point back at the rig.
  process.env.PUBLIC_BACKEND_URL = 'http://localhost:8099';
  process.env.NODE_ENV = 'development';

  // Nothing periodic. A sweep or an auto-cancel firing mid-screenshot would
  // rewrite the very state we are trying to photograph.
  process.env.SUBS_SCHEDULER_ENABLED = 'false';
  process.env.UNLOCK_JOB_ENABLED = 'false';
  process.env.SCHEDULED_MOVES_ENABLED = 'false';
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
  // 500s the parking-note GET and makes the valet screens untestable. Stand in
  // for it on disk: uploads land in a temp folder and come back from a small
  // file server on :8096 (with byte ranges, which Safari needs to play a
  // video), so handoff photos and videos can be seen on the test phone.
  const fs = require('fs');
  const os = require('os');
  const pathMod = require('path');
  const RIG_FILES = pathMod.join(os.tmpdir(), 'vn-rig-files');
  fs.mkdirSync(RIG_FILES, { recursive: true });
  const rigFile = (p) => pathMod.join(RIG_FILES, String(p).replace(/\.\./g, ''));
  const storage = require('./services/firebaseStorage');
  storage.getSignedUrl = async (p) => `http://localhost:8096/${String(p).split('/').map(encodeURIComponent).join('/')}`;
  storage.uploadFile = async (buf, p) => {
      fs.mkdirSync(pathMod.dirname(rigFile(p)), { recursive: true });
      fs.writeFileSync(rigFile(p), buf);
      return { bucket: 'rig-bucket', path: p };
  };
  storage.deleteFile = async (p) => {
      try {
          fs.unlinkSync(rigFile(p));
      } catch (e) {}
      return true;
  };
  const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.heic': 'image/heic', '.mov': 'video/quicktime', '.mp4': 'video/mp4' };
  require('http')
      .createServer((req, res) => {
          const file = rigFile(decodeURIComponent(String(req.url || '').split('?')[0]).replace(/^\/+/, ''));
          let stat;
          try {
              stat = fs.statSync(file);
          } catch (e) {
              res.writeHead(404).end();
              return;
          }
          const type = TYPES[pathMod.extname(file).toLowerCase()] || 'application/octet-stream';
          const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
          if (range) {
              const start = range[1] ? Number(range[1]) : 0;
              const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
              res.writeHead(206, {
                  'Content-Type': type,
                  'Content-Length': end - start + 1,
                  'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                  'Accept-Ranges': 'bytes',
              });
              fs.createReadStream(file, { start, end }).pipe(res);
              return;
          }
          res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
          fs.createReadStream(file).pipe(res);
      })
      .listen(8096);

  // No Firebase here, so no ID tokens either. The app's rig sign-in (a dev
  // build pointed at localhost) sends "Bearer rig-<digits>" and its loginUser
  // stored firebaseUid "rig-<digits>", so this one verifier is enough for
  // requireSelf / requireValet / requireRep to see a signed-in caller.
  // Anything else is refused, as before.
  const admin = require('firebase-admin');
  const rigAuth = {
    verifyIdToken: async (token) => {
      const m = /^rig-(\d{10,15})$/.exec(String(token || ''));
      if (!m) throw new Error('rig: only rig-<digits> tokens verify here');
      return { uid: `rig-${m[1]}`, phone_number: `+${m[1]}` };
    },
  };
  Object.defineProperty(admin, 'auth', { value: () => rigAuth, configurable: true, writable: true });

  // The app's chats live in Firestore. The rig Metro points the app at this
  // stand-in instead, so rig chats never touch the live Firestore.
  const rigFs = require('./rigfirestore');
  rigFs.start(8098);

  // The API's own Firestore writes (the handoff photo and video messages, the
  // payment notes) go to the same stand-in, so a rig chat shows what a live
  // one would. Without this they failed: there is no default Firebase app here.
  const fsCall = (body) => {
    const r = rigFs.handle(body);
    if (r.status) throw new Error(r.json.error);
    return r.json;
  };
  const docRef = (path) => ({
    id: path.split('/').pop(),
    path,
    collection: (name) => colRef(`${path}/${name}`),
    get: async () => {
      const r = fsCall({ op: 'get', path });
      return { exists: r.exists, id: path.split('/').pop(), data: () => r.data || undefined };
    },
    set: async (data, opts) => fsCall({ op: 'set', path, data, merge: !!(opts && opts.merge) }),
    update: async (data) => fsCall({ op: 'update', path, data }),
    delete: async () => fsCall({ op: 'delete', path }),
  });
  const colRef = (path) => ({
    doc: (id) => docRef(`${path}/${id || require('crypto').randomBytes(10).toString('hex')}`),
    add: async (data) => docRef(`${path}/${fsCall({ op: 'add', path, data }).id}`),
  });
  const rigFirestore = () => ({ collection: (name) => colRef(name), doc: (path) => docRef(path) });
  rigFirestore.FieldValue = {
    serverTimestamp: () => ({ __fv: 'serverTimestamp' }),
    increment: (n) => ({ __fv: 'increment', n }),
    arrayUnion: (...items) => ({ __fv: 'arrayUnion', items }),
    arrayRemove: (...items) => ({ __fv: 'arrayRemove', items }),
    delete: () => ({ __fv: 'delete' }),
  };
  rigFirestore.Timestamp = { now: () => ({ __ts: Date.now() }), fromDate: (d) => ({ __ts: new Date(d).getTime() }) };
  Object.defineProperty(admin, 'firestore', { value: rigFirestore, configurable: true, writable: true });

  // Stripe on the rig: STRIPE_API_KEY is a placeholder, so real Stripe calls
  // fail here as they always have. A second car on a plan (Nov 4 2026) is
  // answered here instead (prices and subscription items only), so a rig plan
  // (seedmanaged.js) can take an extra car without a Stripe account.
  const stripeClient = require('./services/stripeClient');
  const realStripe = stripeClient.get();
  let rigItemSeq = 0;
  stripeClient.set(
    new Proxy(realStripe || {}, {
      get(target, key) {
        if (key === 'prices') {
          return {
            list: async ({ lookup_keys: keys = [] } = {}) => ({
              data: keys[0] === 'vn_home_garage_monthly' ? [{ id: 'price_rig_anchor', active: true, product: 'prod_rig_garage' }] : [],
            }),
            create: async (p) => ({ id: `price_rig_${p.lookup_key || Date.now()}` }),
          };
        }
        if (key === 'subscriptionItems') {
          return {
            create: async (p) => ({ id: `si_rig_${++rigItemSeq}`, ...p }),
            update: async (id, p) => ({ id, ...p }),
            del: async (id) => ({ id, deleted: true }),
          };
        }
        return target[key];
      },
    })
  );

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
