const express = require('express');
const router = express.Router();
const {
    markFreeSpace,
    deleteFreeSpace,
    listFreeSpaces,
    listFreeSpacesByUser
} = require('../controllers/locationController');

router.post('/mark-free-space', markFreeSpace);
router.delete('/free-space/:freeSpaceId', deleteFreeSpace);
router.get('/free-spaces', listFreeSpaces);
router.get('/free-spaces/user/:userId', listFreeSpacesByUser);

module.exports = router;
