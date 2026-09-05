const express = require('express');
const requireSelf = require('../middleware/requireSelf');
const { requireValet, requireOrderOwner } = requireSelf;
const router = express.Router();
const {
    createOrder,
    createRetrievalOrder,
    getPendingOrders,
    acceptOrder,
    hasActiveOrder,
    updateValetLocation,
    updateOrder,
    getOrdersByUser,
    validateSubscriptionForOrder,
    addVehicleInfo,
    getTodaysParkedCars,
    updateCarLocation,
    calculateConversationDistances,
    verifyOTP,
    checkAspOrders,
    setAwaySchedule,
    generateReturnKeyOtp,
    checkKeyTagAvailability,
    cancelOrder,
    valetCancelOrder,
    recordKeyDropoff,
    cancelRetrievalLeg,
    requestKeyReturn,
    generateKeyReturnOtp,
    verifyKeyReturnOtp,
} = require('../controllers/orderController');
const tipController = require('../controllers/tipController');
const orderPhotoController = require('../controllers/orderPhotoController');
const parkingNoteController = require('../controllers/parkingNoteController');
const extensionController = require('../controllers/extensionController');
const multer = require('multer');
const photoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 12 * 1024 * 1024 },     // 12 MB
});

router.post('/createOrder', validateSubscriptionForOrder, createOrder);
router.post('/createRetrievalOrder', validateSubscriptionForOrder, createRetrievalOrder);
// The open job board. It published every pending order — each customer's
// ObjectId, their pickup address, their licence plate — to anyone who asked,
// and those ObjectIds are the input that the other userId-trusting endpoints
// take. Closing this closes the way an attacker finds who to attack.
//
// Only the valet app has ever called it (context/OrderContext.js), and it has
// sent a Firebase ID token on every request since 2.2.0. The web app does not
// call it at all.
router.get('/getPendingOrders', requireValet(), getPendingOrders);
router.post('/acceptOrder', acceptOrder);
// Both of these name a user in the QUERY STRING and hand back whole Order
// documents with the live `otp.code` on them — the six digits that release a
// car — plus the address it is parked at. A customer ObjectId is not a secret,
// so until now a stranger holding one could read the code for a car sitting on
// the street right now.
//
// The code STAYS in the body on both. It is not a leak to the two people in
// the handoff: the valet reads it out to collect the keys
// (hooks/useConversation.js:727) and the customer reads it out to get them
// back (UserHomeScreen.js:574, tracking.tsx:236) — and `getOrdersByUser` is
// the customer's only source once the park is closed out. The fix is proving
// who is asking, not blanking the number.
//
// Every caller in both clients names their OWN id, on both the customer and
// the valet branch (`isValet` only picks which query runs, never whose id is
// read), so one pick covers both.
router.get('/hasActiveOrder', requireSelf((req) => req.query?.userId), hasActiveOrder);
router.post('/updateValetLocation', updateValetLocation);
router.post('/updateOrder', updateOrder);
router.get('/getOrdersByUser', requireSelf((req) => req.query?.userId), getOrdersByUser);
router.post('/addVehicleInfo', addVehicleInfo);
router.post('/checkKeyTagAvailability', checkKeyTagAvailability);
router.get('/getTodaysParkedCars/:valetId', getTodaysParkedCars);
router.post('/updateCarLocation', updateCarLocation);
router.post('/verifyOTP', verifyOTP);
router.post('/calculateConversationDistances', calculateConversationDistances);
router.post('/checkAspOrders', checkAspOrders);
router.post('/setAwaySchedule', setAwaySchedule);
router.post('/return_key', generateReturnKeyOtp);
router.post('/cancelOrder', cancelOrder);
router.post('/valetCancelOrder', valetCancelOrder);

// --- Tips (100% pass-through to valet) ---
// A tip charges the customer's saved card off-session. It named only the
// order, and order ids travel with the order documents themselves, so anybody
// holding one could tip a valet off somebody else's card. The web client had
// to start sending its token for this one — createTip was hand rolled around
// `fetch` and was the only call in that app with no Authorization header.
router.post('/:orderId/tip', requireOrderOwner(), tipController.createTip);
router.get('/:orderId/tips', tipController.getOrderTips);

// --- Order handoff photos (pre-pickup + post-park, gates the
//     valet-side actions until photo is captured). Mobile UI lands
//     in build 11; backend foundation is ready.
router.post(
    '/:orderId/photos',
    photoUpload.single('file'),
    orderPhotoController.uploadPhoto
);
router.get('/:orderId/photos', orderPhotoController.listPhotos);

// --- Parking notes (structured rules + sign photo, required at park-
//     complete). Geo-radius lookups live on /api/parking-notes/near.
router.post(
    '/:orderId/parking-note',
    photoUpload.single('signPhoto'),
    parkingNoteController.createParkingNote
);
router.get('/:orderId/parking-note', parkingNoteController.getParkingNoteForOrder);

// --- Key drop-off location: captured by the valet when the customer
//     hands over keys (collect-keys OTP verified). Used as the default
//     retrieval pickup pin and as the dispatch anchor for build 12.
router.post('/:orderId/key-dropoff', recordKeyDropoff);

// --- Park & Retrieve: call off the prepaid return trip. Refunds the
//     return portion against the parking order's own PaymentIntent and
//     closes the order; the car stays where it is.
router.post('/:orderId/cancel-retrieval', cancelRetrievalLeg);

// --- Duration extensions: customer or doorman extends an active parking
//     order. Two-phase: create PaymentIntent, then confirm after the
//     mobile PaymentSheet succeeds. Pricing $5 first hr, +$1 each after.
router.post('/:orderId/extend', extensionController.createExtensionIntent);
router.post('/:orderId/extend/confirm', extensionController.confirmExtension);

// --- Key-return handoff (park-and-hold / enterprise). Insurance gate:
//     valet must hand keys to the front desk before the order completes.
//     Front desk generates OTP, valet types it to verify.
router.post('/:orderId/key-return/request', requestKeyReturn);
router.post('/:orderId/key-return/generate-otp', generateKeyReturnOtp);
router.post('/:orderId/key-return/verify-otp', verifyKeyReturnOtp);

module.exports = router;
