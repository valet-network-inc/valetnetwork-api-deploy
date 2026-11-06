/**
 * The street-cleaning sign on the curb where a car is parked, from NYC DOT's
 * "Parking Regulation Locations and Signs" (Socrata nfid-uabd: open, no key),
 * for when the valet didn't log it (Rishi, Nov 6: the Home card kept 60 Pine
 * St after a park at 189 Court St, whose sign list was empty).
 *
 * The broom signs on the car's own street nearest its pin, within 120 ft:
 * the curb it stands at. Checked on 629 Carlton Ave: east side, Tuesday &
 * Friday 11:30, as on the street (the west side is Monday & Thursday).
 * Never throws; [] when it can't tell.
 */
const axios = require('axios');

const URL = 'https://data.cityofnewyork.us/resource/nfid-uabd.json';

/** WGS84 lat/lng to New York Long Island state plane (EPSG:2263), US feet. */
function toStatePlaneFt(lat, lng) {
    const a = 6378137;
    const f = 1 / 298.257222101;
    const e = Math.sqrt(2 * f - f * f);
    const rad = (d) => (d * Math.PI) / 180;
    const m = (p) => Math.cos(p) / Math.sqrt(1 - e * e * Math.sin(p) ** 2);
    const t = (p) => Math.tan(Math.PI / 4 - p / 2) / Math.pow((1 - e * Math.sin(p)) / (1 + e * Math.sin(p)), e / 2);
    const p1 = rad(41 + 2 / 60);
    const p2 = rad(40 + 40 / 60);
    const p0 = rad(40 + 10 / 60);
    const l0 = rad(-74);
    const n = (Math.log(m(p1)) - Math.log(m(p2))) / (Math.log(t(p1)) - Math.log(t(p2)));
    const F = m(p1) / (n * Math.pow(t(p1), n));
    const rho = (p) => a * F * Math.pow(t(p), n);
    const th = n * (rad(lng) - l0);
    const xm = rho(rad(lat)) * Math.sin(th) + 300000;
    const ym = rho(p0) - rho(rad(lat)) * Math.cos(th);
    const ft = 3937 / 1200;
    return { x: xm * ft, y: ym * ft };
}

const SUFFIX = {
    ST: 'STREET', AVE: 'AVENUE', AV: 'AVENUE', PL: 'PLACE', BLVD: 'BOULEVARD', RD: 'ROAD', DR: 'DRIVE',
    PKWY: 'PARKWAY', LN: 'LANE', CT: 'COURT', TER: 'TERRACE', SQ: 'SQUARE', HWY: 'HIGHWAY',
};
const COMPASS = { N: 'NORTH', S: 'SOUTH', E: 'EAST', W: 'WEST' };

/** "189 Court St, Brooklyn…" -> "COURT STREET", in the dataset's spelling. */
function streetOf(address) {
    const m = String(address || '').match(/^\s*\d+(?:-\d+)?\s+([^,]+)/);
    if (!m) return null;
    const words = m[1].toUpperCase().replace(/\./g, '').split(/\s+/).filter(Boolean);
    return words
        .map((w, i) => {
            if (i === words.length - 1 && SUFFIX[w]) return SUFFIX[w];
            if (i === 0 && COMPASS[w] && words.length > 2) return COMPASS[w];
            if (w === 'ST' && i < words.length - 1) return 'SAINT';
            return w.replace(/^(\d+)(ST|ND|RD|TH)$/, '$1');
        })
        .join(' ');
}

const DAYS = { SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6 };

/** "NO PARKING (SANITATION BROOM SYMBOL) TUESDAY FRIDAY 11:30AM-1PM" -> [{ weekday, hour, minute }]. */
function parseSign(description) {
    const s = String(description || '').toUpperCase();
    if (!s.includes('BROOM')) return [];
    const tm = s.match(/(MIDNIGHT|NOON|(\d{1,2})(?::(\d{2}))?\s*(AM|PM))\s*-/);
    if (!tm) return [];
    let hour;
    let minute = 0;
    if (tm[1] === 'MIDNIGHT') hour = 0;
    else if (tm[1] === 'NOON') hour = 12;
    else {
        hour = (Number(tm[2]) % 12) + (tm[4] === 'PM' ? 12 : 0);
        minute = Number(tm[3] || 0);
    }
    let days;
    if (/EXCEPT\s+SUNDAY/.test(s)) days = [1, 2, 3, 4, 5, 6];
    else if (/EXCEPT/.test(s)) return [];
    else days = Object.keys(DAYS).filter((d) => new RegExp(`\\b${d}\\b`).test(s)).map((d) => DAYS[d]);
    return days.map((weekday) => ({ weekday, hour, minute }));
}

/** The sweep days at a parked car's curb: [{ weekday, hour, minute }], or []. One retry: the city's API throws the odd 503. */
async function signAt(loc, opts = {}) {
    for (let i = 0; i < 3; i += 1) {
        const days = await signAtOnce(loc, opts);
        if (days !== null) return days;
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
    return [];
}

async function signAtOnce(loc, { timeoutMs = 4000 } = {}) {
    try {
        if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return [];
        const street = streetOf(loc.streetAddress);
        if (!street) return [];
        const { x, y } = toStatePlaneFt(loc.lat, loc.lng);
        const r = 150;
        const res = await axios.get(URL, {
            params: {
                $where: `record_type='Current' AND sign_description like '%BROOM%' AND sign_x_coord between ${Math.round(x - r)} and ${Math.round(x + r)} AND sign_y_coord between ${Math.round(y - r)} and ${Math.round(y + r)}`,
                $select: 'on_street,side_of_street,sign_description,sign_x_coord,sign_y_coord',
                $limit: 200,
            },
            timeout: timeoutMs,
        });
        // A throttled answer comes back 200 with an error object: try again.
        if (!Array.isArray(res.data)) return null;
        const rows = res.data;
        const near = rows
            .filter((s) => String(s.on_street || '').toUpperCase() === street)
            .map((s) => ({ s, d: Math.hypot(Number(s.sign_x_coord) - x, Number(s.sign_y_coord) - y) }))
            .filter((n) => Number.isFinite(n.d) && n.d <= 120)
            .sort((p, q) => p.d - q.d);
        for (const n of near) {
            const days = parseSign(n.s.sign_description);
            if (days.length) return days;
        }
        return [];
    } catch (err) {
        console.error('streetSigns.signAt failed:', err.message);
        return null;
    }
}

module.exports = { signAt, parseSign, streetOf, toStatePlaneFt };
