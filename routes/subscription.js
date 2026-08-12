const express = require('express');
const router = express.Router();
const {
    createSubscription,
    generateReferralCode,
    getSubscriptionStatus,
    processSubscriptionBilling,
    processDoormanPayouts,
    cancelSubscription,
    getActiveSubscriptionCount,
    getReferredSubscriptions,
} = require('../controllers/subscriptionController');

// Create a new subscription
router.post('/create', createSubscription);

// Generate referral code for doorman
router.post('/generate-referral', generateReferralCode);

// Get subscription status
router.get('/status/:userId', getSubscriptionStatus);

// Process subscription billing (admin/scheduled endpoint)
router.post('/process-billing', processSubscriptionBilling);

// Process doorman payouts (admin/scheduled endpoint)
router.post('/process-payouts', processDoormanPayouts);

// Cancel subscription
router.delete('/cancel/:subscriptionId', cancelSubscription);

// Get total number of active subscriptions
router.get('/count', getActiveSubscriptionCount);

// Get all subscriptions referred by a doorman
router.get('/referred/:doormanId', getReferredSubscriptions);

module.exports = router;
