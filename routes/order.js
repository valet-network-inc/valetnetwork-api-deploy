const express = require('express');
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
router.get('/getPendingOrders', getPendingOrders);
router.post('/acceptOrder', acceptOrder);
router.get('/hasActiveOrder', hasActiveOrder);
router.post('/updateValetLocation', updateValetLocation);
router.post('/updateOrder', updateOrder);
router.get('/getOrdersByUser', getOrdersByUser);
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
router.post('/:orderId/tip', tipController.createTip);
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
