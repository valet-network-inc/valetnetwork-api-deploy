const express = require('express');
const router = express.Router();
const { sendNotification, notifyClosestValets, sendUserNotification, sendPushNotification } = require('../controllers/notificationController');
const requireAdminKey = require('../middleware/requireAdminKey');

router.post('/send', sendNotification);
router.post('/notify-closest-valets', notifyClosestValets);
router.post('/send-user', sendUserNotification);
// A raw "push anything to anybody" primitive: it takes a firebaseUid or an FCM
// token straight from the body along with the title and body to show. Nothing
// in either client calls it — verified by grep across both repos — so it was
// an open relay for sending our own branded notifications to our own
// customers. Behind the admin key it stays available as an ops tool and stops
// being that.
router.post('/send-push', requireAdminKey, async (req, res) => {
    try {
        const { firebaseUid, fcmToken, title, body, data } = req.body;
        
        if (!title || !body) {
            return res.status(400).json({
                success: false,
                message: 'title and body are required',
            });
        }

        let result;

        // If firebaseUid is provided, use sendPushNotification to fetch FCM tokens from DB
        if (firebaseUid) {
            console.log('Sending push notification using firebaseUid:', firebaseUid);
            result = await sendPushNotification(firebaseUid, title, body, data);
        } 
        // If fcmToken is provided directly, create a temporary firebaseUid entry for sendPushNotification
        else if (fcmToken) {
            console.log('Sending push notification using provided fcmToken');
            // Use sendPushNotification with a special marker for direct token usage
            result = await sendPushNotification(null, title, body, data, fcmToken);
        } 
        // Neither firebaseUid nor fcmToken provided
        else {
            return res.status(400).json({
                success: false,
                message: 'Either firebaseUid or fcmToken is required',
            });
        }

        if (result.success) {
            return res.status(200).json(result);
        } else {
            return res.status(400).json(result);
        }
    } catch (error) {
        console.error('Error in send-push route:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send push notification',
            error: error.message,
        });
    }
});

module.exports = router;
