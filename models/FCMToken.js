const mongoose = require('mongoose');

const FCMTokenSchema = new mongoose.Schema({
    firebaseUid: {
        type: String,
        required: true,
        index: true,
    },
    token: {
        type: String,
        required: true,
        unique: true,
    },
    deviceId: {
        type: String,
    },
    isActive: {
        type: Boolean,
        default: true,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
    lastUsedAt: {
        type: Date,
        default: Date.now,
    },
});

module.exports = mongoose.model('FCMToken', FCMTokenSchema);
