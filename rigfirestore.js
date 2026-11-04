/**
 * rigfirestore.js — a Firestore stand-in for the local test rig.
 *
 * The rig Metro (the app's scripts/metro.rig.config.js) swaps the app's
 * @react-native-firebase/firestore for a shim that calls this. One in-memory
 * document store shared by every phone on the rig, so a valet on one simulator
 * and a user on another share chats and handoffs, and nothing the rig does
 * ever reaches the live Firestore. The data dies with the process.
 *
 * POST /fs  { op: get|set|update|add|delete|query, path, ... }
 */
const http = require('http');

const docs = new Map(); // 'conversations/abc' -> data
const autoId = () => {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 20; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
};

const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v) && !('__ts' in v) && !('__fv' in v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A written value, with the sentinels (serverTimestamp, increment, ...) applied
// against what was there before.
function resolve(v, prev) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    switch (v.__fv) {
      case 'serverTimestamp':
        return { __ts: Date.now() };
      case 'increment':
        return (typeof prev === 'number' ? prev : 0) + Number(v.n || 0);
      case 'arrayUnion': {
        const out = Array.isArray(prev) ? prev.slice() : [];
        for (const x of v.items || []) if (!out.some((y) => same(x, y))) out.push(x);
        return out;
      }
      case 'arrayRemove':
        return (Array.isArray(prev) ? prev : []).filter((y) => !(v.items || []).some((x) => same(x, y)));
      case 'delete':
        return undefined;
      default:
        break;
    }
    if ('__ts' in v) return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const r = resolve(x, prev && typeof prev === 'object' ? prev[k] : undefined);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => resolve(x));
  return v;
}

// set(..., { merge: true }): maps merge field by field, everything else replaces.
function deepMerge(target, src) {
  const out = { ...(target || {}) };
  for (const [k, v] of Object.entries(src || {})) {
    if (v && v.__fv === 'delete') delete out[k];
    else if (isMap(v) && isMap(out[k])) out[k] = deepMerge(out[k], v);
    else {
      const r = resolve(v, out[k]);
      if (r === undefined) delete out[k];
      else out[k] = r;
    }
  }
  return out;
}

// update(): each key replaces its field; 'a.b' reaches into a map.
function applyUpdate(target, src) {
  const out = JSON.parse(JSON.stringify(target || {}));
  for (const [key, v] of Object.entries(src || {})) {
    const parts = key.split('.');
    let at = out;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!isMap(at[parts[i]])) at[parts[i]] = {};
      at = at[parts[i]];
    }
    const leaf = parts[parts.length - 1];
    const r = resolve(v, at[leaf]);
    if (r === undefined) delete at[leaf];
    else at[leaf] = r;
  }
  return out;
}

const field = (data, path) =>
  String(path)
    .split('.')
    .reduce((a, k) => (a == null ? undefined : a[k]), data);
const plain = (v) => (v && typeof v === 'object' && '__ts' in v ? v.__ts : v);
const cmp = (a, b) => {
  const x = plain(a);
  const y = plain(b);
  if (x === y) return 0;
  if (x === undefined || x === null) return -1;
  if (y === undefined || y === null) return 1;
  return x < y ? -1 : 1;
};

function matches(data, [f, op, value]) {
  const v = field(data, f);
  switch (op) {
    case '==':
      return same(plain(v), plain(value));
    case '!=':
      return v !== undefined && !same(plain(v), plain(value));
    case '<':
      return v !== undefined && cmp(v, value) < 0;
    case '<=':
      return v !== undefined && cmp(v, value) <= 0;
    case '>':
      return v !== undefined && cmp(v, value) > 0;
    case '>=':
      return v !== undefined && cmp(v, value) >= 0;
    case 'in':
      return (value || []).some((x) => same(plain(v), plain(x)));
    case 'not-in':
      return v !== undefined && !(value || []).some((x) => same(plain(v), plain(x)));
    case 'array-contains':
      return Array.isArray(v) && v.some((x) => same(x, value));
    case 'array-contains-any':
      return Array.isArray(v) && v.some((x) => (value || []).some((y) => same(x, y)));
    default:
      return false;
  }
}

function query({ path, wheres = [], orderBy = [], limit = null }) {
  const depth = path.split('/').length + 1;
  let rows = [];
  for (const [p, data] of docs) {
    if (p.startsWith(`${path}/`) && p.split('/').length === depth) rows.push({ id: p.split('/').pop(), data });
  }
  rows = rows.filter((r) => wheres.every((w) => matches(r.data, w)));
  // Like Firestore, ordering by a field leaves out the docs without it.
  for (const [f] of orderBy) rows = rows.filter((r) => field(r.data, f) !== undefined);
  rows.sort((a, b) => {
    for (const [f, dir] of orderBy) {
      const c = cmp(field(a.data, f), field(b.data, f));
      if (c) return dir === 'desc' ? -c : c;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  if (limit != null) rows = rows.slice(0, limit);
  return rows;
}

function handle(body) {
  const { op, path } = body;
  if (!path || typeof path !== 'string') return { status: 400, json: { error: 'path is required' } };
  switch (op) {
    case 'get':
      return { json: docs.has(path) ? { exists: true, data: docs.get(path) } : { exists: false, data: null } };
    case 'set':
      docs.set(path, body.merge ? deepMerge(docs.get(path), body.data) : resolve(body.data));
      return { json: { ok: true } };
    case 'update':
      if (!docs.has(path)) return { status: 404, json: { error: `No document to update: ${path}`, code: 'firestore/not-found' } };
      docs.set(path, applyUpdate(docs.get(path), body.data));
      return { json: { ok: true } };
    case 'add': {
      const id = autoId();
      docs.set(`${path}/${id}`, resolve(body.data));
      return { json: { id } };
    }
    case 'delete':
      docs.delete(path);
      return { json: { ok: true } };
    case 'query':
      return { json: { docs: query(body) } };
    default:
      return { status: 400, json: { error: `unknown op ${op}` } };
  }
}

function start(port = 8098) {
  const server = http.createServer((req, res) => {
    const send = (status, json) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.method === 'GET' && req.url === '/fs/dump') return send(200, Object.fromEntries(docs));
    if (req.method !== 'POST' || req.url !== '/fs') return send(404, { error: 'not found' });
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        const out = handle(JSON.parse(raw || '{}'));
        send(out.status || 200, out.json);
      } catch (e) {
        send(500, { error: e.message });
      }
    });
  });
  server.listen(port, () => console.log(`[rig] firestore stand-in: http://localhost:${port}/fs`));
  return server;
}

module.exports = { start, handle, docs };
