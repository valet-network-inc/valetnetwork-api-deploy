/**
 * Which app build each user is on, read from the User-Agent of their own
 * signed-in requests — the app sends no version of its own, but iOS stamps
 * every request "<App name>/<build> CFNetwork/… Darwin/…".
 *
 * Fire-and-forget, at most one write per user an hour (or when the agent
 * changes), so the once-a-minute home-screen poll costs nothing. A browser
 * (the /park web app) only stamps webSeenAt and never overwrites the app.
 */
const User = require('../models/User');

const EVERY_MS = 60 * 60 * 1000;
const seen = new Map();

function parseAgent(ua) {
    const s = String(ua || '');
    const ios = /^(.+?)\/(\d+(?:\.\d+)*) CFNetwork\/[\d.]+ Darwin\/[\d.]+/.exec(s);
    if (ios) return { platform: 'ios', build: ios[2] };
    if (/^okhttp\//i.test(s)) return { platform: 'android', build: null };
    if (/Mozilla\//.test(s)) return { platform: 'web', build: null };
    return { platform: 'other', build: null };
}

function noteAppBuild(req, userId) {
    try {
        if (!userId) return;
        const ua = (req.get && req.get('user-agent')) || '';
        const key = String(userId);
        const now = Date.now();
        const last = seen.get(key);
        if (last && last.ua === ua && now - last.at < EVERY_MS) return;
        seen.set(key, { ua, at: now });
        const p = parseAgent(ua);
        const set =
            p.platform === 'web'
                ? { webSeenAt: new Date(now) }
                : { 'app.platform': p.platform, 'app.build': p.build, 'app.userAgent': ua.slice(0, 200), 'app.seenAt': new Date(now) };
        User.updateOne({ _id: userId }, { $set: set }).catch((err) => console.error('appSeen:', err.message));
    } catch (err) {
        console.error('appSeen:', err.message);
    }
}

module.exports = { noteAppBuild, parseAgent };
