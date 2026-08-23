const express = require('express');
const router = express.Router();
const {
    getBusinessMetrics,
    getUserMetrics,
    getValetMetrics,
    deactivateValet,
    reactivateValet,
    getValetListWithMetrics,
    getCustomerList,
    getServiceList,
    getCheckoutFunnel,
} = require('../controllers/adminController');
const {
    listAllPayouts,
    markPayoutPaid,
} = require('../controllers/payoutController');
const valetOnboardingAdmin = require('../controllers/valetOnboardingAdminController');
const providerRecipient = require('../controllers/providerRecipientController');
const orderPhotoController = require('../controllers/orderPhotoController');
const adminNotification = require('../controllers/adminNotificationController');
const parkingNoteController = require('../controllers/parkingNoteController');
const aspSuspensionAdmin = require('../controllers/aspSuspensionAdminController');
const adminSubscription = require('../controllers/adminSubscriptionController');
const adminPromo = require('../controllers/adminPromoController');
const requireAdminKey = require('../middleware/requireAdminKey');

// Everything below this line needs the `x-admin-key` header. Only the four
// notification routes used to be gated, which left the customer list, the
// metrics, the valet roster, the payout queue and the parking photos readable
// by anyone who knew the URL. The dashboard sends the key on every call.
router.use(requireAdminKey);

// --- NYC alternate-side suspension calendar ---------------------------
// Paste the year's .ics (or the text out of the DOT PDF) once, then add snow
// days as the city calls them. Both the free reminder and the subscription
// scheduler read this, so an empty calendar means we confidently tell people
// to move their car on Thanksgiving.
router.get('/asp-suspensions', aspSuspensionAdmin.list);
router.post('/asp-suspensions', aspSuspensionAdmin.create);
router.post('/asp-suspensions/import', aspSuspensionAdmin.import);
router.post('/asp-suspensions/check-311', aspSuspensionAdmin.check);
router.delete('/asp-suspensions/:date', aspSuspensionAdmin.remove);

// Cheap "is this key good?" probe for the dashboard's unlock screen. Does no
// work beyond passing the gate above, so it can be called on every page load.
router.get('/session', (req, res) => res.json({ success: true }));

// Business metrics
router.get('/metrics/business', getBusinessMetrics);

// User metrics
router.get('/metrics/users', getUserMetrics);

// Valet metrics
router.get('/metrics/valets', getValetMetrics);

// Valet management
router.get('/valets', getValetListWithMetrics);
router.post('/valets/deactivate', deactivateValet);
router.post('/valets/reactivate', reactivateValet);

// --- Contractor onboarding (Insurance & Liability tab) ---
// Queue + list views
router.get('/valets/onboarding/pending-provider-approval', valetOnboardingAdmin.listPendingProviderApproval);
router.get('/valets/onboarding/by-status', valetOnboardingAdmin.listByStatus);
// Per-valet detail + document viewing
router.get('/valets/onboarding/:userId', valetOnboardingAdmin.getValetOnboardingDetail);
router.get('/valets/onboarding/:userId/documents/:docId/signed-url', valetOnboardingAdmin.getDocumentSignedUrl);
router.get('/valets/onboarding/:userId/data-package', valetOnboardingAdmin.getDataPackage);
// Action endpoints
router.post('/valets/onboarding/:userId/authorize', valetOnboardingAdmin.authorizeValet);
router.post('/valets/onboarding/:userId/force-activate', valetOnboardingAdmin.forceActivate);
router.post('/valets/onboarding/:userId/suspend', valetOnboardingAdmin.suspendValet);
router.post('/valets/onboarding/:userId/reinstate', valetOnboardingAdmin.reinstateValet);

// --- Provider recipient list (auto-send destinations) ---
router.get('/provider-recipients', providerRecipient.list);
router.post('/provider-recipients', providerRecipient.create);
router.patch('/provider-recipients/:id', providerRecipient.update);
router.delete('/provider-recipients/:id', providerRecipient.remove);

// Customer list (non-valet users)
router.get('/users', getCustomerList);
// Every service request ever created, for the "Services" tab.
router.get('/services', getServiceList);

// --- Subscribers ------------------------------------------------------
// Every plan ever bought, with the customer joined in and the roll-ups the
// console would otherwise recompute per filter. Stripe knows the billing;
// this is the only place the billing, the schedule, the covered orders and
// the suspension credits sit on one row.
router.get('/subscriptions', adminSubscription.getSubscriptionOverview);

// --- campaign promo codes hung on accounts ----------------------------
// Lets a push promise a free month without the customer hunting for the
// "Have a code?" field on the build already on their phone.
router.get('/pending-promo', adminPromo.listPendingPromo);
router.post('/pending-promo', adminPromo.setPendingPromo);
// Where paying customers stop — built from server-side stamps only.
router.get('/checkout-funnel', getCheckoutFunnel);

// Payouts (manual settlement queue)
router.get('/payouts', listAllPayouts);
router.post('/payouts/:id/markPaid', markPayoutPaid);

// Parking photos — dashboard tabs + hard-delete actions.
// "Customer photos" tab: order-tied pre/post photos.
router.get('/parking-photos', orderPhotoController.adminListParkingPhotos);
router.delete('/parking-photo/:id', orderPhotoController.adminDeletePhoto);
// "Street parking rules" tab: ParkingNote sign photos.
router.get('/parking-rule-photos', parkingNoteController.adminListParkingRulePhotos);
router.delete('/parking-rule-photo/:id', parkingNoteController.adminDeleteParkingRulePhoto);

// Push notifications (dashboard "Notifications" tab).
// The controller and the dashboard UI both existed, but nothing ever mounted
// these routes, so every call from the tab 404'd and the feature looked broken.
// Paths match what adminService.js already requests.
router.get('/notifications/audience-counts', adminNotification.getAudienceCounts);
router.get('/notifications/history', adminNotification.getNotificationHistory);
router.post('/notifications/send', adminNotification.sendAdminNotification);
router.post('/notifications/run-parking-alerts', adminNotification.runParkingAlertsNow);

module.exports = router;
