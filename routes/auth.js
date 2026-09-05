const express = require('express');
const router = express.Router();
const {
    loginUser,
    updateUser,
    getUsers,
    getUserById,
    updateLocation,
    deleteAccount,
    checkUserType,
} = require('../controllers/authController');

router.post('/loginUser', loginUser);
router.post('/updateUser', updateUser);
router.get('/getUsers', getUsers);
// DELIBERATELY UNGATED. It does leak the whole user record to anyone who names
// an id, but the shipped app resolves the OTHER party's firebaseUid through it
// on every push — NotificationService.js:104/111/170/179 fetch the RECEIVER
// and the SENDER — so requireSelf 403s the receiver lookup and every chat and
// job notification stops arriving. Fixing it properly means either a narrow
// "who is this push for" endpoint that returns only a firebaseUid, or moving
// the lookup server-side. Raised, not taken.
router.get('/getUserById/:userId', getUserById);
router.post('/updateLocation', updateLocation);
router.delete('/deleteAccount/:userId', deleteAccount);
router.post('/checkUserType', checkUserType);

module.exports = router;
