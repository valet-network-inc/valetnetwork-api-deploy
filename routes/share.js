const express = require('express');
const router = express.Router();
const rateLimit = require('../middleware/rateLimit');
const shareController = require('../controllers/shareController');

// Everything under /:token is reached with a bearer token and no account
// behind it, so the token IS the identity we count against.
const byToken = (req) => req.params.token;

// Both owner routes name a customer id, so that is what they are counted
// against. Revoke can also arrive holding only the token — the doorman's copy,
// or the app's — so it counts against whichever of the two it was given.
const byUserId = (req) => req.body?.userId;
const byBodyToken = (req) => req.body?.token || req.body?.userId;

// --- The customer's end -----------------------------------------------------
// Minting and revoking are the owner-only ends of the link. Literal paths, and
// registered first so `/link/revoke` can never be read as a token.
//
// A handful an hour each, and they were the only routes in this file with no
// meter at all. Sharing is a thing a person does once and then forgets about
// for months, so ten is generous.
//
// Both routes now want the account holder's Firebase ID token before they
// change anything, so this is no longer the thing standing between a stranger
// and somebody's link. It is still worth keeping: verifying a token costs a
// round trip to Google's keys, and the meter is what stops anybody with a
// customer id — they are not secret — spending that all morning.
//
// Keyed on one link or one customer rather than globally: a busy Thursday
// morning must never have one person's tapping lock somebody else out.
// A rejected caller must not spend the owner's budget. The key here is a
// customer id, which is public, so charging every request let a stranger fire
// ten unauthenticated 401s at Randi's id and lock her out of minting OR
// revoking her own link for an hour — a denial of service handed to anyone who
// can read the pending feed. Only a request that got past the ownership gate
// is a request the owner actually made.
const perKey = (keyFrom, message) =>
    rateLimit({
        windowMs: 60 * 60 * 1000,
        max: 10,
        keyFrom,
        message,
        countWhen: (res) => res.statusCode !== 401 && res.statusCode !== 403,
    });

router.post(
    '/link',
    perKey(byUserId, 'Too many link requests. Try again in a little while.'),
    shareController.createShareLink
);
router.post(
    '/link/revoke',
    perKey(byBodyToken, 'Too many link changes. Try again in a little while.'),
    shareController.revokeShareLink
);

// --- The doorman's handoff screen -------------------------------------------
// Open on purpose: the person at the curb has no login and never will. The
// token is the whole credential, which is why both routes are metered.

// 60/min: the screen polls while the doorman waits for the valet, and two
// people watching one handoff on two phones is normal.
router.get(
    '/:token',
    rateLimit({
        windowMs: 60 * 1000,
        max: 60,
        keyFrom: byToken,
        message: 'Too many refreshes. Give it a moment.',
    }),
    shareController.getSharedOrder
);

// 5 wrong answers per 10 min, on top of the absolute cap the controller keeps.
// This one is only about pace — a doorman fat-fingering it twice still has
// room, and a correct code costs nothing at all.
//
// A GUESS, not a refusal. This used to charge any 4xx, which meant the 400
// "There is no code to enter right now" cost a try: five taps at a moment when
// no window was open — a valet still walking over, a page left open from the
// last job — and the doorman was locked out for ten minutes without ever
// having typed a number at anybody. `otpGraded` is set in the controller on
// the line before the code is compared, so only an answer that was actually
// marked wrong is charged. The absolute per-order cap already behaves this
// way: it is claimed after the window check, so a shut window never spends one.
router.post(
    '/:token/verify',
    rateLimit({
        windowMs: 10 * 60 * 1000,
        max: 5,
        keyFrom: byToken,
        countWhen: (res) => !!res.locals.otpGraded && res.statusCode >= 400,
        message: 'Too many tries. Wait a few minutes, then ask the valet to read it again.',
    }),
    shareController.verifySharedOtp
);

// --- The doorman's half of the chat -----------------------------------------
// Proxied rather than done from his browser; the reasoning is at the foot of
// shareController.js.

// Same pace as the screen itself: the transcript is polled beside it, and a
// doorman with the page open on two phones is normal.
router.get(
    '/:token/messages',
    rateLimit({
        windowMs: 60 * 1000,
        max: 60,
        keyFrom: byToken,
        message: 'Too many refreshes. Give it a moment.',
    }),
    shareController.getSharedMessages
);

// A handoff is two or three sentences. This is sized so a link that got
// forwarded somewhere it shouldn't cannot be turned into a way to buzz a
// working valet's phone all morning — so unlike verify, every send counts,
// including the ones that land.
router.post(
    '/:token/messages',
    rateLimit({
        windowMs: 5 * 60 * 1000,
        max: 10,
        keyFrom: byToken,
        message: 'That is a lot of messages. Wait a few minutes.',
    }),
    shareController.sendSharedMessage
);

module.exports = router;
