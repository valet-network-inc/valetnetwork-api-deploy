/**
 * Out-of-date apps can't book (Nov 5 2026). Run: npx jest appGate
 */
const { requireCurrentApp, isOutdatedApp, UPDATE_MESSAGE } = require('../services/appGate');

const req = (ua) => ({ get: (h) => (h.toLowerCase() === 'user-agent' ? ua : undefined) });
const res = () => {
    const r = { code: 200, body: null };
    r.status = (c) => ((r.code = c), r);
    r.json = (b) => ((r.body = b), r);
    return r;
};

const OLD = 'ValetNYC/55 CFNetwork/1568.100.1 Darwin/24.0.0';
const NEW = 'ValetNYC/59 CFNetwork/3826.400.120 Darwin/25.0.0';

afterEach(() => {
    delete process.env.MIN_IOS_BUILD;
});

test('an iOS build older than 59 gets 426 and the update message', () => {
    const r = res();
    const next = jest.fn();
    requireCurrentApp(req(OLD), r, next);
    expect(next).not.toHaveBeenCalled();
    expect(r.code).toBe(426);
    expect(r.body).toEqual({ success: false, code: 'UPDATE_REQUIRED', message: UPDATE_MESSAGE });
});

test('build 59 and later, the web and anything unrecognized pass', () => {
    for (const ua of [NEW, 'ValetNYC/60 CFNetwork/1 Darwin/1', 'Mozilla/5.0 (iPhone)', 'okhttp/4.9', '', 'node-superagent/3.8']) {
        const next = jest.fn();
        requireCurrentApp(req(ua), res(), next);
        expect(next).toHaveBeenCalled();
    }
});

test('MIN_IOS_BUILD moves the line, and 0 turns the gate off', () => {
    process.env.MIN_IOS_BUILD = '56';
    expect(isOutdatedApp(req(OLD))).toBe(true);
    expect(isOutdatedApp(req('ValetNYC/56 CFNetwork/1 Darwin/1'))).toBe(false);
    process.env.MIN_IOS_BUILD = '0';
    expect(isOutdatedApp(req(OLD))).toBe(false);
});
