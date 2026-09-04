const express = require('express');
const multer = require('multer');
const router = express.Router();
const payoutController = require('../controllers/payoutController');
const backgroundCheckController = require('../controllers/backgroundCheckController');
const valetDocumentController = require('../controllers/valetDocumentController');
const tipController = require('../controllers/tipController');
const requireSelf = require('../middleware/requireSelf');

// In-memory file upload (DL photos are small, max 10 MB).
// Buffer is forwarded to Firebase Storage; nothing hits disk.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
});

// --- Earnings + payouts ---
//
// These four took a bare `userId` and trusted it, so anybody could read a
// valet's earnings, repoint their Zelle handle at their own, and then request
// the balance — the queue is settled by hand from the admin console, so the
// only thing standing between that and a real payment was somebody noticing
// the handle had changed.
//
// Safe to gate today because the valet app is the only caller: it sends a
// Firebase ID token on every request (utils/apiAuth.js, shipped since 2.2.0)
// and the web app never touches /api/valet at all.
router.get('/earnings', requireSelf(), payoutController.getEarnings);
router.patch('/payoutMethod', requireSelf(), payoutController.updatePayoutMethod);
router.post('/requestPayout', requireSelf(), payoutController.requestPayout);
router.get('/payoutHistory', requireSelf(), payoutController.getPayoutHistory);

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
