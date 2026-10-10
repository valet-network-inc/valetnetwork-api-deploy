const express = require('express');
const router = express.Router();
const requireSelf = require('../middleware/requireSelf');
const w = require('../controllers/waitlistController');

// Refer a friend: payout method first, then the code (their phone number).
const self = requireSelf((req) => req.params?.userId);

router.get('/:userId', self, w.referral);
router.put('/:userId/payout', self, w.savePayout);
router.post('/:userId/payout', self, w.savePayout);

module.exports = router;
