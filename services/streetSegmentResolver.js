/**
 * Street segment resolver — turns a tap coord into the actual block-level
 * polyline between two cross-streets, using OpenStreetMap's Overpass API.
 *
 * Why Overpass (and not Google/Apple/HERE/Mapbox):
 *   - Free, no API key, no per-request billing
 *   - Has real road geometry as a list of node coords
 *   - Has intersection topology (we can find cross-streets as nodes that
 *     belong to ≥2 highway ways)
 *
 * Latency: typical 0.5–2s per query. We cache by a coarse tile (~100m
 * lat/lng grid) so repeated marks on the same block hit memory.
 *
 * Failure mode: if Overpass times out or returns nothing useful, callers
 * fall back to the fixed-line approximation. We never throw — return
 * null and let the controller decide.
 */

const axios = require('axios');

const OVERPASS_ENDPOINT =
    process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const REQUEST_TIMEOUT_MS = 6000;
const SEARCH_RADIUS_METERS = 80;

// Tile = bucket of ~100m. Round coord to 0.001° (≈ 111m at the equator,
// ≈ 84m at NYC's latitude). Good enough to dedupe queries on the same
// block without colliding adjacent blocks.
const TILE_PRECISION = 1000;

const tileKey = (lat, lng, street) =>
    `${Math.round(lat * TILE_PRECISION)}:${Math.round(
        lng * TILE_PRECISION
    )}:${(street || '').toLowerCase()}`;

const cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 1000;

const setCache = (key, value) => {
    if (cache.size >= CACHE_MAX_ENTRIES) {
        // Drop the oldest entry — Map preserves insertion order.
        const firstKey = cache.keys().next().value;
        cache.delete(firstKey);
    }
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
};
const getCache = (key) => {
    const hit = cache.get(key);
    if (!hit) return null;
    if (hit.expiresAt < Date.now()) {
        cache.delete(key);
        return null;
    }
    return hit.value;
};

const haversineMeters = (a, b) => {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const x =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) *
            Math.cos(toRad(b.lat)) *
            Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
};

/**
 * Build an Overpass QL query for the road network around a tap. We pull
 * EVERY named highway near the tap (not filtered by name) plus every
 * other highway way that shares a node with one of them. We then pick
 * the closest way by geometry. Filtering by name was the wrong
 * primitive — Apple's reverse geocoder and OSM disagree about street
 * names often enough ("24th Street" vs "24th Avenue" in Astoria, ave
 * vs avenue, st vs street, etc.) that name-matching produced silent
 * fallbacks to a client-supplied straight line.
 */
const buildQuery = (lat, lng) => {
    return `
[out:json][timeout:5];
(
  way["highway"]["name"](around:${SEARCH_RADIUS_METERS},${lat},${lng});
)->.target;
(
  node(w.target)->.targetNodes;
  way["highway"](bn.targetNodes)->.crossing;
);
(.target; .targetNodes; .crossing;);
out geom;
`.trim();
};

/**
 * Locate the closest named way to the tap and slice its geometry to the
 * block bounded by the two nearest intersection nodes. Uses pure
 * geometry — no name matching — so it works regardless of how the
 * caller spelled the street.
 *
 * Returns { path, endpoint1, endpoint2, crossStreet1, crossStreet2,
 * streetName } or null.
 */
const sliceToBlock = (elements, tap) => {
    if (!Array.isArray(elements) || elements.length === 0) return null;

    const namedWays = elements.filter(
        (el) =>
            el.type === 'way' &&
            el.tags?.highway &&
            el.tags?.name &&
            Array.isArray(el.geometry)
    );
    if (namedWays.length === 0) return null;

    // Pick the way whose closest node is nearest to the tap.
    let bestWay = null;
    let bestDist = Infinity;
    for (const w of namedWays) {
        for (const node of w.geometry) {
            const d = haversineMeters(tap, { lat: node.lat, lng: node.lon });
            if (d < bestDist) {
                bestDist = d;
                bestWay = w;
            }
        }
    }
    if (!bestWay) return null;

    const bestName = bestWay.tags.name;

    // Build a node-id → coord map for the chosen way and figure out which
    // of its nodes are intersections — i.e. shared with another highway
    // way that has a DIFFERENT name (own-name nodes that just split the
    // way across data tiles aren't intersections).
    const otherWays = elements.filter(
        (el) =>
            el.type === 'way' &&
            el.tags?.highway &&
            el.id !== bestWay.id &&
            (el.tags?.name || '').toLowerCase() !==
                (bestName || '').toLowerCase()
    );
    const intersectionNodeIds = new Set();
    const crossNameById = new Map();
    for (const w of otherWays) {
        for (const nid of w.nodes || []) {
            if (bestWay.nodes?.includes(nid)) {
                intersectionNodeIds.add(nid);
                if (w.tags?.name) crossNameById.set(nid, w.tags.name);
            }
        }
    }

    const nodeIdx = (bestWay.nodes || []).map((id, i) => ({ id, i }));
    const intersectionIdx = nodeIdx.filter((n) =>
        intersectionNodeIds.has(n.id)
    );
    if (intersectionIdx.length < 2) {
        // Not enough intersections to bound a block — return the entire
        // way's geometry. Better than collapsing to a straight line that
        // could cut diagonally across other streets.
        const fullPath = bestWay.geometry.map((n) => ({
            lat: n.lat,
            lng: n.lon,
        }));
        return {
            path: fullPath,
            endpoint1: fullPath[0],
            endpoint2: fullPath[fullPath.length - 1],
            crossStreet1: '',
            crossStreet2: '',
            streetName: bestName,
        };
    }

    // Find the tap's "position along the way" — the index of the way node
    // closest to the tap. The block is bounded by the nearest intersection
    // before and after that index.
    let tapIdx = 0;
    let tapDist = Infinity;
    for (let i = 0; i < bestWay.geometry.length; i++) {
        const n = bestWay.geometry[i];
        const d = haversineMeters(tap, { lat: n.lat, lng: n.lon });
        if (d < tapDist) {
            tapDist = d;
            tapIdx = i;
        }
    }

    const before = intersectionIdx
        .filter((n) => n.i <= tapIdx)
        .sort((a, b) => b.i - a.i)[0];
    const after = intersectionIdx
        .filter((n) => n.i > tapIdx)
        .sort((a, b) => a.i - b.i)[0];

    // If the tap is past the last intersection or before the first, use the
    // two nearest intersections regardless of side.
    let lowIdx, highIdx;
    if (before && after) {
        lowIdx = before.i;
        highIdx = after.i;
    } else {
        const sorted = intersectionIdx
            .slice()
            .sort(
                (a, b) =>
                    Math.abs(a.i - tapIdx) - Math.abs(b.i - tapIdx)
            )
            .slice(0, 2)
            .sort((a, b) => a.i - b.i);
        lowIdx = sorted[0].i;
        highIdx = sorted[1].i;
    }

    // Slice the full geometry between the two bounding intersections so
    // the rendered polyline traces the actual street path (curves and
    // all), not a straight line that could cut across other streets.
    const sliced = bestWay.geometry.slice(lowIdx, highIdx + 1).map((n) => ({
        lat: n.lat,
        lng: n.lon,
    }));
    const cross1Id = bestWay.nodes[lowIdx];
    const cross2Id = bestWay.nodes[highIdx];

    return {
        path: sliced,
        endpoint1: sliced[0],
        endpoint2: sliced[sliced.length - 1],
        crossStreet1: crossNameById.get(cross1Id) || '',
        crossStreet2: crossNameById.get(cross2Id) || '',
        streetName: bestName,
    };
};

/**
 * @param {{lat:number, lng:number}} tap
 * @param {string} [streetName] — optional, no longer used for matching;
 *   kept as the cache key fallback so older callers still benefit from
 *   the cache.
 * @returns {Promise<{path, endpoint1, endpoint2, crossStreet1, crossStreet2, streetName} | null>}
 */
exports.resolveBlockSegment = async (tap, streetName) => {
    if (!tap || typeof tap.lat !== 'number' || typeof tap.lng !== 'number') {
        return null;
    }
    // Cache by tile only — name is no longer load-bearing.
    const key = tileKey(tap.lat, tap.lng, '');
    const cached = getCache(key);
    if (cached) return cached;

    try {
        // Overpass requires form-encoded `data=<query>`. Apache also
        // rejects requests with no User-Agent (406), so identify ourselves
        // per Overpass fair-use policy.
        const params = new URLSearchParams();
        params.append('data', buildQuery(tap.lat, tap.lng));
        const res = await axios.post(OVERPASS_ENDPOINT, params, {
            timeout: REQUEST_TIMEOUT_MS,
            headers: {
                'User-Agent': 'ValetNetwork/1.2 (ops@valetnetwork.co)',
                Accept: 'application/json',
            },
        });
        const sliced = sliceToBlock(res.data?.elements || [], tap);
        if (sliced) setCache(key, sliced);
        return sliced;
    } catch (err) {
        console.warn(
            `Overpass resolver failed (${streetName || 'unnamed'} @ ${tap.lat},${tap.lng}): ${err.message}`
        );
        return null;
    }
};

/* ──────────────────────────────────────────────────────────────────────
 *  Area-wide street network resolver — drives the new tap-on-line UX.
 *
 *  Returns every block-side polyline within `radiusMeters` of the tap,
 *  pre-offset perpendicular to the street so each side sits ~5m off the
 *  centerline (next to the curb). Mobile renders these as the always-on
 *  base layer the valet taps to mark availability.
 * ──────────────────────────────────────────────────────────────────────*/

const AREA_RADIUS_DEFAULT = 200;
const SIDE_OFFSET_METERS = 5;

const areaCache = new Map();
const AREA_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const buildAreaQuery = (lat, lng, radiusMeters) =>
    `[out:json][timeout:8];(way["highway"]["name"](around:${radiusMeters},${lat},${lng}););out geom;`.trim();

const areaTileKey = (lat, lng, radius) =>
    // Tile by ~200m grid so panning the map within one block reuses cache.
    `${Math.round(lat * 1000)}:${Math.round(lng * 1000)}:${radius}`;

/**
 * Perpendicular-offset a path (list of {lat,lng}) by `offsetMeters` on
 * `side` ('side1' = left when walking start→end, 'side2' = right).
 * Internal nodes use the bisector of adjacent segments so curves stay
 * smooth.
 */
const offsetPath = (path, offsetMeters, side) => {
    const sign = side === 'side1' ? 1 : -1;
    const out = [];
    for (let i = 0; i < path.length; i++) {
        const p = path[i];
        const prev = i > 0 ? path[i - 1] : null;
        const next = i < path.length - 1 ? path[i + 1] : null;
        const cosLat = Math.cos((p.lat * Math.PI) / 180);
        let fE, fN;
        if (prev && next) {
            fE = (next.lng - prev.lng) * 111000 * cosLat;
            fN = (next.lat - prev.lat) * 111000;
        } else if (next) {
            fE = (next.lng - p.lng) * 111000 * cosLat;
            fN = (next.lat - p.lat) * 111000;
        } else if (prev) {
            fE = (p.lng - prev.lng) * 111000 * cosLat;
            fN = (p.lat - prev.lat) * 111000;
        } else {
            out.push({ lat: p.lat, lng: p.lng });
            continue;
        }
        const mag = Math.sqrt(fE * fE + fN * fN);
        if (mag === 0) {
            out.push({ lat: p.lat, lng: p.lng });
            continue;
        }
        // Left perpendicular (CCW in east-north plane): (-fN, fE)
        const perpE = (-fN / mag) * offsetMeters * sign;
        const perpN = (fE / mag) * offsetMeters * sign;
        const dLat = perpN / 111000;
        const dLng = perpE / (111000 * cosLat);
        out.push({ lat: p.lat + dLat, lng: p.lng + dLng });
    }
    return out;
};

/**
 * Walk a way's node list, find every index that's an intersection with
 * a differently-named way, and split the way into "block" sub-segments.
 * Returns [{ startIdx, endIdx, crossStart, crossEnd }, ...].
 */
const splitWayIntoBlocks = (way, nodeToWays) => {
    if (!Array.isArray(way.nodes) || way.nodes.length < 2) return [];
    const myName = (way.tags?.name || '').toLowerCase();
    const intersections = [];
    for (let i = 0; i < way.nodes.length; i++) {
        const nid = way.nodes[i];
        const sharers = nodeToWays.get(nid) || [];
        const cross = sharers.find(
            (w) =>
                w.id !== way.id &&
                (w.tags?.name || '').toLowerCase() !== '' &&
                (w.tags?.name || '').toLowerCase() !== myName
        );
        if (cross) intersections.push({ i, name: cross.tags.name });
    }
    if (intersections.length === 0) {
        return [
            {
                startIdx: 0,
                endIdx: way.geometry.length - 1,
                crossStart: '',
                crossEnd: '',
            },
        ];
    }
    // First sub-segment: way's start → first intersection (open-ended block)
    const segs = [];
    if (intersections[0].i > 0) {
        segs.push({
            startIdx: 0,
            endIdx: intersections[0].i,
            crossStart: '',
            crossEnd: intersections[0].name,
        });
    }
    // Middle sub-segments: intersection k → intersection k+1
    for (let k = 0; k < intersections.length - 1; k++) {
        segs.push({
            startIdx: intersections[k].i,
            endIdx: intersections[k + 1].i,
            crossStart: intersections[k].name,
            crossEnd: intersections[k + 1].name,
        });
    }
    // Last sub-segment: last intersection → way's end (open-ended block)
    const last = intersections[intersections.length - 1];
    if (last.i < way.geometry.length - 1) {
        segs.push({
            startIdx: last.i,
            endIdx: way.geometry.length - 1,
            crossStart: last.name,
            crossEnd: '',
        });
    }
    return segs;
};

/**
 * Pull every named highway within `radiusMeters` of `tap`, split each
 * way into block segments at intersections, and emit two pre-offset
 * polylines per block (one for each side). The mobile heat-map screen
 * renders these as the tappable base layer.
 *
 * @returns {Promise<Array<{street, crossStreet1, crossStreet2, side, path, midpoint}>>}
 */
exports.resolveAreaSegments = async (tap, radiusMeters = AREA_RADIUS_DEFAULT) => {
    if (!tap || typeof tap.lat !== 'number' || typeof tap.lng !== 'number') {
        return [];
    }
    const cacheKey = areaTileKey(tap.lat, tap.lng, radiusMeters);
    const cachedHit = areaCache.get(cacheKey);
    if (cachedHit && cachedHit.expiresAt > Date.now()) return cachedHit.value;

    // Single-retry-with-backoff. Overpass's public endpoint gets flaky
    // under load; one retry avoids the dropped-screen case Rishi saw.
    const callOverpass = async () => {
        const params = new URLSearchParams();
        params.append('data', buildAreaQuery(tap.lat, tap.lng, radiusMeters));
        const res = await axios.post(OVERPASS_ENDPOINT, params, {
            timeout: 10000,
            headers: {
                'User-Agent': 'ValetNetwork/1.2 (ops@valetnetwork.co)',
                Accept: 'application/json',
            },
        });
        return res.data?.elements || [];
    };

    let elements = [];
    try {
        elements = await callOverpass();
    } catch (firstErr) {
        await new Promise((r) => setTimeout(r, 600));
        try {
            elements = await callOverpass();
        } catch (secondErr) {
            console.warn(
                `Overpass area resolver failed (both attempts) @ ${tap.lat},${tap.lng}: ${secondErr.message}`
            );
            // DON'T cache the empty result — let the next call retry.
            return [];
        }
    }

    const ways = elements.filter(
        (el) =>
            el.type === 'way' &&
            el.tags?.highway &&
            el.tags?.name &&
            Array.isArray(el.geometry) &&
            Array.isArray(el.nodes)
    );

    // Build node-id → list-of-ways index so we can find intersections.
    const nodeToWays = new Map();
    for (const w of ways) {
        for (const nid of w.nodes) {
            if (!nodeToWays.has(nid)) nodeToWays.set(nid, []);
            nodeToWays.get(nid).push(w);
        }
    }

    const out = [];
    for (const w of ways) {
        const blocks = splitWayIntoBlocks(w, nodeToWays);
        for (const blk of blocks) {
            const path = w.geometry
                .slice(blk.startIdx, blk.endIdx + 1)
                .map((n) => ({ lat: n.lat, lng: n.lon }));
            if (path.length < 2) continue;
            const mid = path[Math.floor(path.length / 2)];
            for (const side of ['side1', 'side2']) {
                out.push({
                    street: w.tags.name,
                    crossStreet1: blk.crossStart,
                    crossStreet2: blk.crossEnd,
                    side,
                    path: offsetPath(path, SIDE_OFFSET_METERS, side),
                    midpoint: { lat: mid.lat, lng: mid.lng },
                });
            }
        }
    }

    // LRU-ish: cap to 200 cached tiles, drop oldest. Skip caching empty
    // results (transient Overpass hiccups would otherwise blank the
    // viewport for 6 hours).
    if (out.length > 0) {
        if (areaCache.size >= 200) {
            const firstKey = areaCache.keys().next().value;
            areaCache.delete(firstKey);
        }
        areaCache.set(cacheKey, {
            value: out,
            expiresAt: Date.now() + AREA_CACHE_TTL_MS,
        });
    }
    return out;
};
