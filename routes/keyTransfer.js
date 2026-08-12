const express = require('express');
const router = express.Router();
const keyTransferController = require('../controllers/keyTransferController');
const User = require('../models/User');

const authenticateValet = async (req, res, next) => {
    try {
        const userId = req.body.userId || req.query.userId;
        
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'User ID is required',
            });
        }

        const user = await User.findById(userId);
        
        if (!user || !user.isValet) {
            return res.status(403).json({
                success: false,
                message: 'Only valets can access key transfer features',
            });
        }

        req.user = { id: userId, ...user.toObject() };
        next();
    } catch (error) {
        console.error('Authentication error:', error);
        res.status(500).json({
            success: false,
            message: 'Authentication failed',
            error: error.message,
        });
    }
};

router.get('/my-keys', authenticateValet, keyTransferController.getMyKeys);
router.get('/outgoing', authenticateValet, keyTransferController.getOutgoingTransfers);
router.get('/incoming', authenticateValet, keyTransferController.getIncomingTransfers);
router.get('/active-valets', authenticateValet, keyTransferController.getActiveValets);
router.get('/audit-logs', authenticateValet, keyTransferController.getAuditLogs);

router.post('/initiate', authenticateValet, keyTransferController.initiateTransfer);
router.post('/accept', authenticateValet, keyTransferController.acceptTransfer);
router.post('/reject', authenticateValet, keyTransferController.rejectTransfer);
router.post('/cancel', authenticateValet, keyTransferController.cancelTransfer);

module.exports = router;
