const mongoose = require('mongoose');

const KeyTransferSchema = new mongoose.Schema({
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
    keys: [{
        keyTagNumberold: {
            type: Number,
            required: true,
            min: 1,
            max: 200,
        },
        orderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Order',
            required: true,
        },
        vehicle: {
            make: String,
            model: String,
            color: String,
            licensePlate: String,
            keyTagNumber: String,
        },
        parkingLocation: String,
    }],
    status: {
        type: String,
        enum: ['pending_acceptance', 'accepted', 'rejected', 'cancelled'],
        default: 'pending_acceptance',
    },
    rejectionReason: {
        type: String,
    },
    cancelledReason: {
        type: String,
    },
    receiverConfirmedKeyTags: [{
        type: Number,
    }],
    createdAt: {
        type: Date,
        default: Date.now,
    },
    acceptedAt: {
        type: Date,
    },
    rejectedAt: {
        type: Date,
    },
    cancelledAt: {
        type: Date,
    },
}, {
    timestamps: true,
});

module.exports = mongoose.model('KeyTransfer', KeyTransferSchema);
