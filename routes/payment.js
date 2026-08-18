const express = require('express');
const router = express.Router();
const {
    createPaymentIntent,
    getPaymentStatus,
    createGuestPaymentLink,
    handleStripeWebhook,
} = require('../controllers/paymentController');

router.post('/createPaymentIntent', createPaymentIntent);

// POST /updatePaymentStatus is GONE.
//
// It took an orderId and a paymentIntentId, confirmed with Stripe only that
// the intent had succeeded, and then marked that order paid — without ever
// checking the intent belonged to it. One real payment could therefore mark
// unlimited orders paid, each dispatching a valet who is credited 70% of the
// order on completion. It also wrote the client's own amount/chargeId/receipt
// into paymentDetails, so the forged record looked right.
//
// Nothing calls it: not the mobile app, and the web checkout's own comment
// says it 500s and is unused. The Stripe webhook (below) is the only thing
// that should ever move an order to paid, and it verifies the signature and
// reads the amount back from Stripe. If a replacement is ever needed, it must
// assert intent.metadata.orderId === orderId and intent.amount_received >=
// order.totalAmount — the way extensionController.confirmExtension does.
router.get('/getPaymentStatus', getPaymentStatus);
router.post('/createGuestPaymentLink', createGuestPaymentLink);
router.post('/webhook', handleStripeWebhook);
router.post('/webhook/test', handleStripeWebhook); // Test endpoint without raw body requirement

module.exports = router;
