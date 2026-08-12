const express = require('express');
const router = express.Router();
const multer = require('multer');

const streetParkingController = require('../controllers/streetParkingController');

const photoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 12 * 1024 * 1024 },
});

// Viewport query for the heat-map overlay
router.get('/', streetParkingController.listInBbox);

// New "tap a line" UX — returns every block-side polyline near a coord
// with current consensus level joined onto each.
router.get('/segments-near', streetParkingController.segmentsNear);

// CRUD for a mark
router.post('/', streetParkingController.create);
router.put('/:id', streetParkingController.update);
router.delete('/:id', streetParkingController.remove);

// Segment-level reporting (verified-tier consensus override)
router.post('/report', streetParkingController.reportSegment);

// Optional sign photo upload
router.post(
    '/:id/photo',
    photoUpload.single('signPhoto'),
    streetParkingController.uploadPhoto
);

module.exports = router;
