const express = require('express');
const router = express.Router();
const {
    getPlans,
    createSubscription,
    getSubscriptionStatus,
    cancelSubscription,
    changePlan,
    updateSchedule,
    getPrefill,
    checkPromo,
} = require('../controllers/subscriptionController');

// Subscriptions v2 (Stripe Billing). The pre-v2 doorman-referral routes
// (/generate-referral, /process-billing, /process-payouts, /referred, /count)
// are gone — /process-billing and /process-payouts were unauthenticated
// money-moving endpoints and nothing shipped ever called them.

router.get('/plans', getPlans);
router.post('/promo', checkPromo);
router.post('/create', createSubscription);
router.get('/status/:userId', getSubscriptionStatus);
router.post('/cancel', cancelSubscription);
router.post('/change', changePlan);
router.put('/schedule', updateSchedule);
router.get('/prefill/:userId', getPrefill);

module.exports = router;
