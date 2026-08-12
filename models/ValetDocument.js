const mongoose = require('mongoose');

// ValetDocument — per-document records for contractor onboarding.
//
// Stores driver's license photos (front + back) uploaded by valets at
// onboarding. Certn validates the license itself, so these are stored
// for compliance / sharing with insurance providers — no automated
// review is run against them.
//
// When a new upload of the same type arrives, the previous one is
// marked 'superseded' rather than deleted, so we retain full history.

const ValetDocumentSchema = new mongoose.Schema({
    // Owner
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },

    // Document type
    type: {
        type: String,
        enum: [
            'drivers_license_front',
            'drivers_license_back',
        ],
        required: true,
    },

    // 'stored' on upload, 'superseded' once a newer upload of the
    // same type replaces this one.
    status: {
        type: String,
        enum: ['stored', 'superseded'],
        default: 'stored',
        required: true,
        index: true,
    },

    // S3 storage
    s3Bucket: { type: String, required: true },
    s3Key: { type: String, required: true },
    mimeType: { type: String, required: true },        // 'application/pdf' | 'image/jpeg' | 'image/png'
    fileSize: { type: Number },                         // bytes
    originalFilename: { type: String },                 // for admin reference, not trusted
    uploadedAt: { type: Date, default: Date.now },

}, {
    timestamps: true,    // createdAt + updatedAt (matches Payout.js, Order.js style)
});

// Compound index for the most common query: "give me the current document
// of type X for valet Y". At most one document per (userId, type) should
// be non-superseded at a time — enforced by the upload endpoint logic.
ValetDocumentSchema.index({ userId: 1, type: 1, status: 1 });

module.exports = mongoose.model('ValetDocument', ValetDocumentSchema);
