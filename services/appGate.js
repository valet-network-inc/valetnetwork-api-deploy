/**
 * Out-of-date apps can't book (Nov 5 2026, Rishi: "is there any way to make
 * sure that people who are not on this version of the app, update it to the
 * latest version").
 *
 * The App Store can't force an update, and the builds already on phones have
 * no update screen. But every one of them shows the server's `message` when a
 * booking fails, so the booking itself tells them: update the app. Only the
 * iOS app is checked (its User-Agent carries the build, services/appSeen.js);
 * the web, Android and anything unrecognized pass.
 *
 * MIN_IOS_BUILD sets the oldest build that may book (default 59, the first
 * 2.4.0 sent to the App Store). MIN_IOS_BUILD=0 turns the gate off.
 */
const { parseAgent } = require('./appSeen');

const UPDATE_MESSAGE = 'Update Valet Network in the App Store to keep booking. This version of the app no longer works.';

function minIosBuild() {
    const n = Number(process.env.MIN_IOS_BUILD ?? 59);
    return Number.isFinite(n) ? n : 59;
}

/** True for an iOS app older than MIN_IOS_BUILD. */
function isOutdatedApp(req) {
    const min = minIosBuild();
    if (!min) return false;
    const p = parseAgent(req && req.get ? req.get('user-agent') : '');
    return p.platform === 'ios' && !!p.build && Number(p.build) < min;
}

/** Express middleware for booking routes: 426 with the update message. */
function requireCurrentApp(req, res, next) {
    if (!isOutdatedApp(req)) return next();
    return res.status(426).json({ success: false, code: 'UPDATE_REQUIRED', message: UPDATE_MESSAGE });
}

module.exports = { requireCurrentApp, isOutdatedApp, UPDATE_MESSAGE, minIosBuild };
