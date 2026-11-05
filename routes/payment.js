const express = require('express');
const router = express.Router();
const {
    createPaymentIntent,
    getPaymentStatus,
    createGuestPaymentLink,
    handleStripeWebhook,
} = require('../controllers/paymentController');

// DELIBERATELY UNGATED. A stranger holding an order id can mint an intent
// against somebody else's booking, which is real — but the shipped iOS app
// calls this with raw `fetch`, not the axios client that carries the token
// (OrderPreferencesScreen.js:579 and EnterpriseSummonScreen.js:257), so any
// gate here 401s checkout on every binary in the field. It has to be fixed in
// the app first and enforced a release later. Raised, not taken.
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

// The app's "Pay with" row (Nov 5 2026): the user's saved cards, their
// default and any credit, and a way to change the default. Their own only.
const requireSelf = require('../middleware/requireSelf');
const paymentMethods = require('../services/paymentMethods');
const self = requireSelf((req) => req.params?.userId || req.body?.userId || req.query?.userId);
router.get('/methods/:userId', self, async (req, res) => {
    try {
        res.json({ success: true, ...(await paymentMethods.list(req.callerUserId)) });
    } catch (err) {
        console.error('payment methods: list failed:', err.message);
        res.status(500).json({ success: false, message: 'Could not load your payment methods.' });
    }
});
router.post('/methods/default', self, async (req, res) => {
    try {
        const out = await paymentMethods.setDefault(req.callerUserId, String(req.body?.paymentMethodId || ''));
        if (out.error) return res.status(out.status).json({ success: false, message: out.error });
        res.json({ success: true, ...out });
    } catch (err) {
        console.error('payment methods: default failed:', err.message);
        res.status(500).json({ success: false, message: 'Could not change your card.' });
    }
});
router.post('/createGuestPaymentLink', createGuestPaymentLink);
router.post('/webhook', handleStripeWebhook);
router.post('/webhook/test', handleStripeWebhook); // Test endpoint without raw body requirement

module.exports = router;
