const express = require('express');
const router = express.Router();
const requireSelf = require('../middleware/requireSelf');
const {
    getPlans,
    createSubscription,
    getSubscriptionStatus,
    cancelSubscription,
    changePlan,
    updateSchedule,
    getPrefill,
    checkPromo,
    quotePrice,
    getNeighborhoodPrices,
    movePreview,
} = require('../controllers/subscriptionController');

// Subscriptions v2 (Stripe Billing). The pre-v2 doorman-referral routes
// (/generate-referral, /process-billing, /process-payouts, /referred, /count)
// are gone — /process-billing and /process-payouts were unauthenticated
// money-moving endpoints and nothing shipped ever called them.

router.get('/plans', getPlans);
router.post('/promo', checkPromo);
// The review card, priced by the server, and the sheet /pricing renders.
// Both public: they price a plan, and say nothing about anyone's account.
router.post('/price', quotePrice);
router.get('/neighborhood-prices', getNeighborhoodPrices);
router.post('/create', createSubscription);
router.get('/status/:userId', getSubscriptionStatus);

// Cancel and change both take the userId out of the BODY and act on whatever
// Stripe subscription that id owns, with no proof the caller is that person.
// A change can `always_invoice` the victim's saved card for an upgrade; a
// cancel ends their street-cleaning coverage and stops the ASP scheduler from
// moving the car before the sweep. The only callers of either are the account
// holder themselves — iOS SubscriptionSection.js:490/532 and, for cancel, the
// web plan-manage.tsx:78 — and both clients attach the Firebase ID token.
//
// The pick is explicit rather than the middleware's default, because the
// default also honours `?userId=`, which neither controller reads: a caller
// could then satisfy the check as themselves while the body named someone
// else's plan.
router.post('/cancel', requireSelf((req) => req.body?.userId), cancelSubscription);
router.post('/change', requireSelf((req) => req.body?.userId), changePlan);

// What moving the fixed address would cost: it reads the caller's own price.
router.post('/move-preview', requireSelf((req) => req.body?.userId), movePreview);
router.put('/schedule', updateSchedule);
router.get('/prefill/:userId', getPrefill);

module.exports = router;
