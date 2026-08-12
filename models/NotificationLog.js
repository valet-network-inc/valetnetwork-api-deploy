const mongoose = require('mongoose');

/**
 * Every admin-initiated push, kept so a blast is auditable after the fact:
 * who was targeted, what was said, how many phones it actually reached.
 */
const NotificationLogSchema = new mongoose.Schema({
    audience: {
        type: String,
        enum: ['user', 'customers', 'valets', 'all'],
        required: true,
    },
    // Set only when audience === 'user'
    targetUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    title: { type: String, required: true },
    body: { type: String, required: true },
    sound: { type: String },
    data: { type: mongoose.Schema.Types.Mixed },

    recipientsAttempted: { type: Number, default: 0 },
    recipientsDelivered: { type: Number, default: 0 },
    recipientsFailed: { type: Number, default: 0 },

    // Free-text note about who sent it. The dashboard has no login yet, so
    // this is the operator's own label rather than a verified identity.
    sentByNote: { type: String },

    sentAt: { type: Date, default: Date.now },
});

NotificationLogSchema.index({ sentAt: -1 });

module.exports = mongoose.model('NotificationLog', NotificationLogSchema);
