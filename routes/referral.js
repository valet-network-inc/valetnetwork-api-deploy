const express = require('express');
const router = express.Router();
const requireSelf = require('../middleware/requireSelf');
const w = require('../controllers/waitlistController');

// Refer a friend: payout method first, then the code (their phone number).
const self = requireSelf((req) => req.params?.userId);

// Public: the share link's landing (who shared it, their neighborhood's count).
router.get('/share/:code', w.shareInfo);
router.get('/:userId', self, w.referral);
// The app's paths for the same two calls.
const selfBody = requireSelf((req) => req.params?.userId || req.body?.userId);
router.get('/mine/:userId', selfBody, w.referral);
router.put('/payout', selfBody, w.savePayout);
router.put('/:userId/payout', self, w.savePayout);
router.post('/:userId/payout', self, w.savePayout);

module.exports = router;
