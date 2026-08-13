/**
 * Where a customer signed up.
 *
 * Every account on every client is born in one place — authController.loginUser
 * — so that call is the only chance to record which client it came from. This
 * module holds both halves of that: what to write at signup, and how to make a
 * sensible guess for the accounts that predate the field.
 *
 * The value lands on `User.signupPlatform` and is written ONCE. A later login
 * from a different client must not rewrite it, or the column stops meaning
 * "where they signed up" and starts meaning "where they were last seen".
 */

// The canonical set. Anything a client sends is mapped through here, so an
// unrecognised value falls through to the request sniffing below instead of
// polluting the column.
const PLATFORM_ALIASES = {
    ios: 'ios',
    iphone: 'ios',
    ipad: 'ios',
    android: 'android',
    web: 'web',
    park: 'web',
    park_web: 'web',
    business: 'business_web',
    business_web: 'business_web',
    front_desk: 'business_web',
};

// The web clients did not exist before this. /business went live 2026-08-06 and
// /park on 2026-08-10, so an account older than the 1st of that month can only
// have come from the iOS app — nothing else could create one.
const WEB_SIGNUP_EPOCH = new Date('2026-08-01T00:00:00.000Z');

/**
 * Which client is making this signup request.
 *
 * Preference order, most trustworthy first:
 *   1. an explicit `platform` in the body — what every client sends once its
 *      next release is out;
 *   2. `fcmToken` / `deviceId`, which only the mobile app has, split into iOS
 *      vs Android by the user agent;
 *   3. the user agent on its own.
 *
 * Steps 2 and 3 are why this is useful the day the backend ships rather than
 * the day an App Store release lands.
 *
 * Anything left over falls to 'web'. There are exactly two ways to create an
 * account — the app or a browser — so a request carrying none of the app's
 * fingerprints came through a browser.
 *
 * @param {{ body?: object, headers?: object }} req
 * @returns {'ios'|'android'|'web'|'business_web'}
 */
const resolveSignupPlatform = (req) => {
    const body = (req && req.body) || {};
    const headers = (req && req.headers) || {};

    if (typeof body.platform === 'string') {
        const normalized = PLATFORM_ALIASES[body.platform.trim().toLowerCase()];
        if (normalized) return normalized;
    }

    const ua = String(headers['user-agent'] || '');
    const looksAndroid = /okhttp|android|dalvik/i.test(ua);
    // CFNetwork/Darwin is what React Native's networking stack sends on iOS.
    const looksApple = /cfnetwork|darwin|iphone|ipad|ios/i.test(ua);
    const looksBrowser = /mozilla/i.test(ua);

    // Only the mobile app has a push token or a device id to send.
    if (body.fcmToken || body.deviceId) {
        return looksAndroid ? 'android' : 'ios';
    }

    if (looksAndroid && !looksBrowser) return 'android';
    if (looksApple && !looksBrowser) return 'ios';

    // Everything else is the browser. /park and /business can't be told apart
    // from the request — same origin, and Next.js strips the path off
    // cross-origin referers — so this is the generic bucket until the client
    // names itself.
    return 'web';
};

/**
 * Best guess for an account created before `signupPlatform` was recorded.
 * Two signals point at the app, both one-directional:
 *
 *   - an FCM token means the mobile app ran on a real device under that
 *     firebase uid; the web clients deliberately send no token;
 *   - a signup date before the web clients shipped means iOS by elimination.
 *
 * Only iOS has ever shipped — there has been no Android release — so mobile
 * evidence resolves to 'ios'.
 *
 * With neither signal it is 'web', because those are the only two ways in.
 * That is a guess, and `getCustomerList` marks it as one via `platformSource`
 * so the dashboard can show it as a guess rather than a fact.
 *
 * @param {{ firebaseUid?: string }} customer
 * @param {Date} signedUpAt
 * @param {Set<string>} uidsWithPushTokens
 * @returns {'ios'|'web'}
 */
const inferLegacyPlatform = (customer, signedUpAt, uidsWithPushTokens) => {
    if (
        customer &&
        customer.firebaseUid &&
        uidsWithPushTokens &&
        uidsWithPushTokens.has(customer.firebaseUid)
    ) {
        return 'ios';
    }
    if (signedUpAt && signedUpAt < WEB_SIGNUP_EPOCH) return 'ios';
    return 'web';
};

module.exports = {
    resolveSignupPlatform,
    inferLegacyPlatform,
    PLATFORM_ALIASES,
    WEB_SIGNUP_EPOCH,
};
