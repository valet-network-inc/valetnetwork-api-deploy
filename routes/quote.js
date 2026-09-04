const express = require('express');
const router = express.Router();
const { quoteOrder } = require('../controllers/quoteController');

// Mounted at /api/subscription/quote (server.js). Its own router rather than a
// line in routes/subscription.js because the question it answers is about an
// order — "what does THIS booking cost me" — and the answer covers per-use
// customers who have no subscription at all.
router.post('/', quoteOrder);

module.exports = router;
