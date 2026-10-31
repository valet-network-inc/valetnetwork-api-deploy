const express = require('express');
const { viewPhotoByLink } = require('../controllers/orderPhotoController');

const router = express.Router();

// The link in a photo's chat message (see viewPhotoByLink).
router.get('/:token', viewPhotoByLink);

module.exports = router;
