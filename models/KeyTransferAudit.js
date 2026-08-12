const mongoose = require('mongoose');

const KeyTransferAuditSchema = new mongoose.Schema({
    transferId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'KeyTransfer',
        required: true,
    },
    senderValet: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    receiverValet: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    keyCount: {
        type: Number,
        required: true,
    },
    keyTags: [{
        type: Number,
    }],
    action: {
        type: String,
        enum: ['initiated', 'accepted', 'rejected', 'cancelled'],
        required: true,
    },
    status: {
        type: String,
        enum: ['pending_acceptance', 'accepted', 'rejected', 'cancelled'],
    },
    reason: String,
    timestamp: {
        type: Date,
        default: Date.now,
    },
    ipAddress: String,
    userAgent: String,
}, {
    timestamps: false,
});

module.exports = mongoose.model('KeyTransferAudit', KeyTransferAuditSchema);
