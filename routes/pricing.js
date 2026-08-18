const express = require('express');
const router = express.Router();
const { getPricing, updatePricing } = require('../controllers/pricingController');
const requireAdminKey = require('../middleware/requireAdminKey');

// Public read (mobile app fetches on launch).
router.get('/', getPricing);

// Admin write (dashboard). These values are what the apps quote AND what the
// server now charges, so an open write here set the price of every order in
// the system. Gated on the same x-admin-key the dashboard already sends to
// /api/admin.
router.put('/', requireAdminKey, updatePricing);

module.exports = router;
