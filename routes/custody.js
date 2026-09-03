const express = require('express');
const router = express.Router();
const custodyController = require('../controllers/custodyController');

/**
 * What a customer can do about a car we are holding.
 *
 * Only one thing, and it is the important one: get the keys back. On the $250
 * and $300 plans the valet keeps them after every park, which is the only way
 * we can move the car before its block is swept without the customer standing
 * at the curb twice per cleaning. That arrangement is only fair if undoing it
 * takes one tap, which is what this route is.
 */
router.post('/request-keys', custodyController.requestKeys);
router.get('/mine/:userId', custodyController.getMine);

module.exports = router;
