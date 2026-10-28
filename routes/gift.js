const express = require('express');
const requireSelf = require('../middleware/requireSelf');
const { getBalance, getGift, redeemGift } = require('../controllers/giftCardController');

const router = express.Router();

router.post('/redeem', requireSelf((req) => req.body?.userId), redeemGift);
router.get('/balance', requireSelf((req) => req.query?.userId), getBalance);
router.get('/:code', getGift);

module.exports = router;
