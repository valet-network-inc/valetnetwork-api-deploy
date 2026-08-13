const express = require('express');
const router = express.Router();
const {
    getBusinessMetrics,
    getUserMetrics,
    getValetMetrics,
    deactivateValet,
    reactivateValet,
    getValetListWithMetrics,
    getCustomerList
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
//
// These are the only admin routes behind requireAdminKey (an `x-admin-key`
// header). Everything above is unauthenticated — see the separate note about
// that; broadcasting to every customer is not something to leave open.
router.get(
    '/notifications/audience-counts',
    adminNotification.requireAdminKey,
    adminNotification.getAudienceCounts
);
router.get(
    '/notifications/history',
    adminNotification.requireAdminKey,
    adminNotification.getNotificationHistory
);
router.post(
    '/notifications/send',
    adminNotification.requireAdminKey,
    adminNotification.sendAdminNotification
);
router.post(
    '/notifications/run-parking-alerts',
    adminNotification.requireAdminKey,
    adminNotification.runParkingAlertsNow
);

module.exports = router;
