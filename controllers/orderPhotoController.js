/**
 * orderPhotoController
 *
 * Receives valet-captured handoff photos for an order. Two moments per
 * parking order: `pre_pickup` (before OTP key transfer) and `post_park`
 * (before notifying parking complete). The mobile app gates those
 * actions until a photo of the right type has been recorded.
 *
 * Flow:
 *   1. Valet snaps a photo on their phone.
 *   2. Mobile uploads to POST /api/order/:orderId/photos with type +
 *      multipart "file" + optional capturedAt lat/lng.
 *   3. Backend writes the bytes to Firebase Storage under
 *      order-photos/<orderId>/<type>/<ts>-<rand>.jpg, creates an
 *      OrderPhoto record, posts a chat message in the order's
 *      conversation with a signed URL, fires a push to the customer.
 *   4. Returns the photo metadata + signed URL the mobile can render
 *      back as a confirmation thumbnail.
 *
 * Customer + admin retrieval is via GET endpoints (signed URLs minted
 * fresh per request — bucket is private).
 */

const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');

const Order = require('../models/Order');
const OrderPhoto = require('../models/OrderPhoto');
const User = require('../models/User');
const firebaseStorage = require('../services/firebaseStorage');
const { sendPushNotification } = require('./notificationController');

const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/heic'];
const VALID_TYPES = ['pre_pickup', 'post_park'];
const MAX_BYTES = 12 * 1024 * 1024;   // 12 MB — modern iPhone shots fit

// View-URL TTL — 7 days so the customer's chat link doesn't go stale
// before they realistically open the conversation.
const SIGNED_URL_MINUTES = 60 * 24 * 7;

const TYPE_LABELS = {
    pre_pickup: 'Photo before pickup',
    post_park: 'Photo after parking',
};

/**
 * Post a system-style chat message carrying the signed photo URL into the
 * order's conversation, and fire a push to the customer. Failures here
 * are non-fatal — we record the error on the photo doc and return.
 */
const announcePhotoToCustomer = async ({ photo, order, viewUrl, valetId }) => {
    const conversationId = order?.conversationId;
    const label = TYPE_LABELS[photo.type] || 'Photo';
    const updates = {};

    // 1) Chat message in Firestore. Mirror the shape used by the mobile
    // sendParkingNotification helper so existing chat renderers can pick
    // it up without a new code path. Adds photoUrl / photoType / messageType
    // for chat UI that wants to render an image bubble.
    if (conversationId) {
        try {
            const ref = await admin
                .firestore()
                .collection('conversations')
                .doc(conversationId)
                .collection('messages')
                .add({
                    text: `${label} — tap to view`,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    senderId: valetId,
                    messageType: 'photo',
                    photoType: photo.type,
                    photoUrl: viewUrl,
                    containsLink: true,
                    link: viewUrl,
                });
            updates.chatMessageId = ref.id;
        } catch (err) {
            console.error('[orderPhoto] chat post failed:', err.message);
            updates.notificationError = `chat: ${err.message}`;
        }
    }

    // 2) Push to the customer. The customer reference may already be
    // populated; if it's just an ObjectId, look up the User to get the
    // firebaseUid sendPushNotification needs.
    try {
        let firebaseUid = order?.customer?.firebaseUid;
        if (!firebaseUid && order?.customer) {
            const customerId = order.customer._id || order.customer;
            const customer = await User.findById(customerId).select('firebaseUid');
            firebaseUid = customer?.firebaseUid;
        }

        if (firebaseUid) {
            const result = await sendPushNotification(
                firebaseUid,
                'Your valet shared a photo',
                label,
                { orderId: String(order._id), photoType: photo.type }
            );
            if (result?.success) {
                updates.notifiedCustomerAt = new Date();
            } else if (result?.message || result?.error) {
                updates.notificationError = `push: ${result.message || result.error}`;
            }
        }
    } catch (err) {
        console.error('[orderPhoto] push notify failed:', err.message);
        updates.notificationError = `push: ${err.message}`;
    }

    if (Object.keys(updates).length > 0) {
        try {
            await OrderPhoto.findByIdAndUpdate(photo._id, updates);
        } catch (err) {
            console.error('[orderPhoto] failed to persist notify metadata:', err.message);
        }
    }
};

/**
 * Build the Firebase Storage destination for a photo upload.
 */
const buildStoragePath = (orderId, type, mimeType, originalFilename) => {
    const ext = path.extname(originalFilename || '').toLowerCase()
        || (mimeType === 'image/png' ? '.png' : '.jpg');
    const random = crypto.randomBytes(6).toString('hex');
    return `order-photos/${orderId}/${type}/${Date.now()}-${random}${ext}`;
};

/**
 * POST /api/order/:orderId/photos
 * Multipart form: { type, source?, capturedLat?, capturedLng? } + file field "file"
 *
 * Returns: { success, photo: { id, type, source, viewUrl, capturedAt } }
 */
exports.uploadPhoto = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { type, capturedLat, capturedLng, valetId, source } = req.body;
        const file = req.file;

        // Multipart fields arrive as strings, always. The old
        // `typeof capturedLat === 'number'` test could therefore never be
        // true, so no photo ever stored a capture location — the field has
        // been silently empty since it was added. Parse instead.
        const lat = Number.parseFloat(capturedLat);
        const lng = Number.parseFloat(capturedLng);
        const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);

        // Anything that isn't explicitly 'library' is treated as a camera
        // capture — that matches every client that predates the field.
        const photoSource = source === 'library' ? 'library' : 'camera';

        // -- Validation
        if (!orderId || !type || !file || !valetId) {
            return res.status(400).json({
                success: false,
                message: 'orderId, type, valetId, and file are required.',
            });
        }
        if (!VALID_TYPES.includes(type)) {
            return res.status(400).json({
                success: false,
                message: `type must be one of: ${VALID_TYPES.join(', ')}`,
            });
        }
        if (!ACCEPTED_MIME_TYPES.includes((file.mimetype || '').toLowerCase())) {
            return res.status(400).json({
                success: false,
                message: 'Unsupported file type. Accepted: JPEG, PNG, HEIC.',
            });
        }
        if ((file.size || 0) > MAX_BYTES) {
            return res.status(400).json({
                success: false,
                message: `Photo too large. Max ${Math.round(MAX_BYTES / 1024 / 1024)} MB.`,
            });
        }

        const order = await Order.findById(orderId);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

        // Validate the valet posting is the order's assigned valet (or one
        // of the notified valets — for retrieval orders the assigned valet
        // may differ from the notified pool).
        const orderValetId = order.valet?._id?.toString() || order.valet?.toString();
        if (orderValetId && orderValetId !== valetId) {
            return res.status(403).json({
                success: false,
                message: 'Only the assigned valet on this order may upload its photos.',
            });
        }

        // -- Push to Firebase Storage
        const storagePath = buildStoragePath(orderId, type, file.mimetype, file.originalname);
        const { bucket } = await firebaseStorage.uploadFile(
            file.buffer,
            storagePath,
            file.mimetype
        );

        // -- Persist
        const photo = await OrderPhoto.create({
            order: orderId,
            valet: valetId,
            type,
            bucket,
            storagePath,
            mimeType: file.mimetype,
            fileSize: file.size,
            source: photoSource,
            // A library pick has no trustworthy location, so the app sends
            // none. Guard here too rather than trusting the client.
            capturedAtLocation:
                photoSource === 'camera' && hasCoords ? { lat, lng } : undefined,
        });

        // -- Surface a fresh signed URL the mobile can show immediately
        const viewUrl = await firebaseStorage.getSignedUrl(storagePath, SIGNED_URL_MINUTES);

        // Announce to customer (chat + push). Non-blocking from the
        // mobile's perspective — kicks off after we send the response so
        // the camera UI doesn't wait on Firestore + FCM round-trips.
        // We intentionally don't await: announce errors are logged and
        // recorded on the photo doc itself for support visibility.
        announcePhotoToCustomer({ photo, order, viewUrl, valetId })
            .catch((err) =>
                console.error('[orderPhoto] announce error:', err.message)
            );

        return res.json({
            success: true,
            photo: {
                id: photo._id,
                type: photo.type,
                source: photo.source,
                viewUrl,
                capturedAt: photo.capturedAt,
            },
        });
    } catch (err) {
        console.error('uploadPhoto error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Photo upload failed.',
        });
    }
};

/**
 * GET /api/order/:orderId/photos?type=<type>
 *
 * Returns: { success, photos: [{ id, type, viewUrl, capturedAt }] }
 *
 * The mobile app calls this on mount to know whether the required
 * gating photos have already been captured (lets a valet who closed +
 * reopened the app skip re-photographing).
 */
exports.listPhotos = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { type } = req.query;

        const filter = { order: orderId };
        if (type) {
            if (!VALID_TYPES.includes(type)) {
                return res.status(400).json({
                    success: false,
                    message: `type filter must be one of: ${VALID_TYPES.join(', ')}`,
                });
            }
            filter.type = type;
        }

        const photos = await OrderPhoto
            .find(filter)
            .sort({ capturedAt: -1 })
            .lean();

        const withUrls = await Promise.all(
            photos.map(async (p) => ({
                id: p._id,
                type: p.type,
                source: p.source || 'camera',
                viewUrl: await firebaseStorage.getSignedUrl(p.storagePath, SIGNED_URL_MINUTES),
                capturedAt: p.capturedAt,
                capturedAtLocation: p.capturedAtLocation,
                expiresAt: p.expiresAt,
            }))
        );

        return res.json({ success: true, photos: withUrls });
    } catch (err) {
        console.error('listPhotos error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to load photos.',
        });
    }
};

/**
 * Admin: list parking photos across all orders, newest first.
 * Returns one row per order with its pre/post photos attached.
 * Used by the dashboard "Parking photos → Customer" tab.
 *
 * GET /api/admin/parking-photos?limit=&skip=
 */
exports.adminListParkingPhotos = async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const skip = parseInt(req.query.skip, 10) || 0;

        // Get the most recent N distinct orders that have any photos.
        const distinct = await OrderPhoto.aggregate([
            { $sort: { capturedAt: -1 } },
            { $group: { _id: '$order', latestAt: { $first: '$capturedAt' } } },
            { $sort: { latestAt: -1 } },
            { $skip: skip },
            { $limit: limit },
        ]);
        const orderIds = distinct.map((d) => d._id);

        const [orders, photos] = await Promise.all([
            Order.find({ _id: { $in: orderIds } })
                .populate('customer', 'firstName lastName phone')
                .populate('valet', 'firstName lastName phone')
                .lean(),
            OrderPhoto.find({ order: { $in: orderIds } })
                .sort({ capturedAt: -1 })
                .lean(),
        ]);

        const orderById = new Map(orders.map((o) => [o._id.toString(), o]));
        const groupsByOrder = new Map();
        for (const p of photos) {
            const k = p.order.toString();
            if (!groupsByOrder.has(k)) groupsByOrder.set(k, []);
            groupsByOrder.get(k).push(p);
        }

        const rows = await Promise.all(
            orderIds.map(async (id) => {
                const o = orderById.get(id.toString());
                const photosForOrder = groupsByOrder.get(id.toString()) || [];
                const withUrls = await Promise.all(
                    photosForOrder.map(async (p) => ({
                        id: p._id,
                        type: p.type,
                        // Support needs this most of all — it's the tab they
                        // open when a customer disputes damage.
                        source: p.source || 'camera',
                        viewUrl: await firebaseStorage.getSignedUrl(
                            p.storagePath,
                            SIGNED_URL_MINUTES
                        ),
                        capturedAt: p.capturedAt,
                        capturedAtLocation: p.capturedAtLocation,
                        expiresAt: p.expiresAt,
                    }))
                );
                return {
                    orderId: id,
                    customerName:
                        o?.endCustomerName ||
                        `${o?.customer?.firstName || ''} ${o?.customer?.lastName || ''}`.trim(),
                    customerPhone: o?.endCustomerPhone || o?.customer?.phone,
                    valetName: `${o?.valet?.firstName || ''} ${o?.valet?.lastName || ''}`.trim(),
                    orderCreatedAt: o?.createdAt,
                    serviceType: o?.serviceType,
                    photos: withUrls,
                };
            })
        );

        return res.json({ success: true, rows, count: rows.length });
    } catch (err) {
        console.error('adminListParkingPhotos error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to list parking photos.',
        });
    }
};

/**
 * Admin: delete a single OrderPhoto immediately. Hard delete of bytes
 * and DB row. Used by the dashboard "Delete immediately" button.
 *
 * DELETE /api/admin/parking-photo/:id
 */
exports.adminDeletePhoto = async (req, res) => {
    try {
        const { id } = req.params;
        const photo = await OrderPhoto.findById(id);
        if (!photo) {
            return res.status(404).json({ success: false, message: 'Photo not found.' });
        }
        try {
            await firebaseStorage.deleteFile(photo.storagePath);
        } catch (storageErr) {
            // If the bytes are already gone we still want the DB row gone.
            console.warn(
                `adminDeletePhoto: storage delete failed for ${photo.storagePath}: ${storageErr.message}`
            );
        }
        await OrderPhoto.deleteOne({ _id: id });
        return res.json({ success: true });
    } catch (err) {
        console.error('adminDeletePhoto error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to delete photo.',
        });
    }
};
