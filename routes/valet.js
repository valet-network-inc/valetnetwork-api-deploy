const express = require('express');
const multer = require('multer');
const router = express.Router();
const payoutController = require('../controllers/payoutController');
const backgroundCheckController = require('../controllers/backgroundCheckController');
const valetDocumentController = require('../controllers/valetDocumentController');
const tipController = require('../controllers/tipController');

// In-memory file upload (DL photos are small, max 10 MB).
// Buffer is forwarded to Firebase Storage; nothing hits disk.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
});

// --- Earnings + payouts ---
router.get('/earnings', payoutController.getEarnings);
router.patch('/payoutMethod', payoutController.updatePayoutMethod);
router.post('/requestPayout', payoutController.requestPayout);
router.get('/payoutHistory', payoutController.getPayoutHistory);

// --- Background checks ---
router.post('/initiateBackgroundCheck', backgroundCheckController.initiate);
router.post('/resendBackgroundCheckInvitation', backgroundCheckController.resendInvitation);
router.get('/backgroundCheckStatus', backgroundCheckController.getStatus);

// --- Driver's license document upload ---
// Multipart form: fields { userId, type } + file field "file"
router.post(
    '/uploadDriversLicense',
    upload.single('file'),
    valetDocumentController.uploadDriversLicense
);
router.get('/myDocuments', valetDocumentController.getMyDocuments);

// --- Tips received (history + totals for the earnings card) ---
router.get('/tips', tipController.getValetTips);

module.exports = router;
