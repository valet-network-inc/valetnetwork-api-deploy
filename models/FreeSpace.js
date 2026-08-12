const mongoose = require('mongoose');

const FreeSpaceSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    segmentId: {
        type: String,
        required: true
    },
    latitude: {
        type: Number,
        required: true
    },
    longitude: {
        type: Number,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    }
});

FreeSpaceSchema.index({ createdAt: -1 });
FreeSpaceSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('FreeSpace', FreeSpaceSchema);
