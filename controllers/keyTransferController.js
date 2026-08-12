const KeyTransfer = require('../models/KeyTransfer');
const KeyTransferAudit = require('../models/KeyTransferAudit');
const Order = require('../models/Order');
const User = require('../models/User');
const admin = require('firebase-admin');
const { sendPushNotification } = require('./notificationController');

const keyTransferController = {
    getMyKeys: async (req, res) => {
        try {
            const valetId = req.user.id;

            const orders = await Order.find({
                valet: valetId,
                status: { $in: ['parked'] },
            }).select('vehicle licensePlate parkingLocation keyTagNumberold');

            const pendingTransfers = await KeyTransfer.find({
                senderValet: valetId,
                status: 'pending_acceptance',
            });

            const outgoingKeyMap = new Map();
            pendingTransfers.forEach((transfer) => {
                transfer.keys.forEach((key) => {
                    outgoingKeyMap.set(key.orderId.toString(), {
                        transferId: transfer._id.toString(),
                        status: transfer.status,
                    });
                });
            });

            const keysWithStatus = orders.map((order, index) => {
                const outgoingInfo = outgoingKeyMap.get(order._id.toString());
                const status = outgoingInfo?.status || 'available';

                return {
                    keyTagNumberold: index + 1,
                    orderId: order._id,
                    // vehicle: {
                    //     make: order.vehicle?.model?.split(' ')[0] || 'Unknown',
                    //     model: order.vehicle?.model || 'Unknown',
                    //     color: order.vehicle?.color || 'Unknown',
                    //     licensePlate: order.vehicle?.licensePlate || 'N/A',
                    // },
                    vehicle: order.vehicle,
                    parkingLocation: order.parkingLocation?.streetAddress || 'Unknown',
                    status,
                    disabled: status !== 'available',
                    transferId: outgoingInfo?.transferId || null,
                };
            });

            res.status(200).json({
                success: true,
                data: keysWithStatus,
                count: keysWithStatus.length,
            });
        } catch (error) {
            console.error('Error fetching my keys:', error);
            res.status(500).json({
                success: false,
                message: 'Unable to fetch keys',
                error: error.message,
            });
        }
    },

    getOutgoingTransfers: async (req, res) => {
        try {
            const valetId = req.user.id;

            const transfers = await KeyTransfer.find({
                senderValet: valetId,
            })
                .populate('receiverValet', 'firstName lastName phone')
                .sort({ createdAt: -1 });

            const formattedTransfers = transfers.map(transfer => ({
                _id: transfer._id,
                receiverValet: {
                    _id: transfer.receiverValet._id,
                    name: `${transfer.receiverValet.firstName} ${transfer.receiverValet.lastName}`,
                    phone: transfer.receiverValet.phone,
                },
                keys: transfer.keys,
                status: transfer.status,
                createdAt: transfer.createdAt,
                canCancel: transfer.status === 'pending_acceptance',
            }));

            res.status(200).json({
                success: true,
                data: formattedTransfers,
                count: formattedTransfers.length,
            });
        } catch (error) {
            console.error('Error fetching outgoing transfers:', error);
            res.status(500).json({
                success: false,
                message: 'Unable to fetch outgoing transfers',
                error: error.message,
            });
        }
    },

    getIncomingTransfers: async (req, res) => {
        try {
            const valetId = req.user.id;

            const transfers = await KeyTransfer.find({
                receiverValet: valetId,
            })
                .populate('senderValet', 'firstName lastName phone')
                .sort({ createdAt: -1 });

            const formattedTransfers = transfers.map(transfer => ({
                _id: transfer._id,
                senderValet: {
                    _id: transfer.senderValet._id,
                    name: `${transfer.senderValet.firstName} ${transfer.senderValet.lastName}`,
                    phone: transfer.senderValet.phone,
                },
                keys: transfer.keys,
                status: transfer.status,
                createdAt: transfer.createdAt,
                canRespond: transfer.status === 'pending_acceptance',
            }));

            res.status(200).json({
                success: true,
                data: formattedTransfers,
                count: formattedTransfers.length,
            });
        } catch (error) {
            console.error('Error fetching incoming transfers:', error);
            res.status(500).json({
                success: false,
                message: 'Unable to fetch incoming transfers',
                error: error.message,
            });
        }
    },

    initiateTransfer: async (req, res) => {
        try {
            const senderValetId = req.user.id;
            const { receiverValetId, keyOrderIds } = req.body;

            if (!keyOrderIds || keyOrderIds.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Please select at least one key to transfer.',
                });
            }

            const receiverValet = await User.findById(receiverValetId);
            if (!receiverValet || !receiverValet.isActive) {
                return res.status(400).json({
                    success: false,
                    message: 'Selected valet is currently unavailable.',
                });
            }

            // Check for existing pending transfers for any of the selected orders
            const existingTransfers = await KeyTransfer.find({
                'keys.orderId': { $in: keyOrderIds },
                status: 'pending_acceptance'
            });

            if (existingTransfers.length > 0) {
                const duplicateOrderIds = existingTransfers.flatMap(t => t.keys.map(k => k.orderId.toString()));
                return res.status(400).json({
                    success: false,
                    message: 'One or more selected keys already have a pending transfer request.',
                    duplicateOrderIds: duplicateOrderIds,
                });
            }

            const orders = await Order.find({
                _id: { $in: keyOrderIds },
                valet: senderValetId,
                status: { $in: ['parked'] },
            });

            if (orders.length !== keyOrderIds.length) {
                return res.status(400).json({
                    success: false,
                    message: 'One or more selected keys are no longer available.',
                });
            }

            const keys = orders.map((order, index) => ({
                keyTagNumberold: index + 1,
                orderId: order._id,
                // vehicle: {
                //     make: order.vehicle?.model?.split(' ')[0] || 'Unknown',
                //     model: order.vehicle?.model || 'Unknown',
                //     color: order.vehicle?.color || 'Unknown',
                //     licensePlate: order.vehicle?.licensePlate || 'N/A',
                // },
                vehicle: order.vehicle,
                parkingLocation: order.parkingLocation?.streetAddress || 'Unknown',
            }));

            const transfer = new KeyTransfer({
                senderValet: senderValetId,
                receiverValet: receiverValetId,
                keys: keys,
                status: 'pending_acceptance',
            });

            await transfer.save();

            const keyTags = keys.map(k => k.keyTagNumberold);
            await logAuditTrail(
                transfer._id,
                senderValetId,
                receiverValetId,
                keys.length,
                keyTags,
                'initiated',
                'pending_acceptance',
                null,
                req
            );

            const senderValet = await User.findById(senderValetId);
            const senderName = `${senderValet.firstName} ${senderValet.lastName}`;

            const currentTime = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
            await sendPushNotification(
                receiverValet.firebaseUid,
                `Key transfer request from ${senderName}`,
                `${keys.length} key(s) to transfer at ${currentTime}`,
                {
                    type: 'key_transfer_request',
                    transferId: transfer._id.toString(),
                    screen_name: 'KeyTransferScreen',
                    index: 2,
                }
            );

            // Emit socket events
            req.io.to(receiverValetId.toString()).emit('keyTransferRequest', { transferId: transfer._id.toString() });

            res.status(201).json({
                success: true,
                message: 'Transfer request created successfully',
                data: transfer,
            });
        } catch (error) {
            console.error('Error initiating transfer:', error);
            res.status(500).json({
                success: false,
                message: 'Unable to initiate transfer',
                error: error.message,
            });
        }
    },

    acceptTransfer: async (req, res) => {
        try {
            const receiverValetId = req.user.id;
            const { transferId, confirmedKeyTags } = req.body;

            const transfer = await KeyTransfer.findById(transferId);
            if (!transfer) {
                return res.status(404).json({
                    success: false,
                    message: 'Transfer request not found',
                });
            }

            if (transfer.receiverValet.toString() !== receiverValetId) {
                return res.status(403).json({
                    success: false,
                    message: 'Unauthorized to accept this transfer',
                });
            }

            if (transfer.status !== 'pending_acceptance') {
                return res.status(400).json({
                    success: false,
                    message: 'Transfer request is no longer pending',
                });
            }

            if (!confirmedKeyTags || confirmedKeyTags.length !== transfer.keys.length) {
                return res.status(400).json({
                    success: false,
                    message: 'All key tags must be confirmed for acceptance',
                });
            }

            transfer.status = 'accepted';
            transfer.receiverConfirmedKeyTags = confirmedKeyTags;
            transfer.acceptedAt = new Date();
            await transfer.save();

            const keyTags = transfer.keys.map(k => k.keyTagNumberold);
            await logAuditTrail(
                transfer._id,
                transfer.senderValet,
                receiverValetId,
                transfer.keys.length,
                keyTags,
                'accepted',
                'accepted',
                null,
                req
            );

            await Order.updateMany(
                { _id: { $in: transfer.keys.map(k => k.orderId) } },
                { valet: receiverValetId }
            );

            const senderValet = await User.findById(transfer.senderValet);
            const receiverValet = await User.findById(receiverValetId);
            const receiverName = `${receiverValet.firstName} ${receiverValet.lastName}`;

            const currentTime = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
            await sendPushNotification(
                senderValet.firebaseUid,
                'Key transfer accepted',
                `${receiverName} accepted your key transfer request at ${currentTime}`,
                {
                    type: 'key_transfer_accepted',
                    transferId: transfer._id.toString(),
                    screen_name: 'KeyTransferScreen',
                    index: 2,
                }
            );

            // Emit socket events
            req.io.to(transfer.senderValet.toString()).emit('keyTransferAcceptedNotification', { transferId: transfer._id.toString() });
            req.io.to(receiverValetId.toString()).emit('keyTransferAccepted', { transferId: transfer._id.toString() });

            res.status(200).json({
                success: true,
                message: 'Transfer accepted successfully',
                data: transfer,
            });
        } catch (error) {
            console.error('Error accepting transfer:', error);
            res.status(500).json({
                success: false,
                message: 'Unable to accept transfer',
                error: error.message,
            });
        }
    },

    rejectTransfer: async (req, res) => {
        try {
            const receiverValetId = req.user.id;
            const { transferId, rejectionReason } = req.body;

            const transfer = await KeyTransfer.findById(transferId);
            if (!transfer) {
                return res.status(404).json({
                    success: false,
                    message: 'Transfer request not found',
                });
            }

            if (transfer.receiverValet.toString() !== receiverValetId) {
                return res.status(403).json({
                    success: false,
                    message: 'Unauthorized to reject this transfer',
                });
            }

            if (transfer.status !== 'pending_acceptance') {
                return res.status(400).json({
                    success: false,
                    message: 'Transfer request is no longer pending',
                });
            }

            transfer.status = 'rejected';
            transfer.rejectionReason = rejectionReason || 'No reason provided';
            transfer.rejectedAt = new Date();
            await transfer.save();

            const keyTags = transfer.keys.map(k => k.keyTagNumberold);
            await logAuditTrail(
                transfer._id,
                transfer.senderValet,
                receiverValetId,
                transfer.keys.length,
                keyTags,
                'rejected',
                'rejected',
                rejectionReason || 'No reason provided',
                req
            );

            const senderValet = await User.findById(transfer.senderValet);
            const receiverValet = await User.findById(receiverValetId);
            const receiverName = `${receiverValet.firstName} ${receiverValet.lastName}`;

            const currentTime = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
            await sendPushNotification(
                senderValet.firebaseUid,
                'Key transfer rejected',
                `${receiverName} rejected your key transfer request at ${currentTime}`,
                {
                    type: 'key_transfer_rejected',
                    transferId: transfer._id.toString(),
                    screen_name: 'KeyTransferScreen',
                    index: 2,
                }
            );

            // Emit socket events
            req.io.to(transfer.senderValet.toString()).emit('keyTransferRejectedNotification', { transferId: transfer._id.toString() });
            req.io.to(receiverValetId.toString()).emit('keyTransferRejected', { transferId: transfer._id.toString() });

            res.status(200).json({
                success: true,
                message: 'Transfer rejected successfully',
                data: transfer,
            });
        } catch (error) {
            console.error('Error rejecting transfer:', error);
            res.status(500).json({
                success: false,
                message: 'Unable to reject transfer',
                error: error.message,
            });
        }
    },

    cancelTransfer: async (req, res) => {
        try {
            const senderValetId = req.user.id;
            const { transferId, cancelReason } = req.body;

            const transfer = await KeyTransfer.findById(transferId);
            if (!transfer) {
                return res.status(404).json({
                    success: false,
                    message: 'Transfer request not found',
                });
            }

            if (transfer.senderValet.toString() !== senderValetId) {
                return res.status(403).json({
                    success: false,
                    message: 'Unauthorized to cancel this transfer',
                });
            }

            if (transfer.status !== 'pending_acceptance') {
                return res.status(400).json({
                    success: false,
                    message: 'Can only cancel transfers with pending acceptance status',
                });
            }

            transfer.status = 'cancelled';
            transfer.cancelledReason = cancelReason || 'No reason provided';
            transfer.cancelledAt = new Date();
            await transfer.save();

            const keyTags = transfer.keys.map(k => k.keyTagNumberold);
            await logAuditTrail(
                transfer._id,
                senderValetId,
                transfer.receiverValet,
                transfer.keys.length,
                keyTags,
                'cancelled',
                'cancelled',
                cancelReason || 'No reason provided',
                req
            );

            const senderValet = await User.findById(senderValetId);
            const receiverValet = await User.findById(transfer.receiverValet);
            const senderName = `${senderValet.firstName} ${senderValet.lastName}`;

            const currentTime = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
            await sendPushNotification(
                receiverValet.firebaseUid,
                'Key transfer cancelled',
                `${senderName} cancelled the key transfer request at ${currentTime}`,
                {
                    type: 'key_transfer_cancelled',
                    transferId: transfer._id.toString(),
                    screen_name: 'KeyTransferScreen',
                    index: 2,
                }
            );

            // Emit socket events
            req.io.to(transfer.receiverValet.toString()).emit('keyTransferCancelledNotification', { transferId: transfer._id.toString() });
            req.io.to(senderValetId.toString()).emit('keyTransferCancelled', { transferId: transfer._id.toString() });

            res.status(200).json({
                success: true,
                message: 'Transfer cancelled successfully',
                data: transfer,
            });
        } catch (error) {
            console.error('Error cancelling transfer:', error);
            res.status(500).json({
                success: false,
                message: 'Unable to cancel transfer',
                error: error.message,
            });
        }
    },

    getActiveValets: async (req, res) => {
        try {
            const currentValetId = req.user.id;

            const activeValets = await User.find({
                _id: { $ne: currentValetId },
                isValet: true,
                isActive: true,
            }).select('firstName lastName phone profileImage');

            res.status(200).json({
                success: true,
                data: activeValets,
                count: activeValets.length,
            });
        } catch (error) {
            console.error('Error fetching active valets:', error);
            res.status(500).json({
                success: false,
                message: 'Unable to fetch active valets',
                error: error.message,
            });
        }
    },

    getAuditLogs: async (req, res) => {
        try {
            const { transferId, senderValetId, receiverValetId, action, limit = 100, skip = 0 } = req.query;

            const filter = {};
            if (transferId) filter.transferId = transferId;
            if (senderValetId) filter.senderValet = senderValetId;
            if (receiverValetId) filter.receiverValet = receiverValetId;
            if (action) filter.action = action;

            const auditLogs = await KeyTransferAudit.find(filter)
                .populate('senderValet', 'firstName lastName phone')
                .populate('receiverValet', 'firstName lastName phone')
                .sort({ timestamp: -1 })
                .limit(parseInt(limit))
                .skip(parseInt(skip));

            const total = await KeyTransferAudit.countDocuments(filter);

            res.status(200).json({
                success: true,
                data: auditLogs,
                pagination: {
                    total,
                    limit: parseInt(limit),
                    skip: parseInt(skip),
                    hasMore: skip + limit < total,
                },
            });
        } catch (error) {
            console.error('Error fetching audit logs:', error);
            res.status(500).json({
                success: false,
                message: 'Unable to fetch audit logs',
                error: error.message,
            });
        }
    },
};

// const sendPushNotification = async (firebaseUid, title, body, data = {}) => {
//     try {
//         if (!firebaseUid) {
//             console.warn('No Firebase UID provided for push notification');
//             return;
//         }

//         // Retrieve FCM token from Firestore using firebaseUid
//         let fcmToken;
//         try {
//             const userDoc = await admin
//                 .firestore()
//                 .collection('users')
//                 .doc(firebaseUid)
//                 .get();

//             if (!userDoc.exists || !userDoc.data().fcmToken) {
//                 console.warn('No FCM token found for Firebase UID:', firebaseUid);
//                 return;
//             }

//             fcmToken = userDoc.data().fcmToken;
//             console.log('Retrieved FCM token for Firebase UID:', firebaseUid);
//         } catch (firestoreError) {
//             console.error('Error retrieving FCM token from Firestore:', firestoreError.message);
//             return;
//         }

//         const message = {
//             notification: {
//                 title: title,
//                 body: body,
//             },
//             data: data,
//             token: fcmToken,
//             webpush: {
//                 notification: {
//                     title: title,
//                     body: body,
//                     icon: '/icon-192x192.png',
//                 },
//             },
//         };

//         await admin.messaging().send(message);
//         console.log('Push notification sent successfully to Firebase UID:', firebaseUid);
//     } catch (error) {
//         console.error('Error sending push notification:', error);
//     }
// };

const logAuditTrail = async (transferId, senderValetId, receiverValetId, keyCount, keyTags, action, status, reason = null, req = null) => {
    try {
        const auditEntry = new KeyTransferAudit({
            transferId,
            senderValet: senderValetId,
            receiverValet: receiverValetId,
            keyCount,
            keyTags,
            action,
            status,
            reason,
            ipAddress: req?.ip || 'unknown',
            userAgent: req?.get('user-agent') || 'unknown',
        });

        await auditEntry.save();
        console.log('Audit trail logged successfully');
    } catch (error) {
        console.error('Error logging audit trail:', error);
    }
};

module.exports = keyTransferController;
