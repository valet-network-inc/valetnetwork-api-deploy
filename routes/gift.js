const express = require('express');
const requireSelf = require('../middleware/requireSelf');
const { getGift, redeemGift } = require('../controllers/giftCardController');

const router = express.Router();

router.post('/redeem', requireSelf((req) => req.body?.userId), redeemGift);
router.get('/:code', getGift);

module.exports = router;
