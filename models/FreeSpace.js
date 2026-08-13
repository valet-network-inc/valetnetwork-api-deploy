const mongoose = require('mongoose');

const FreeSpaceSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    // Legacy ML street-segment id. Optional since the pin redesign —
    // pins are pure locations and don't need the Manhattan-only grid.
    segmentId: {
        type: String,
        default: ''
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
        default: Date.now
    }
});

FreeSpaceSchema.index({ userId: 1, createdAt: -1 });
// Pins are only listed for 30 minutes; hard-delete the rows after a day
// so the collection doesn't grow forever. This is the only createdAt
// index — a second one with the same {createdAt: 1} pattern but no TTL
// (the old field-level `index: true`) makes Mongo reject this one with
// IndexOptionsConflict. db.js drops the legacy index on boot.
FreeSpaceSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });

module.exports = mongoose.model('FreeSpace', FreeSpaceSchema);
