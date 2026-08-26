const admin = require('firebase-admin');
const axios = require('axios');
const FCMToken = require('../models/FCMToken');
const User = require('../models/User');
const Order = require('../models/Order');
const { REACT_APP_GOOGLE_MAPS_APIKEY } = process.env;

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// Straight-line distance (meters). Fallback proxy for ranking valets when the
// Google Distance Matrix API is unavailable (billing/quota/no route).
const haversineMeters = (a, b) => {
    if (!a || !b) return Number.MAX_SAFE_INTEGER;
    const R = 6371e3;
    const toRad = (d) => ((d || 0) * Math.PI) / 180;
    const dLat = toRad((b.lat || 0) - (a.lat || 0));
    const dLng = toRad((b.lng || 0) - (a.lng || 0));
    const lat1 = toRad(a.lat || 0);
    const lat2 = toRad(b.lat || 0);
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

// Helper function to send Slack notification
const sendSlackNotification = async (title, message, details = {}) => {
    try {
        const environment = process.env.NODE_ENV || 'development';
        const payload = {
            text: `*[${environment.toUpperCase()}] ${title}*\n${message}`,
            attachments: [
                {
                    color: 'good',
                    fields: [
                        {
                            title: 'Environment',
                            value: environment,
                            short: true,
                        },
                        ...Object.entries(details).map(([key, value]) => ({
                            title: key,
                            value: typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value),
                            short: false,
                        })),
                    ],
                    ts: Math.floor(Date.now() / 1000),
                },
            ],
        };

        if (!SLACK_WEBHOOK_URL) {
            console.warn('SLACK_WEBHOOK_URL not set — skipping Slack alert:', title);
            return;
        }
        await axios.post(SLACK_WEBHOOK_URL, payload, { timeout: 5000 });
        console.log('Slack notification sent:', title);
    } catch (err) {
        console.error('Failed to send Slack notification:', err.message);
    }
};

// A push can fail because the recipient's device token is dead — the app was
// reinstalled, the phone was wiped, APNs retired the token. That is a fact
// about their phone, not a fault on our side, and it must never be reported
// as a server error: the caller is a valet mid-handoff whose whole action
// (chat message, arrival flag, key OTP) aborts the moment this throws.
const isDeadTokenError = (error) => {
    const code = error?.code || error?.errorInfo?.code;
    if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
    ) {
        return true;
    }
    // 'invalid-argument' covers both a dead token ("APNs device token is
    // disabled.") and a payload we built wrong. Only the former is theirs.
    const message = error?.message || error?.errorInfo?.message || '';
    return code === 'messaging/invalid-argument' && /token/i.test(message);
};

const buildPushMessage = (token, title, body) => ({
    notification: {
        title,
        body,
    },
    apns: {
        payload: {
            aps: {
                alert: {
                    title,
                    body,
                },
                'mutable-content': 1,
                sound: 'valet-bell.caf',
                badge: 1,
            },
        },
        headers: {
            'apns-priority': '10',
            'apns-push-type': 'alert',
            'apns-topic': 'com.xertifier.firebaseApp', // Make sure this matches your bundle identifier
        },
    },
    token,
});

exports.sendNotification = async (req, res) => {
    const { token, title, body } = req.body;
    console.log('token', token);

    // The app reads this token out of the Firestore user doc, which only holds
    // whichever token was current the last time that doc was written. Mongo's
    // FCMToken collection is the live record, so a stale token here is normal
    // and recoverable — fall back to the owner's other registered devices
    // rather than failing the caller.
    const attempted = [];
    const sendTo = async (candidate) => {
        attempted.push(candidate);
        return admin.messaging().send(buildPushMessage(candidate, title, body));
    };

    try {
        if (!token) {
            // Nothing to send to, but nothing broken either.
            console.warn('Push requested with no token — reporting undelivered');
            return res.status(200).json({
                success: true,
                delivered: false,
                reason: 'no-token-supplied',
            });
        }

        try {
            const response = await sendTo(token);
            console.log('Notification sent successfully:', response);
            return res.status(200).json({
                success: true,
                delivered: true,
                response: response,
            });
        } catch (error) {
            if (!isDeadTokenError(error)) throw error;
            console.warn(
                `Supplied token is dead (${error.code}: ${error.message}) — trying the owner's other devices`
            );
        }

        // Retire the dead token and find who it belonged to.
        const deadTokenDoc = await FCMToken.findOneAndUpdate(
            { token },
            { isActive: false },
            { new: true }
        );

        if (!deadTokenDoc) {
            console.warn('Dead token is not in the FCMToken collection — no fallback possible');
            return res.status(200).json({
                success: true,
                delivered: false,
                reason: 'token-unregistered',
                attempted: attempted.length,
            });
        }

        const fallbacks = await FCMToken.find({
            firebaseUid: deadTokenDoc.firebaseUid,
            isActive: true,
            token: { $ne: token },
        }).sort({ lastUsedAt: -1 });

        for (const candidate of fallbacks) {
            try {
                const response = await sendTo(candidate.token);
                await FCMToken.updateOne(
                    { _id: candidate._id },
                    { lastUsedAt: new Date() }
                );
                console.log(
                    `Notification delivered on fallback token ${candidate.token.substring(0, 20)}...`
                );
                return res.status(200).json({
                    success: true,
                    delivered: true,
                    usedFallbackToken: true,
                    response: response,
                });
            } catch (error) {
                if (!isDeadTokenError(error)) throw error;
                console.warn(
                    `Fallback token ${candidate.token.substring(0, 20)}... is dead too — retiring it`
                );
                await FCMToken.updateOne({ _id: candidate._id }, { isActive: false });
            }
        }

        console.warn(
            `No live device for ${deadTokenDoc.firebaseUid} — ${attempted.length} token(s) tried`
        );
        return res.status(200).json({
            success: true,
            delivered: false,
            reason: 'no-live-device',
            attempted: attempted.length,
        });
    } catch (error) {
        // Genuine server-side fault (Firebase credentials, Mongo, a payload we
        // built wrong) — this one really is a 500.
        console.error('Error sending notification:', error);
        return res.status(500).json({
            success: false,
            error: error.message,
        });
    }
};

exports.notifyClosestValets = async (req, res) => {
    const { orderId } = req.body;

    try {
        // Get the order details
        const order = await Order.findById(orderId).populate('customer');
        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found',
            });
        }

        // Find all active valets
        const activeValets = await User.find({
            isValet: true,
            isActive: true,
            isDeleted: { $ne: true },
        });

        if (activeValets.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No active valets found',
            });
        }

        // Prepare destinations string for Distance Matrix API
        const destinations = activeValets
            .map(
                (valet) =>
                    `${valet.currentLocation?.lat || 0},${
                        valet.currentLocation?.lng || 0
                    }`
            )
            .join('|');

        console.log('destinations', destinations);

        // Get distances from customer to all active valets
        const distanceMatrixResponse = await axios.get(
            'https://maps.googleapis.com/maps/api/distancematrix/json',
            {
                params: {
                    origins: `${order.customerLocation.lat},${order.customerLocation.lng}`,
                    destinations,
                    mode: 'walking',
                    key: REACT_APP_GOOGLE_MAPS_APIKEY,
                },
            }
        );

        console.log('Distance Matrix API response status:', distanceMatrixResponse.data.status);
        
        // Rank valets by distance. Prefer Google walking distance, but if the
        // Distance Matrix API is unavailable (billing off, quota, no route,
        // network) DON'T strand the order — fall back to notifying all active
        // valets ranked by straight-line distance. The old code 404'd here,
        // which meant a Maps outage silently blocked ALL dispatch.
        const dmStatus = distanceMatrixResponse.data?.status;
        const elements =
            dmStatus === 'OK'
                ? distanceMatrixResponse.data?.rows?.[0]?.elements
                : null;

        let closestValets;
        if (Array.isArray(elements)) {
            closestValets = elements
                .map((element, index) => ({
                    valet: activeValets[index],
                    distance: element.distance?.value ?? Infinity,
                }))
                .sort((a, b) => a.distance - b.distance)
                .slice(0, Math.min(5, activeValets.length));
        } else {
            console.warn(
                'notifyClosestValets: Distance Matrix unavailable (',
                dmStatus,
                distanceMatrixResponse.data?.error_message || '',
                ') — falling back to all active valets by straight-line distance'
            );
            closestValets = activeValets
                .map((valet) => ({
                    valet,
                    distance: haversineMeters(
                        order.customerLocation,
                        valet.currentLocation
                    ),
                }))
                .sort((a, b) => a.distance - b.distance)
                .slice(0, Math.min(5, activeValets.length));
        }

        // Ranking keeps only the 5 nearest, which is right for dispatch but wrong
        // for oversight: an owner in Queens watching Brooklyn ops would silently
        // drop off the list as soon as five valets sat closer to the customer.
        // Anyone flagged alwaysNotify is appended regardless of distance, so they
        // see every request even overnight. They are still ranked last, so this
        // never displaces a genuinely close valet.
        const alwaysNotify = activeValets.filter((v) => v.alwaysNotify === true);
        const already = new Set(closestValets.map((c) => String(c.valet._id)));
        for (const valet of alwaysNotify) {
            if (already.has(String(valet._id))) continue;
            closestValets.push({
                valet,
                distance: haversineMeters(order.customerLocation, valet.currentLocation),
            });
            already.add(String(valet._id));
        }

        console.log(
            'closestValets count:', closestValets.length,
            '(alwaysNotify added:', alwaysNotify.length, ')'
        );

        // Prepare notification message
        const customerName = `${order.customer.firstName} ${order.customer.lastName}`;
        const title =
            order.orderType === 'retrieval'
                ? 'New Retrieval Request'
                : 'New Parking Request';
        const body =
            order.orderType === 'retrieval'
                ? `${customerName} needs their car retrieved from ${order.customerLocation.streetAddress}.`
                : `${customerName} needs parking at ${
                      order.customerLocation.streetAddress
                  }. Duration: ${order.duration / 60} hours`;
        // Device tokens live in two places and they DO drift apart: the Mongo
        // FCMToken collection is what the app refreshes and what every other
        // notification path reads, while this one alone read a copy in Firestore.
        // A stale Firestore copy meant a valet kept receiving chat and account
        // pushes while silently getting no job offers — a partial failure that
        // looks like "nobody is taking orders" rather than a broken token.
        // Mongo first, Firestore only as a fallback for anyone not yet migrated.
        const valetTokens = [];
        for (const item of closestValets) {
            const uid = item.valet.firebaseUid;
            if (!uid) continue;

            const mongoTokens = await FCMToken.find({
                firebaseUid: uid,
                isActive: true,
            }).select('token');

            if (mongoTokens.length > 0) {
                mongoTokens.forEach((t) => t.token && valetTokens.push(t.token));
                continue;
            }

            try {
                const userDoc = await admin
                    .firestore()
                    .collection('users')
                    .doc(uid)
                    .get();
                if (userDoc.exists && userDoc.data().fcmToken) {
                    console.warn(
                        `notifyClosestValets: valet ${uid} has no active Mongo token; using the Firestore copy`
                    );
                    valetTokens.push(userDoc.data().fcmToken);
                }
            } catch (err) {
                console.error(`Firestore token lookup failed for ${uid}:`, err.message);
            }
        }

        const uniqueValetTokens = [...new Set(valetTokens)];

        // Create the message
        // Convert data values to strings (FCM requirement)
        const data = {
            orderId: order._id.toString(),
            orderType: order.orderType,
            customerName: `${order.customer.firstName} ${order.customer.lastName}`,
        };
        const stringData = Object.keys(data || {}).reduce((acc, key) => {
            acc[key] = String(data[key]);
            return acc;
        }, {});

        const message = {
            notification: {
                title,
                body,
            },
            data: stringData,
            apns: {
                payload: {
                    aps: {
                        alert: {
                            title,
                            body,
                        },
                        'mutable-content': 1,
                        sound: 'valet-bell.caf',
                        badge: 1,
                    },
                },
                headers: {
                    'apns-priority': '10',
                    'apns-push-type': 'alert',
                    'apns-topic': 'com.xertifier.firebaseApp',
                },
            },
            tokens: uniqueValetTokens,
        };

        // The push is the loudest channel, not the only one, and it must not
        // be able to take dispatch down with it.
        //
        // `sendEachForMulticast` throws outright on an empty token array, and
        // everything that actually puts the job on a valet's screen — the
        // notifiedValets record and the NEW_ORDER_AVAILABLE socket emit — used
        // to sit BELOW this line. So five valets with no active token row
        // between them (a stale token, a fresh install, a reinstall) turned
        // into a 500, an order with an empty notifiedValets, and no socket
        // event: the job existed, was paid for, and nobody was ever told.
        // Both clients swallow a failure here by contract, so it was silent.
        let response = { successCount: 0, failureCount: 0 };
        if (uniqueValetTokens.length === 0) {
            console.warn(
                `notifyClosestValets: none of the ${closestValets.length} nearest valets has an active push token — dispatching over sockets only for order ${orderId}`
            );
        } else {
            try {
                response = await admin.messaging().sendEachForMulticast(message);
                console.log('Notification sent successfully:', response);
            } catch (pushErr) {
                console.error('notifyClosestValets: push send failed:', pushErr.message);
            }
        }

        // Store notified valets data in the order
        const notifiedAt = new Date();
        const notifiedValetsData = closestValets.map(item => ({
            valet: item.valet._id,
            notifiedAt: notifiedAt,
            accepted: false,
        }));

        await Order.findByIdAndUpdate(orderId, {
            $push: { notifiedValets: { $each: notifiedValetsData } }
        });

        console.log(`Stored ${notifiedValetsData.length} notified valets for order ${orderId}`);

        // Send notification details to Slack
        // await sendSlackNotification(
        //     'Notifications Sent to Closest Valets',
        //     `Notifications sent to ${response.successCount} valets for order: ${orderId}`,
        //     {
        //         'Order ID': orderId,
        //         'Success Count': response.successCount,
        //         'Failure Count': response.failureCount,
        //         'Total Valets Notified': uniqueValetTokens.length,
        //         'FCM Tokens': uniqueValetTokens,
        //         'Message Object': message,
        //         'Firebase Response': response,
        //     }
        // );

        // Emit to customer's room. `order.customer` is populated, so
        // `.toString()` on it serialises the whole user document into the room
        // name — a room nobody is in. The customer's own socket joins a room
        // named by their id, so it has to be `._id`.
        req.io.to(order.customer._id.toString()).emit('orderUpdated', {
            type: 'NEW_ORDER',
            order: order,
        });

        // Emit to each valet's room
        closestValets.forEach((item) => {
            req.io.to(item.valet._id.toString()).emit('orderUpdated', {
                type: 'NEW_ORDER_AVAILABLE',
                order: order,
            });
        });

        res.status(200).json({
            success: true,
            message: `Notifications sent to ${response.successCount} valets`,
            notifiedValets: closestValets.map((item) => item.valet._id),
            response: response,
        });
    } catch (error) {
        console.error('Error in notifyClosestValets:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to notify valets',
            error: error.message,
        });
    }
};

// Helper function to send push notification to a single user
exports.sendPushNotification = async (
    firebaseUid,
    title,
    body,
    data = {},
    directFcmToken = null,
    sound = null
) => {
    // Bundled as ios/ValetNYC/valet-bell.caf. iOS falls back to silence if the
    // file is missing from the bundle, so the two ship together.
    const soundName = sound || 'valet-bell.caf';
    try {
        console.log('sendPushNotification called with firebaseUid:', firebaseUid, 'directFcmToken:', directFcmToken ? 'provided' : 'not provided');
        
        let fcmTokens = [];

        // If direct FCM token is provided, use it directly
        if (directFcmToken) {
            console.log('Using provided FCM token directly');
            fcmTokens = [{ token: directFcmToken, _id: 'direct_token', deviceId: 'direct' }];
        } else {
            // Get all active FCM tokens for the user
            fcmTokens = await FCMToken.find({
                firebaseUid,
                isActive: true,
            });

            if (!fcmTokens || fcmTokens.length === 0) {
                console.error('No active FCM tokens found for user:', firebaseUid);
                return { success: false, message: 'No valid FCM tokens found' };
            }

            console.log(`Found ${fcmTokens.length} active token(s) for user: ${firebaseUid}`);
        }

        // Convert data values to strings (FCM requirement)
        const stringData = Object.keys(data).reduce((acc, key) => {
            acc[key] = String(data[key]);
            return acc;
        }, {});

        let successCount = 0;
        let failureCount = 0;
        const failedTokens = [];

        // Send to each active token
        for (const fcmTokenDoc of fcmTokens) {
            try {
                const message = {
                    notification: {
                        title,
                        body,
                    },
                    data: stringData,
                    apns: {
                        payload: {
                            aps: {
                                alert: {
                                    title,
                                    body,
                                },
                                'mutable-content': 1,
                                sound: soundName,
                                badge: 1,
                            },
                        },
                        headers: {
                            'apns-priority': '10',
                            'apns-push-type': 'alert',
                            'apns-topic': 'com.xertifier.firebaseApp',
                        },
                    },
                    token: fcmTokenDoc.token,
                };

                const response = await admin.messaging().send(message);
                console.log(`Push notification sent to token: ${fcmTokenDoc.token.substring(0, 20)}...`);
                
                // Only update database if this is not a direct token
                if (fcmTokenDoc._id !== 'direct_token') {
                    // Update lastUsedAt
                    await FCMToken.updateOne(
                        { _id: fcmTokenDoc._id },
                        { lastUsedAt: new Date() }
                    );

                    // Send success notification to Slack
                    // await sendSlackNotification(
                    //     'Push Notification Sent Successfully',
                    //     `Push notification sent to user: ${firebaseUid}`,
                    //     {
                    //         'Firebase UID': firebaseUid,
                    //         'FCM Token': fcmTokenDoc.token,
                    //         'Device ID': fcmTokenDoc.deviceId,
                    //         'Notification Title': title,
                    //         'Notification Body': body,
                    //         'Message Object': message,
                    //         'Firebase Response': response,
                    //     }
                    // );
                } else {
                    console.log('Direct FCM token used - skipping database update');
                }

                successCount++;
            } catch (error) {
                console.error(`Failed to send to token ${fcmTokenDoc.token.substring(0, 20)}...`, error.message);
                failureCount++;
                failedTokens.push(fcmTokenDoc.token);

                // Mark token as inactive if it's an invalid token error (only for database tokens)
                if (fcmTokenDoc._id !== 'direct_token' && 
                    (error.code === 'messaging/invalid-registration-token' || 
                    error.code === 'messaging/registration-token-not-registered')) {
                    console.log(`Marking token as inactive: ${fcmTokenDoc.token.substring(0, 20)}...`);
                    await FCMToken.updateOne(
                        { _id: fcmTokenDoc._id },
                        { isActive: false }
                    );
                }
            }
        }

        console.log(`Notification send summary - Success: ${successCount}, Failure: ${failureCount}`);

        if (successCount === 0) {
            return { success: false, message: 'Failed to send to all tokens', failedTokens };
        }

        return { success: true, successCount, failureCount, failedTokens };
    } catch (error) {
        console.error('Error sending push notification:', error.message, error.code);
        return { success: false, error: error.message };
    }
};

exports.sendUserNotification = async (req, res) => {
    const { recipientId, title, body, data } = req.body;
    const senderId = req.user?.id;

    try {
        if (!recipientId) {
            return res.status(400).json({
                success: false,
                message: 'Recipient ID is required',
            });
        }

        if (!title || !body) {
            return res.status(400).json({
                success: false,
                message: 'Title and body are required',
            });
        }

        // Get recipient user
        const recipient = await User.findById(recipientId);
        if (!recipient) {
            return res.status(404).json({
                success: false,
                message: 'Recipient not found',
            });
        }

        // Get recipient's FCM token from Firestore
        let userDoc;
        try {
            userDoc = await admin
                .firestore()
                .collection('users')
                .doc(recipient.firebaseUid)
                .get();
        } catch (firestoreError) {
            console.error('Firestore error:', firestoreError);
            return res.status(500).json({
                success: false,
                message: 'Failed to retrieve FCM token',
                error: firestoreError.message,
            });
        }

        if (!userDoc.exists || !userDoc.data().fcmToken) {
            return res.status(400).json({
                success: false,
                message: 'Recipient does not have a valid FCM token',
            });
        }

        const fcmToken = userDoc.data().fcmToken;

        console.log('Sending notification to FCM token:', fcmToken);

        // Check Firebase app initialization
        try {
            const app = admin.app();
            console.log('Firebase app is initialized:', app.name);
            
            // Log credential details
            const credential = app.options.credential;
            console.log('Credential type:', credential?.constructor?.name);
            console.log('Project ID from options:', app.options.projectId);
            
            // Try to get access token to verify credentials work
            try {
                const token = await credential.getAccessToken();
                console.log('Access token obtained successfully, expires in:', token.expires_in, 'seconds');
            } catch (tokenError) {
                console.error('Failed to get access token:', tokenError.message);
            }
        } catch (appError) {
            console.error('Firebase app not initialized:', appError.message);
            return res.status(500).json({
                success: false,
                message: 'Firebase not properly initialized',
                error: appError.message,
            });
        }

        // Prepare message
        const message = {
            notification: {
                title,
                body,
            },
            data: data || {},
            token: fcmToken,
        };

        // Send notification
        console.log('Attempting to send message via Firebase Messaging API');
        
        // Try using REST API as fallback if admin.messaging() fails
        let response;
        let sentSuccessfully = false;
        
        // Try Admin SDK first
        try {
            response = await admin.messaging().send(message);
            console.log('Notification sent successfully via Admin SDK:', response);
            sentSuccessfully = true;
        } catch (adminError) {
            console.warn('Admin SDK messaging failed, trying REST API:', adminError.message);
            
            // Fallback: Use REST API directly
            try {
                const accessToken = await admin.app().options.credential.getAccessToken();
                const axios = require('axios');
                
                console.log('Using REST API with token:', accessToken.access_token.substring(0, 20) + '...');
                
                const restResponse = await axios.post(
                    `https://fcm.googleapis.com/v1/projects/valet-nyc-dev/messages:send`,
                    {
                        message: {
                            token: fcmToken,
                            notification: {
                                title,
                                body,
                            },
                            data: data || {},
                        },
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${accessToken.access_token}`,
                            'Content-Type': 'application/json',
                        },
                    }
                );
                
                response = restResponse.data;
                console.log('Notification sent successfully via REST API:', response);
                sentSuccessfully = true;
            } catch (restError) {
                console.error('REST API also failed:', restError.response?.data || restError.message);
                throw new Error(`Both Admin SDK and REST API failed. REST API error: ${restError.response?.data?.error?.message || restError.message}`);
            }
        }
        
        if (sentSuccessfully) {
            res.status(200).json({
                success: true,
                message: 'Notification sent successfully',
                response: response,
            });
        }
    } catch (error) {
        console.error('Error sending user notification:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to send notification',
            error: error.message,
        });
    }
};
