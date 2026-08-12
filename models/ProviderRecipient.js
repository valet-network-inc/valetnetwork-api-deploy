const mongoose = require('mongoose');

// ProviderRecipient — editable list of email addresses that receive the
// data package whenever a valet transitions to `pending_provider_approval`.
//
// Day one: typically just one entry (Rishi's own email) so he can review
// and forward to providers manually.
// Later: insurance providers' intake addresses get added here as they
// come on board, and the system sends to them directly.
//
// Add/edit/remove via the admin dashboard (see providerRecipientController).

const ProviderRecipientSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
    },
    // Friendly name shown in the dashboard, e.g. "ABC Insurance — Underwriting"
    label: { type: String },
    // Soft-toggle. Set to false to pause sends without deleting the row
    // (preserves the audit trail of who was notified historically).
    active: { type: Boolean, default: true },
    // Optional notes for Rishi's reference
    notes: { type: String },
}, {
    timestamps: true,
});

module.exports = mongoose.model('ProviderRecipient', ProviderRecipientSchema);
