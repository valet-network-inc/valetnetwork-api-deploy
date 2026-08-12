const express = require('express');
const router = express.Router();
const {
    validateEventCode,
    incrementEventUsage,
    getEventDetails
} = require('../controllers/eventController');

// Validate event code
router.post('/validate', validateEventCode);

// Increment event usage (to be called when order is created with event code)
router.post('/increment-usage', incrementEventUsage);

// Get event details by code
router.get('/:code', getEventDetails);

module.exports = router;