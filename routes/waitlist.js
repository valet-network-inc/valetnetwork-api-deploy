const express = require('express');
const router = express.Router();
const requireSelf = require('../middleware/requireSelf');
const w = require('../controllers/waitlistController');

const self = requireSelf((req) => req.body?.userId || req.query?.userId || req.params?.userId);

// Public: the invite link and the share link are the invitation.
router.get('/invite/:token', w.preview);
router.get('/neighborhood/:key', w.neighborhood);

router.get('/mine/:userId', self, w.mine);
router.post('/invite/:token/claim', self, w.claimInvite);
router.post('/members/:memberId/setup-intent', self, w.setupIntent);
router.post('/members/:memberId/confirm', self, w.confirm);
router.patch('/members/:memberId', self, w.edit);
router.post('/members/:memberId/leave', self, w.leave);

module.exports = router;
