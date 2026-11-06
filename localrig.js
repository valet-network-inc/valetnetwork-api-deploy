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
  // Payments on the rig (Nov 5 2026), so the app's Pay with row and its
  // Apple Pay / saved-card / new-card paths can be walked without a Stripe
  // account: customers, cards and intents live in memory, and :8095/pay
  // marks an intent paid by sending the real webhook a 'rig'-signed event.
  // Plans, refunds, promo coupons and gift balances too (Nov 5 2026), so a
  // plan can be bought, a code applied, a parking cancelled with its refund,
  // and a tip or added time charged to the saved card, all on the rig.
  const rigStripe = {
    seq: 0,
    customers: new Map(),
    pms: new Map(),
    intents: new Map(),
    subs: new Map(),
    invoices: new Map(),
    coupons: new Map(),
    prices: new Map(),
  };
  // Shaped like Stripe's (prefix, one underscore, no more): the app's Stripe SDK
  // traps in a debug build on a client secret that isn't `pi_x_secret_y`.
  const rigId = (p) => `${p}_rig${(++rigStripe.seq).toString(36)}`;
  const rigNow = () => Math.floor(Date.now() / 1000);
  const rigMissing = (kind, id) => {
    const e = new Error(`No such ${kind}: '${id}'`);
    e.type = 'StripeInvalidRequestError';
    e.statusCode = 404;
    e.code = 'resource_missing';
    return e;
  };
  // Stripe's webhook, as Stripe would send it: signed 'rig', to the API's own endpoint.
  const rigHook = (type, object) =>
    new Promise((resolve) => {
      const body = JSON.stringify({ id: rigId('evt'), type, data: { object } });
      const r = require('http').request(
        { host: '127.0.0.1', port: Number(process.env.PORT || 8099), path: '/api/payment/webhook', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'stripe-signature': 'rig' } },
        (hr) => {
          let t = '';
          hr.on('data', (c) => (t += c));
          hr.on('end', () => resolve({ type, status: hr.statusCode, body: t.slice(0, 200) }));
        }
      );
      r.on('error', (e) => resolve({ type, status: 0, body: e.message }));
      r.end(body);
    });
  const rigIntent = (kind, params) => {
    const id = rigId(kind === 'setup' ? 'seti' : 'pi');
    const it = { id, object: kind === 'setup' ? 'setup_intent' : 'payment_intent', client_secret: `${id}_secret_rig`, status: 'requires_payment_method', created: rigNow(), ...params, amount_received: 0 };
    rigStripe.intents.set(id, it);
    // A charge made without the user there (a tip, a partner's added time, a
    // booked run): a saved card goes through at once, as Stripe's does, and
    // the webhook follows.
    if (kind === 'payment' && params && params.confirm && params.payment_method) {
      it.status = 'succeeded';
      it.amount_received = it.amount;
      setTimeout(() => rigHook('payment_intent.succeeded', it), 50);
    }
    return it;
  };
  // The plan catalog (scripts/ensureSubscriptionCatalog.js mints these on
  // Stripe), read from the script so the rig's prices stay the same.
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'scripts/ensureSubscriptionCatalog.js'), 'utf8');
    const re = /lookupKey:\s*'([^']+)',\s*amount:\s*(\d+),\s*interval:\s*'(\w+)'/g;
    let m;
    while ((m = re.exec(src))) {
      const price = { id: `price_rig${m[1].replace(/_/g, '')}`, object: 'price', active: true, product: 'prod_rig_catalog', lookup_key: m[1], unit_amount: Number(m[2]), currency: 'usd', recurring: { interval: m[3] } };
      rigStripe.prices.set(price.id, price);
    }
  }
  const rigPeriodEnd = (from, interval, count = 1) => {
    const d = new Date(from * 1000);
    if (interval === 'week') d.setDate(d.getDate() + 7 * count);
    else if (interval === 'day') d.setDate(d.getDate() + count);
    else if (interval === 'year') d.setFullYear(d.getFullYear() + count);
    else d.setMonth(d.getMonth() + count);
    return Math.floor(d.getTime() / 1000);
  };
  const RIG_STRIPE = {
    customers: {
      create: async (p = {}) => {
        const c = { id: rigId('cus'), object: 'customer', balance: 0, invoice_settings: { default_payment_method: null }, metadata: p.metadata || {}, name: p.name };
        rigStripe.customers.set(c.id, c);
        return c;
      },
      retrieve: async (id) => rigStripe.customers.get(id) || { id, object: 'customer', balance: 0, invoice_settings: { default_payment_method: null } },
      update: async (id, p = {}) => {
        const c = rigStripe.customers.get(id) || { id, balance: 0, invoice_settings: {} };
        if (p.invoice_settings) c.invoice_settings = { ...c.invoice_settings, ...p.invoice_settings };
        rigStripe.customers.set(id, c);
        return c;
      },
      // Gift cards: a credit is a negative balance, as on Stripe.
      createBalanceTransaction: async (id, p = {}) => {
        const c = rigStripe.customers.get(id) || { id, object: 'customer', balance: 0, invoice_settings: { default_payment_method: null } };
        c.balance = (Number(c.balance) || 0) + (Number(p.amount) || 0);
        rigStripe.customers.set(id, c);
        return { id: rigId('cbtxn'), object: 'customer_balance_transaction', amount: p.amount, currency: 'usd', customer: id, ending_balance: c.balance, description: p.description };
      },
    },
    ephemeralKeys: { create: async () => ({ secret: 'ek_rig' }) },
    paymentMethods: {
      list: async ({ customer } = {}) => ({ data: [...rigStripe.pms.values()].filter((pm) => pm.customer === customer).reverse() }),
      retrieve: async (id) => rigStripe.pms.get(id) || null,
      attach: async (id, { customer }) => {
        const pm = rigStripe.pms.get(id);
        if (pm) pm.customer = customer;
        return pm;
      },
    },
    paymentIntents: {
      create: async (p = {}) => rigIntent('payment', p),
      retrieve: async (id) => rigStripe.intents.get(id) || null,
      update: async (id, p = {}) => Object.assign(rigStripe.intents.get(id) || { id }, p),
      cancel: async (id) => Object.assign(rigStripe.intents.get(id) || { id }, { status: 'canceled' }),
    },
    setupIntents: {
      create: async (p = {}) => rigIntent('setup', p),
      retrieve: async (id) => rigStripe.intents.get(id) || null,
    },
    refunds: {
      create: async (p = {}) => {
        const pi = p.payment_intent ? rigStripe.intents.get(p.payment_intent) : null;
        const amount = p.amount != null ? p.amount : pi ? pi.amount_received || pi.amount || 0 : 0;
        if (pi) pi.amount_refunded = (pi.amount_refunded || 0) + amount;
        return { id: rigId('re'), object: 'refund', status: 'succeeded', amount, currency: 'usd', payment_intent: p.payment_intent || null, charge: p.charge || null, metadata: p.metadata || {} };
      },
    },
    // Plan prices: the old garage anchor, plus every price minted on the rig.
    prices: {
      list: async ({ lookup_keys: keys = [] } = {}) => ({
        data: [...rigStripe.prices.values()].filter((x) => keys.includes(x.lookup_key)),
      }),
      create: async (p = {}) => {
        const price = { id: `price_rig_${p.lookup_key || rigStripe.seq++}`, object: 'price', active: true, ...p };
        rigStripe.prices.set(price.id, price);
        return price;
      },
      retrieve: async (id) => {
        const price = rigStripe.prices.get(id);
        if (!price) throw rigMissing('price', id);
        return price;
      },
    },
    coupons: {
      create: async (p = {}) => {
        const c = { object: 'coupon', valid: true, ...p, id: p.id || rigId('co') };
        rigStripe.coupons.set(c.id, c);
        return c;
      },
      retrieve: async (id) => {
        const c = rigStripe.coupons.get(id);
        if (!c) throw rigMissing('coupon', id);
        return c;
      },
    },
    // A plan: created incomplete with its first invoice open (or trialing, or
    // paid at once when a code takes it to $0), made active by :8095/pay.
    subscriptions: {
      create: async (p = {}) => {
        const now = rigNow();
        const items = (p.items || []).map((it) => {
          const price = rigStripe.prices.get(it.price) || { id: it.price, unit_amount: 0, recurring: { interval: 'month' } };
          return { id: rigId('si'), object: 'subscription_item', price, quantity: it.quantity || 1 };
        });
        let amount = items.reduce((sum, it) => sum + (Number(it.price.unit_amount) || 0) * it.quantity, 0);
        for (const d of p.discounts || []) {
          const c = d && d.coupon ? rigStripe.coupons.get(d.coupon) : null;
          if (c && c.percent_off) amount = Math.round(amount * (1 - c.percent_off / 100));
          else if (c && c.amount_off) amount = Math.max(0, amount - c.amount_off);
        }
        const recurring = (items[0] && items[0].price.recurring) || { interval: 'month' };
        const trialEnd = p.trial_period_days ? now + p.trial_period_days * 86400 : null;
        const id = rigId('sub');
        const sub = {
          id,
          object: 'subscription',
          customer: p.customer,
          status: trialEnd ? 'trialing' : amount > 0 ? 'incomplete' : 'active',
          items: { object: 'list', data: items },
          metadata: p.metadata || {},
          created: now,
          current_period_start: now,
          current_period_end: trialEnd || rigPeriodEnd(now, recurring.interval, recurring.interval_count || 1),
          trial_end: trialEnd,
          cancel_at_period_end: false,
          default_payment_method: null,
          pending_setup_intent: null,
          discounts: p.discounts || [],
        };
        const inv = {
          id: rigId('in'),
          object: 'invoice',
          subscription: id,
          customer: p.customer,
          created: now,
          amount_due: trialEnd ? 0 : amount,
          amount_paid: 0,
          status: trialEnd || amount === 0 ? 'paid' : 'open',
          payment_intent: null,
          charge: null,
          lines: { data: [{ subscription: id, amount }] },
        };
        if (!trialEnd && amount > 0) {
          inv.payment_intent = rigIntent('payment', { amount, currency: 'usd', customer: p.customer, invoice: inv.id, metadata: {}, setup_future_usage: 'off_session' });
        }
        rigStripe.invoices.set(inv.id, inv);
        sub.latest_invoice = inv;
        rigStripe.subs.set(id, sub);
        return sub;
      },
      retrieve: async (id) => {
        const sub = rigStripe.subs.get(id);
        if (!sub) throw rigMissing('subscription', id);
        return sub;
      },
      update: async (id, p = {}) => {
        const sub = rigStripe.subs.get(id);
        if (!sub) throw rigMissing('subscription', id);
        const { items, proration_behavior, expand, ...rest } = p;
        Object.assign(sub, rest);
        for (const it of items || []) {
          const at = it.id ? sub.items.data.findIndex((x) => x.id === it.id) : -1;
          if (it.deleted) {
            if (at >= 0) sub.items.data.splice(at, 1);
            continue;
          }
          const price = it.price ? rigStripe.prices.get(it.price) || { id: it.price, unit_amount: 0, recurring: { interval: 'month' } } : null;
          if (at >= 0) {
            if (price) sub.items.data[at].price = price;
            if (it.quantity) sub.items.data[at].quantity = it.quantity;
          } else if (price) {
            sub.items.data.push({ id: rigId('si'), object: 'subscription_item', price, quantity: it.quantity || 1 });
          }
        }
        return sub;
      },
      cancel: async (id) => {
        const sub = rigStripe.subs.get(id);
        if (!sub) throw rigMissing('subscription', id);
        sub.status = 'canceled';
        sub.canceled_at = rigNow();
        sub.ended_at = sub.canceled_at;
        return sub;
      },
    },
    invoices: {
      retrieve: async (id) => {
        const inv = rigStripe.invoices.get(id);
        if (!inv) throw rigMissing('invoice', id);
        return inv;
      },
      list: async ({ subscription, customer, status, limit = 10 } = {}) => ({
        object: 'list',
        has_more: false,
        data: [...rigStripe.invoices.values()]
          .filter((inv) => (!subscription || inv.subscription === subscription) && (!customer || inv.customer === customer) && (!status || inv.status === status))
          .sort((a, b) => b.created - a.created)
          .slice(0, limit),
      }),
    },
    webhooks: {
      // The rig's own events only; anything else is refused as before.
      constructEvent: (body, sig) => {
        if (sig !== 'rig') throw new Error('rig: only rig-signed events');
        return JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : JSON.stringify(body));
      },
    },
  };
  // Controllers build their own client from the 'stripe' package at load
  // (paymentController, orderController, extensionController), so the rig
  // swaps the package itself, before server.js loads them.
  {
    const RealStripe = require('stripe');
    const rigFactory = function rigStripeFactory(...args) {
      const real = RealStripe(...args);
      return new Proxy(real, { get: (t, k) => RIG_STRIPE[k] || t[k] });
    };
    Object.assign(rigFactory, RealStripe);
    require.cache[require.resolve('stripe')].exports = rigFactory;
  }
  require('http')
    .createServer((req, res) => {
      // /park in a browser on localhost pays through here too.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') return res.writeHead(204).end();
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        try {
          if (req.method === 'GET' && req.url.startsWith('/intent?')) {
            const secret = new URL(req.url, 'http://rig').searchParams.get('clientSecret');
            const found = [...rigStripe.intents.values()].find((x) => x.client_secret === secret);
            return res
              .writeHead(found ? 200 : 404, { 'Content-Type': 'application/json' })
              .end(JSON.stringify(found ? { id: found.id, status: found.status, amount: found.amount } : { error: 'No such intent on the rig' }));
          }
          if (req.method !== 'POST' || req.url !== '/pay') return res.writeHead(404).end();
          const { clientSecret, paymentMethod } = JSON.parse(raw || '{}');
          const it = [...rigStripe.intents.values()].find((x) => x.client_secret === clientSecret);
          if (!it) return res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'No such intent on the rig' }));
          // The card it was paid with: kept on the customer, as Stripe does with setup_future_usage.
          const pm = { id: paymentMethod?.id && String(paymentMethod.id).startsWith('pm_') ? paymentMethod.id : rigId('pm'), object: 'payment_method', created: Math.floor(Date.now() / 1000), customer: it.customer || null, card: { brand: paymentMethod?.brand || 'visa', last4: paymentMethod?.last4 || '4242', exp_month: 12, exp_year: 2030, fingerprint: `fp_${paymentMethod?.brand || 'visa'}_${paymentMethod?.last4 || '4242'}_${paymentMethod?.wallet || ''}`, wallet: paymentMethod?.wallet ? { type: paymentMethod.wallet } : null } };
          if (it.customer && (it.setup_future_usage || it.object === 'setup_intent')) rigStripe.pms.set(pm.id, pm);
          it.status = 'succeeded';
          it.payment_method = pm.id;
          if (it.object === 'payment_intent') it.amount_received = it.amount;
          const hooks = [await rigHook(it.object === 'setup_intent' ? 'setup_intent.succeeded' : 'payment_intent.succeeded', it)];
          // A plan's first invoice: paid, the card becomes the plan's, and the plan runs.
          const inv = it.invoice ? rigStripe.invoices.get(it.invoice) : null;
          if (inv) {
            inv.status = 'paid';
            inv.amount_paid = it.amount;
            const sub = rigStripe.subs.get(inv.subscription);
            if (sub) {
              if (sub.status === 'incomplete') sub.status = 'active';
              sub.default_payment_method = pm.id;
            }
            hooks.push(await rigHook('invoice.paid', { ...inv, payment_intent: it.id }));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, intent: it.id, paymentMethod: pm.id, webhooks: hooks }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message }));
        }
      });
    })
    .listen(8095, '127.0.0.1');
  stripeClient.set(
    new Proxy(realStripe || {}, {
      get(target, key) {
        if (RIG_STRIPE[key]) return RIG_STRIPE[key];
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
