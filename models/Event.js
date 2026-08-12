const mongoose = require('mongoose');

const EventSchema = new mongoose.Schema({
    code: {
        type: String,
        unique: true,
        required: true,
        uppercase: true,
        trim: true
    },
    name: {
        type: String,
        required: true
    },
    type: {
        type: String,
        enum: ['temporary', 'enterprise'],
        required: true
    },
    validFrom: {
        type: Date,
        required: true
    },
    validUntil: {
        type: Date,
        required: true
    },
    maxUses: {
        type: Number,
        default: null // null means unlimited
    },
    currentUses: {
        type: Number,
        default: 0
    },
    isActive: {
        type: Boolean,
        default: true
    },
    // Restricts redemption to specific customers by phone number. Empty means
    // anyone may redeem, which is the behaviour every venue/event code relies on.
    // Used for codes issued to named individuals, e.g. an outage make-good.
    allowedPhones: {
        type: [String],
        default: []
    },
    serviceType: {
        type: String,
        enum: ['standard', 'park-and-hold'],
        default: 'standard'
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Index for faster lookups
EventSchema.index({ code: 1, isActive: 1 });

// Method to check if event is valid
EventSchema.methods.isValid = function() {
    const now = new Date();
    return (
        this.isActive &&
        now >= this.validFrom &&
        now <= this.validUntil &&
        (this.maxUses === null || this.currentUses < this.maxUses)
    );
};

// Method to increment usage
EventSchema.methods.incrementUsage = async function() {
    this.currentUses += 1;
    if (this.maxUses !== null && this.currentUses >= this.maxUses) {
        this.isActive = false;
    }
    return await this.save();
};

module.exports = mongoose.model('Event', EventSchema);