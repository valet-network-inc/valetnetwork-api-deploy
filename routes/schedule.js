const express = require('express');
const router = express.Router();
const requireSelf = require('../middleware/requireSelf');
const moves = require('../services/scheduledMoves');

// Pick-ups and drop-offs booked for later (spec v2, 8): Home's "Coming up".
const self = requireSelf((req) => req.params?.userId || req.body?.userId || req.query?.userId);

const wrap = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (err) {
        console.error(`schedule ${req.method} ${req.originalUrl} failed:`, err);
        res.status(500).json({ success: false, message: 'Something went wrong. Try again.' });
    }
};
const send = (res, r, ok) =>
    r.error ? res.status(r.status || 400).json({ success: false, message: r.error }) : res.status(ok).json({ success: true, ...r });

router.get('/mine/:userId', self, wrap(async (req, res) => res.json({ success: true, moves: await moves.mine(req.callerUserId) })));
router.post('/', self, wrap(async (req, res) => send(res, await moves.create(req.callerUserId, req.body || {}), 201)));
router.patch('/:id', self, wrap(async (req, res) => send(res, await moves.update(req.callerUserId, req.params.id, req.body || {}), 200)));
router.delete('/:id', self, wrap(async (req, res) => send(res, await moves.cancel(req.callerUserId, req.params.id, req.body || {}), 200)));

module.exports = router;
