const express = require('express');
const router = express.Router();
const parkingNoteController = require('../controllers/parkingNoteController');

// GET /api/parking-notes/near?lat=X&lng=Y&radiusMeters=N
// Used by build 12's smart-placement to look up parking-rules history
// for nearby blocks. Order-scoped endpoints live under /api/order.
router.get('/near', parkingNoteController.getParkingNotesNear);

module.exports = router;
