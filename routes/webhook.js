const express = require('express');
const router = express.Router();
const backgroundCheckController = require('../controllers/backgroundCheckController');

// Certn calls here when a background check application's status changes.
// Kept for the transition period — Yardstik replaces Certn but we keep both
// routes wired until Phase 5 cleanup.
router.post('/certn', backgroundCheckController.certnWebhook);

// Yardstik calls here when a report's status changes. Signature is verified
// inside the handler using the WEBHOOK_SIGNATURE key from Yardstik dashboard
// (env var YARDSTIK_WEBHOOK_SIGNATURE_KEY).
router.post('/yardstik', backgroundCheckController.yardstikWebhook);

module.exports = router;
