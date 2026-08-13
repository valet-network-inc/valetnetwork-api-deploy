const {
    resolveSignupPlatform,
    inferLegacyPlatform,
} = require('../services/signupPlatform');

// Real user agents, so the regexes are checked against what actually arrives
// rather than against what they were written to match.
const UA = {
    iosApp: 'valet/32 CFNetwork/1494.0.7 Darwin/23.4.0',
    androidApp: 'okhttp/4.12.0',
    desktopSafari:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    mobileSafari:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    androidChrome:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
};

const req = (body = {}, ua) => ({
    body,
    headers: ua ? { 'user-agent': ua } : {},
});

describe('resolveSignupPlatform — explicit platform wins', () => {
    it('takes what the client says', () => {
        expect(resolveSignupPlatform(req({ platform: 'ios' }))).toBe('ios');
        expect(resolveSignupPlatform(req({ platform: 'android' }))).toBe('android');
        expect(resolveSignupPlatform(req({ platform: 'web' }))).toBe('web');
        expect(resolveSignupPlatform(req({ platform: 'business_web' }))).toBe('business_web');
    });

    it('normalises case, padding, and aliases', () => {
        expect(resolveSignupPlatform(req({ platform: '  IOS ' }))).toBe('ios');
        expect(resolveSignupPlatform(req({ platform: 'iPhone' }))).toBe('ios');
        expect(resolveSignupPlatform(req({ platform: 'park' }))).toBe('web');
        expect(resolveSignupPlatform(req({ platform: 'front_desk' }))).toBe('business_web');
    });

    it('beats every other signal — a browser saying business_web is believed', () => {
        expect(
            resolveSignupPlatform(req({ platform: 'business_web' }, UA.desktopSafari))
        ).toBe('business_web');
    });

    it('falls through on junk rather than storing it', () => {
        expect(resolveSignupPlatform(req({ platform: 'nintendo-ds' }))).toBe('unknown');
        expect(resolveSignupPlatform(req({ platform: '' }))).toBe('unknown');
        expect(resolveSignupPlatform(req({ platform: 42 }))).toBe('unknown');
    });
});

describe('resolveSignupPlatform — inferring from the request', () => {
    it('reads the mobile app from its device fields', () => {
        expect(resolveSignupPlatform(req({ fcmToken: 'abc' }, UA.iosApp))).toBe('ios');
        expect(resolveSignupPlatform(req({ deviceId: 'xyz' }, UA.iosApp))).toBe('ios');
        expect(resolveSignupPlatform(req({ fcmToken: 'abc' }, UA.androidApp))).toBe('android');
    });

    it('still says ios when the app sends a token but no recognisable agent', () => {
        expect(resolveSignupPlatform(req({ fcmToken: 'abc' }))).toBe('ios');
    });

    it('reads the app from its agent alone, with no device fields', () => {
        expect(resolveSignupPlatform(req({}, UA.iosApp))).toBe('ios');
        expect(resolveSignupPlatform(req({}, UA.androidApp))).toBe('android');
    });

    it('calls browsers web, including the ones that name a phone OS', () => {
        expect(resolveSignupPlatform(req({}, UA.desktopSafari))).toBe('web');
        // Mobile Safari says "iPhone" and Android Chrome says "Android"; neither
        // is the app, and reading either as one would be the easy mistake here.
        expect(resolveSignupPlatform(req({}, UA.mobileSafari))).toBe('web');
        expect(resolveSignupPlatform(req({}, UA.androidChrome))).toBe('web');
    });

    it('says unknown when there is nothing to go on', () => {
        expect(resolveSignupPlatform(req({}))).toBe('unknown');
        expect(resolveSignupPlatform(req({}, 'curl/8.4.0'))).toBe('unknown');
        expect(resolveSignupPlatform({})).toBe('unknown');
        expect(resolveSignupPlatform(undefined)).toBe('unknown');
    });
});

describe('inferLegacyPlatform', () => {
    const OLD = new Date('2026-05-01T12:00:00.000Z');   // before any web client
    const RECENT = new Date('2026-08-12T12:00:00.000Z'); // after both shipped

    it('calls a push-token account ios whenever it was made', () => {
        const tokens = new Set(['uid-1']);
        expect(inferLegacyPlatform({ firebaseUid: 'uid-1' }, RECENT, tokens)).toBe('ios');
        expect(inferLegacyPlatform({ firebaseUid: 'uid-1' }, OLD, tokens)).toBe('ios');
    });

    it('calls anything older than the web clients ios', () => {
        expect(inferLegacyPlatform({ firebaseUid: 'uid-2' }, OLD, new Set())).toBe('ios');
    });

    it('refuses to guess a recent account with no push token', () => {
        expect(inferLegacyPlatform({ firebaseUid: 'uid-3' }, RECENT, new Set())).toBe('unknown');
    });

    it('survives missing pieces', () => {
        expect(inferLegacyPlatform({}, RECENT, new Set())).toBe('unknown');
        expect(inferLegacyPlatform({ firebaseUid: 'uid-4' }, null, new Set())).toBe('unknown');
        expect(inferLegacyPlatform({ firebaseUid: 'uid-4' }, OLD, undefined)).toBe('ios');
    });
});
