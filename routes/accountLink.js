const express = require('express');
const router = express.Router();
const rateLimit = require('../middleware/rateLimit');
const requireSelf = require('../middleware/requireSelf');
const accountLinkController = require('../controllers/accountLinkController');

// Link account (controllers/accountLinkController.js). Every route names the
// caller's own customer id and proves it with their Firebase ID token.
//
// The pick is explicit per route rather than requireSelf's default, which
// honours `?userId=` on a POST too: a caller could satisfy the check as
// themselves in the query while the body named somebody else. The POSTs read
// the body and only the body; the one GET reads the query.
const bodyUserId = (req) => req.body?.userId;
const queryUserId = (req) => req.query?.userId;

// Metered exactly the way routes/share.js meters the doorman link, and for the
// same two reasons:
//
//   - Keyed on the customer id, so one person's tapping can never lock
//     somebody else out.
//   - A request the ownership gate turned away (401/403) costs nothing. A
//     customer id is not a secret, so charging those would let a stranger
//     spend somebody's budget and lock them out of their own panel.
//
// Placed in front of requireSelf so that once a budget is spent, the answer
// is a 429 without a round trip to Google's keys.
const meter = ({ windowMs, max, keyFrom, message }) =>
    rateLimit({
        windowMs,
        max,
        keyFrom,
        message,
        countWhen: (res) => res.statusCode !== 401 && res.statusCode !== 403,
    });

const HOUR = 60 * 60 * 1000;

// Sending requests: ten an hour per account. Linking is something a person
// does once, maybe twice after a typo; each request can push somebody, so
// this is the one worth keeping tight.
const perHourRequest = meter({
    windowMs: HOUR,
    max: 10,
    keyFrom: bodyUserId,
    message: 'Too many requests. Try again in a little while.',
});
const perHourAnswer = meter({
    windowMs: HOUR,
    max: 20,
    keyFrom: bodyUserId,
    message: 'Too many changes. Try again in a little while.',
});

// The panel polls this every 3 s while it is open (20 a minute), and a
// customer with the app and /park both open is normal. Same pace as the
// doorman screen's poll.
const perMinuteStatus = meter({
    windowMs: 60 * 1000,
    max: 60,
    keyFrom: queryUserId,
    message: 'Too many refreshes. Give it a moment.',
});

router.post('/request', perHourRequest, requireSelf(bodyUserId), accountLinkController.request);
router.post('/authorize', perHourAnswer, requireSelf(bodyUserId), accountLinkController.authorize);
router.post('/decline', perHourAnswer, requireSelf(bodyUserId), accountLinkController.decline);
router.post('/unlink', perHourAnswer, requireSelf(bodyUserId), accountLinkController.unlink);
router.get('/status', perMinuteStatus, requireSelf(queryUserId), accountLinkController.status);

module.exports = router;
