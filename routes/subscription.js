const express = require('express');
const router = express.Router();
const requireSelf = require('../middleware/requireSelf');
const { requireCurrentApp } = require('../services/appGate');
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
    addExtraCar,
    removeExtraCar,
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
router.post('/create', requireCurrentApp, createSubscription);
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
// A second car on the plan, $150/mo (Nov 4 2026). The holder only.
router.post('/extra-car', requireSelf((req) => req.body?.userId), addExtraCar);
router.post('/extra-car/remove', requireSelf((req) => req.body?.userId), removeExtraCar);

// What moving the fixed address would cost: it reads the caller's own price.
router.post('/move-preview', requireSelf((req) => req.body?.userId), movePreview);
// Same gate, same reasons, one more since accounts can be linked (2026-09-23).
// This edits the plan's cleaning days AND its fixed address — the spot the $250
// plan's free park is paid inside — for whatever userId the body names. A
// linked partner is handed the holder's `_id` in every partner summary, so
// ungated this was one PUT from the partner re-pointing the holder's plan,
// which only the holder may do.
router.put('/schedule', requireSelf((req) => req.body?.userId), updateSchedule);
router.get('/prefill/:userId', getPrefill);

module.exports = router;
