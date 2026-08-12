const mongoose = require('mongoose');

/**
 * OrderPhoto — photos a valet captures at handoff moments during an order.
 *
 * Two enforced capture moments per parking order:
 *   1. `pre_pickup`  — taken before the OTP key transfer at the start.
 *                      Documents the car's condition the moment the
 *                      valet takes possession.
 *   2. `post_park`   — taken after the car is parked, before the valet
 *                      taps "notify parking complete". Documents where
 *                      the car ended up + its condition then.
 *
 * Stored in Firebase Storage at:
 *   order-photos/<orderId>/<type>/<timestamp>-<random>.jpg
 *
 * On upload, a chat message gets posted into the order's conversation
 * with a signed URL the customer can tap to view + save. Customer also
 * gets a push notification.
 *
 * Retention: hard 30-day expiry per the v1.2.0 privacy policy. The
 * nightly cron at services/parkingPhotoExpiry.js sweeps anything past
 * `expiresAt` and deletes the bytes from Firebase Storage and the row
 * from Mongo. Admin can early-delete via DELETE /api/admin/parking-photo/:id.
 */

const OrderPhotoSchema = new mongoose.Schema({
    order: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Order',
        required: true,
        index: true,
    },
    valet: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },

    // Which handoff moment this photo represents
    type: {
        type: String,
        enum: ['pre_pickup', 'post_park'],
        required: true,
    },

    // Storage location in Firebase
    bucket: { type: String, required: true },
    storagePath: { type: String, required: true },     // path inside the bucket
    mimeType: { type: String, required: true },        // 'image/jpeg' typically
    fileSize: { type: Number },                         // bytes

    // Captured server-side metadata for support / audit
    capturedAt: { type: Date, default: Date.now },
    capturedAtLocation: {
        lat: { type: Number },
        lng: { type: Number },
    },

    // Hard expiry timestamp. Set at create time to capturedAt + 30 days.
    // The expiry cron deletes the storage bytes + this row when Date.now()
    // crosses this. Indexed so the cron sweep is a fast range query.
    expiresAt: {
        type: Date,
        default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        index: true,
    },

    // Whether the chat message + push notification fired successfully
    chatMessageId: { type: String },                    // ID of the chat message that delivered this photo
    notifiedCustomerAt: { type: Date },
    notificationError: { type: String },                // populated only if the customer-notify step fails

}, {
    timestamps: true,
});

// Compound index for the most common query: "give me all photos of type X
// for order Y". Used by the mobile app to know whether the gating photos
// have been captured (so it can unblock the OTP / notify buttons).
OrderPhotoSchema.index({ order: 1, type: 1 });

module.exports = mongoose.model('OrderPhoto', OrderPhotoSchema);
