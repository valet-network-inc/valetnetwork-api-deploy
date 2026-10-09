// What Permanent valet costs at an address (Rishi, 2026-10-09).
//
// Brooklyn and Queens: one price everywhere ($300 a month at launch).
// Manhattan: the Price column of valetnetwork.co/pricing for the address's
// neighborhood ($350 to $775 at launch). Anywhere else (the Bronx, Staten
// Island, New Jersey) the plan is not offered, and the answer is null.
//
// Every address that is offered also lands in a neighborhood, because a
// neighborhood is what unlocks (services/neighborhoodUnlocks.js): Manhattan's
// 18 sheet rows, and the 47 Brooklyn and 46 Queens neighborhoods of
// config/nycNeighborhoods.json. Brooklyn and Queens neighborhoods share the
// one price; the neighborhood is only where the address sits.
//
// The borough comes from City Planning's borough boundaries with the water
// included, so an address pinned a few metres off a pier still lands in the
// borough it belongs to and Manhattan stops at the state line in the Hudson.
// The neighborhood is the one whose centre is nearest, inside the borough.
// In Manhattan that is exactly how the sheet assigned every garage it priced,
// so an address and the garages around it always fall in the same row.
//
// The address's lat/lng decides, never its text. Coverage of the free daily
// park is decided by the same lat/lng (HOME_RADIUS_METERS), so the price and
// the product follow the same point.
//
// Weekly billing stays 30% of monthly, as on every other plan, rounded to
// $5: $300 → $90, $525 → $160, $775 → $235.
//
// The prices themselves live in Mongo (models/NeighborhoodPricing.js) so they
// change without an app update. Everything that does arithmetic here takes
// the table as its first argument and touches no database, so a test can
// price an address with a table it wrote by hand; the async wrappers at the
// bottom load the live table (cached for a minute) and call the same code.

const NeighborhoodPricing = require('../models/NeighborhoodPricing');
const SEED = require('../config/neighborhoodPrices.json');
const OUTER = require('../config/nycNeighborhoods.json');

const BOROUGHS = Object.entries(require('../config/nycBoroughs.json').boroughs).map(([name, polys]) => ({
    name,
    polys,
    bbox: bboxOf(polys),
}));

const NOT_OFFERED_MESSAGE =
    'Permanent valet is offered in Manhattan, Brooklyn and Queens. We don’t cover that address yet.';

// Unlock rows that exist so the list reads as all of New York, and that
// nothing can be bought in yet.
const NOT_OFFERED_BOROUGHS = OUTER.notOffered;

/** 'manhattan-chelsea', 'brooklyn-park-slope', 'staten-island'. Stable: subscriptions store it. */
function slug(s) {
    return String(s)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[’']/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function neighborhoodKey(borough, name) {
    return name ? `${slug(borough)}-${slug(name)}` : slug(borough);
}

function bboxOf(polys) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const poly of polys) {
        for (const [x, y] of poly[0]) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    return { minX, minY, maxX, maxY };
}

// Even-odd ray cast. rings[0] is the outline, any further rings are holes.
function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function inMultiPolygon(x, y, polys) {
    for (const rings of polys) {
        if (!inRing(x, y, rings[0])) continue;
        let hole = false;
        for (let k = 1; k < rings.length; k++) {
            if (inRing(x, y, rings[k])) {
                hole = true;
                break;
            }
        }
        if (!hole) return true;
    }
    return false;
}

function metres(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLng = (lng2 - lng1) * toRad;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

function validPoint(address) {
    const lat = address && address.lat;
    const lng = address && address.lng;
    return (
        typeof lat === 'number' && typeof lng === 'number' &&
        Number.isFinite(lat) && Number.isFinite(lng) &&
        lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
    );
}

/** 'Manhattan' | 'Brooklyn' | 'Queens', or null anywhere else. */
function boroughFor(address) {
    if (!validPoint(address)) return null;
    const { lat, lng } = address;
    for (const f of BOROUGHS) {
        const b = f.bbox;
        if (lng < b.minX || lng > b.maxX || lat < b.minY || lat > b.maxY) continue;
        if (inMultiPolygon(lng, lat, f.polys)) return f.name;
    }
    return null;
}

/** The sheet's Manhattan row nearest the address. */
function manhattanRowFor(table, address) {
    let best = null;
    for (const row of table.manhattan || []) {
        for (const [clat, clng] of row.centroids || []) {
            const d = metres(address.lat, address.lng, clat, clng);
            if (!best || d < best.d) best = { d, row };
        }
    }
    return best ? best.row : null;
}

/** The Brooklyn or Queens neighborhood nearest the address. */
function outerNeighborhoodFor(borough, address) {
    let best = null;
    for (const n of OUTER.boroughs[borough] || []) {
        const d = metres(address.lat, address.lng, n.centroid[0], n.centroid[1]);
        if (!best || d < best.d) best = { d, name: n.name };
    }
    return best ? best.name : null;
}

function weeklyFromMonthly(monthlyCents, table = SEED) {
    const share = table.weeklyShare || 0.3;
    const round = table.weeklyRoundCents || 500;
    return Math.round((monthlyCents * share) / round) * round;
}

/**
 * Where an address sits on the sheet, or null when Permanent valet is not
 * offered there.
 *   { borough, neighborhood, key, label, monthlyCents, commissionCents }
 * `label` is what the customer reads ("Permanent valet in Chelsea").
 */
function areaFor(table, address) {
    const borough = boroughFor(address);
    if (!borough) return null;
    if (borough === 'Manhattan') {
        const row = manhattanRowFor(table, address);
        // A table with no Manhattan rows cannot price Manhattan. Saying "not
        // offered" is better than charging the outer-borough price there.
        if (!row) return null;
        return {
            borough,
            neighborhood: row.neighborhood,
            key: neighborhoodKey(borough, row.neighborhood),
            label: row.neighborhood,
            monthlyCents: row.monthlyCents,
            commissionCents: row.commissionCents,
        };
    }
    const neighborhood = outerNeighborhoodFor(borough, address);
    return {
        borough,
        neighborhood,
        key: neighborhoodKey(borough, neighborhood),
        label: neighborhood || borough,
        monthlyCents: table.brooklynQueens.monthlyCents,
        commissionCents: table.brooklynQueens.commissionCents,
    };
}

/**
 * Every row of the unlock list, in the portal's order: Manhattan's sheet
 * rows, Brooklyn, Queens, then one not-offered row each for Staten Island and
 * the Bronx.
 *   { key, borough, name, offered, monthlyCents, commissionCents }
 */
function allNeighborhoods(table) {
    const rows = (table.manhattan || []).map((r) => ({
        key: neighborhoodKey('Manhattan', r.neighborhood),
        borough: 'Manhattan',
        name: r.neighborhood,
        offered: true,
        monthlyCents: r.monthlyCents,
        commissionCents: r.commissionCents,
    }));
    for (const borough of ['Brooklyn', 'Queens']) {
        for (const n of OUTER.boroughs[borough]) {
            rows.push({
                key: neighborhoodKey(borough, n.name),
                borough,
                name: n.name,
                offered: true,
                monthlyCents: table.brooklynQueens.monthlyCents,
                commissionCents: table.brooklynQueens.commissionCents,
            });
        }
    }
    for (const { borough, name } of NOT_OFFERED_BOROUGHS) {
        rows.push({
            key: neighborhoodKey(borough),
            borough,
            name,
            offered: false,
            monthlyCents: null,
            commissionCents: null,
        });
    }
    return rows;
}

/** One row of allNeighborhoods by key, or null. */
function neighborhoodByKey(table, key) {
    return allNeighborhoods(table).find((n) => n.key === key) || null;
}

/**
 * Permanent valet's price at an address for one billing interval, or null when
 * it is not offered there.
 *   { amountCents, interval, borough, neighborhood, label, commissionCents }
 *
 * commissionCents is the rep's commission for a paid MONTH, whatever the
 * interval: a weekly plan accrues it pro rata per paid week (12/52), which is
 * the earnings code's business, not the price's.
 */
function garagePriceAt(table, address, interval) {
    if (interval !== 'week' && interval !== 'month') return null;
    const area = areaFor(table, address);
    if (!area) return null;
    return {
        amountCents:
            interval === 'week' ? weeklyFromMonthly(area.monthlyCents, table) : area.monthlyCents,
        interval,
        borough: area.borough,
        neighborhood: area.neighborhood,
        key: area.key,
        label: area.label,
        commissionCents: area.commissionCents,
    };
}

/** Brooklyn and Queens — the price /plans advertises, and what an old app shows. */
function basePrice(table, interval) {
    const monthly = table.brooklynQueens.monthlyCents;
    if (interval === 'week') return weeklyFromMonthly(monthly, table);
    if (interval === 'month') return monthly;
    return null;
}

/** The cheapest monthly price anywhere — the "From $300" on the plan card. */
function lowestMonthlyCents(table) {
    return Math.min(
        table.brooklynQueens.monthlyCents,
        ...(table.manhattan || []).map((r) => r.monthlyCents)
    );
}

/** Every price point the table can produce — for minting Stripe prices. */
function allGarageAmounts(table) {
    const monthly = new Set([
        table.brooklynQueens.monthlyCents,
        ...(table.manhattan || []).map((r) => r.monthlyCents),
    ]);
    return {
        month: [...monthly].sort((a, b) => a - b),
        week: [...new Set([...monthly].map((m) => weeklyFromMonthly(m, table)))].sort((a, b) => a - b),
    };
}

/** The sheet as valetnetwork.co/pricing renders it. No centroids, no admin fields. */
function publicPrices(table) {
    const bq = table.brooklynQueens;
    return {
        brooklynQueens: {
            monthlyCents: bq.monthlyCents,
            commissionCents: bq.commissionCents,
            garageLowCents: bq.garageLowCents ?? null,
            garageHighCents: bq.garageHighCents ?? null,
        },
        manhattan: (table.manhattan || []).map((r) => ({
            neighborhood: r.neighborhood,
            garageCents: r.garageCents ?? null,
            monthlyCents: r.monthlyCents,
            commissionCents: r.commissionCents,
        })),
        updatedAt: table.updatedAt || null,
    };
}

// "Questions? Contact sales" under the plans list and the review screen. It
// opens Text / Email / Cancel; both are prefilled with `message`, whose
// {name} the client fills with the customer's name. It never calls.
function contactSalesOf(table) {
    const cs = (table && table.contactSales) || {};
    if (!cs.phone && !cs.email) return null;
    return {
        prompt: cs.prompt || 'Questions?',
        label: cs.label || 'Contact sales',
        phone: cs.phone || null,
        email: cs.email || null,
        subject: cs.subject || null,
        message: cs.message || null,
    };
}

// The seed file shaped like a live table. Used when there is no database to
// read (the catalog script without MONGO_URI) and by tests.
function seedTable() {
    return {
        brooklynQueens: { ...SEED.brooklynQueens },
        manhattan: SEED.manhattan.map((r) => ({ ...r, centroids: r.centroids.map((c) => [...c]) })),
        weeklyShare: SEED.weeklyShare,
        weeklyRoundCents: SEED.weeklyRoundCents,
        contactSales: { ...SEED.contactSales },
        updatedAt: null,
    };
}

// ---------------------------------------------------------------------------
// Admin edits
// ---------------------------------------------------------------------------

const MIN_MONTHLY_CENTS = 5000;
const MAX_MONTHLY_CENTS = 500000;
const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function priceError(where, monthlyCents, commissionCents) {
    if (!Number.isInteger(monthlyCents)) return `${where}: the price must be a whole number of cents.`;
    if (monthlyCents < MIN_MONTHLY_CENTS || monthlyCents > MAX_MONTHLY_CENTS) {
        return `${where}: the price must be between $50 and $5,000 a month.`;
    }
    if (!Number.isInteger(commissionCents)) return `${where}: the commission must be a whole number of cents.`;
    if (commissionCents < 0 || commissionCents >= monthlyCents) {
        return `${where}: the commission must be at least $0 and less than the price.`;
    }
    return null;
}

function optionalCents(where, value) {
    if (value === undefined || value === null) return null;
    if (!Number.isInteger(value) || value < 0) return `${where} must be a whole number of cents.`;
    return null;
}

/**
 * Check an admin's edit against the live table and merge it in.
 * Returns { table } or { error }.
 *
 * Prices, commissions, the garage figures and the Contact sales link can
 * change. The set of Manhattan neighborhoods cannot: the names are keys that
 * subscriptions store, and the centroids that place an address in a row are
 * kept from the live table whatever the edit says.
 */
function validateTable(input, current) {
    if (!input || typeof input !== 'object') return { error: 'Send the pricing table.' };
    const next = {
        brooklynQueens: { ...current.brooklynQueens },
        manhattan: (current.manhattan || []).map((r) => ({ ...r })),
        weeklyShare: current.weeklyShare,
        weeklyRoundCents: current.weeklyRoundCents,
        contactSales: { ...(current.contactSales || {}) },
    };

    if (input.brooklynQueens !== undefined) {
        const bq = input.brooklynQueens || {};
        const err =
            priceError('Brooklyn and Queens', bq.monthlyCents, bq.commissionCents) ||
            optionalCents('Brooklyn and Queens garage low', bq.garageLowCents) ||
            optionalCents('Brooklyn and Queens garage high', bq.garageHighCents);
        if (err) return { error: err };
        next.brooklynQueens = {
            monthlyCents: bq.monthlyCents,
            commissionCents: bq.commissionCents,
            garageLowCents: bq.garageLowCents ?? current.brooklynQueens.garageLowCents,
            garageHighCents: bq.garageHighCents ?? current.brooklynQueens.garageHighCents,
        };
    }

    if (input.manhattan !== undefined) {
        if (!Array.isArray(input.manhattan)) return { error: 'manhattan must be a list of neighborhoods.' };
        const known = new Map(next.manhattan.map((r) => [r.neighborhood, r]));
        const seen = new Set();
        for (const row of input.manhattan) {
            const name = row && row.neighborhood;
            if (!known.has(name)) return { error: `${name || 'A row'} is not a neighborhood on the sheet.` };
            if (seen.has(name)) return { error: `${name} is listed twice.` };
            seen.add(name);
            const err =
                priceError(name, row.monthlyCents, row.commissionCents) ||
                optionalCents(`${name} garage`, row.garageCents);
            if (err) return { error: err };
        }
        const missing = [...known.keys()].filter((n) => !seen.has(n));
        if (missing.length) return { error: `Every neighborhood needs a price. Missing: ${missing.join(', ')}.` };
        next.manhattan = next.manhattan.map((r) => {
            const edit = input.manhattan.find((x) => x.neighborhood === r.neighborhood);
            return {
                ...r,
                monthlyCents: edit.monthlyCents,
                commissionCents: edit.commissionCents,
                garageCents: edit.garageCents ?? r.garageCents,
            };
        });
    }

    if (input.contactSales !== undefined) {
        const cs = input.contactSales || {};
        const was = next.contactSales;
        const pick = (field) => (cs[field] === undefined ? was[field] : String(cs[field] || '').trim());
        const phone = pick('phone');
        const email = pick('email');
        if (!E164.test(phone || '')) return { error: 'The Contact sales phone must look like +19796616772.' };
        if (!EMAIL.test(email || '')) return { error: 'The Contact sales email must be an email address.' };
        const label = pick('label');
        if (!label) return { error: 'The Contact sales link needs a label.' };
        const message = pick('message');
        if (!message) return { error: 'The Contact sales message cannot be empty.' };
        next.contactSales = {
            prompt: pick('prompt') || 'Questions?',
            label,
            phone,
            email,
            subject: pick('subject') || '',
            message,
        };
    }

    return { table: next };
}

// ---------------------------------------------------------------------------
// The live table
// ---------------------------------------------------------------------------

// A minute is short enough that an admin's edit reaches every client before
// they would notice, and long enough that pricing a quote is not a database
// read. The process that saves an edit drops its own copy at once.
const CACHE_MS = 60 * 1000;
let cache = null; // { table, at }

function shape(doc) {
    return {
        brooklynQueens: { ...doc.brooklynQueens },
        manhattan: (doc.manhattan || []).map((r) => ({
            neighborhood: r.neighborhood,
            monthlyCents: r.monthlyCents,
            commissionCents: r.commissionCents,
            garageCents: r.garageCents,
            centroids: r.centroids || [],
        })),
        weeklyShare: doc.weeklyShare,
        weeklyRoundCents: doc.weeklyRoundCents,
        contactSales: { ...(doc.contactSales || {}) },
        updatedAt: doc.updatedAt || null,
        updatedBy: doc.updatedBy || null,
    };
}

async function getTable() {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.table;
    try {
        const doc = await NeighborhoodPricing.getSingleton();
        cache = { table: shape(doc), at: Date.now() };
        return cache.table;
    } catch (err) {
        // A database blip must not take pricing down with it. The last table
        // this process read is still the best answer it has.
        if (cache) {
            console.error('neighborhoodPricing: reload failed, using the last table:', err.message);
            return cache.table;
        }
        throw err;
    }
}

function invalidate() {
    cache = null;
}

/** Validate an admin edit, save it, and drop the cache. Returns { table } or { error }. */
async function saveTable(input, updatedBy) {
    const current = shape(await NeighborhoodPricing.getSingleton());
    const result = validateTable(input, current);
    if (result.error) return result;
    await NeighborhoodPricing.updateOne(
        { key: 'default' },
        { $set: { ...result.table, updatedBy: updatedBy || 'admin' } }
    );
    invalidate();
    return { table: await getTable() };
}

async function areaAt(address) {
    return areaFor(await getTable(), address);
}

async function priceAt(address, interval) {
    return garagePriceAt(await getTable(), address, interval);
}

module.exports = {
    // pure — the table is an argument
    boroughFor,
    areaFor,
    allNeighborhoods,
    neighborhoodByKey,
    neighborhoodKey,
    garagePriceAt,
    weeklyFromMonthly,
    basePrice,
    lowestMonthlyCents,
    allGarageAmounts,
    publicPrices,
    contactSalesOf,
    validateTable,
    seedTable,
    metres,
    // the live table
    getTable,
    invalidate,
    saveTable,
    areaAt,
    priceAt,
    NOT_OFFERED_MESSAGE,
};
