const express = require('express');
const router = express.Router();
const {
    createPaymentIntent,
    createSetupIntent,
    updatePaymentStatus,
    getPaymentStatus,
    createGuestPaymentLink,
    handleStripeWebhook,
} = require('../controllers/paymentController');

router.post('/createSetupIntent', createSetupIntent);
router.post('/createPaymentIntent', createPaymentIntent);
router.post('/updatePaymentStatus', updatePaymentStatus);
router.get('/getPaymentStatus', getPaymentStatus);
router.post('/createGuestPaymentLink', createGuestPaymentLink);
router.post('/webhook', handleStripeWebhook);
router.post('/webhook/test', handleStripeWebhook); // Test endpoint without raw body requirement

module.exports = router;
