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
router.get('/getUserById/:userId', getUserById);
router.post('/updateLocation', updateLocation);
router.delete('/deleteAccount/:userId', deleteAccount);
router.post('/checkUserType', checkUserType);

module.exports = router;
