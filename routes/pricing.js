const express = require('express');
const router = express.Router();
const { getPricing, updatePricing } = require('../controllers/pricingController');

// Public read (mobile app fetches on launch).
router.get('/', getPricing);

// Admin write (dashboard). NOTE: matches the existing admin routes' open trust
// model — no auth middleware. Add an auth gate here + on the dashboard before
// treating prices as tamper-proof.
router.put('/', updatePricing);

module.exports = router;
