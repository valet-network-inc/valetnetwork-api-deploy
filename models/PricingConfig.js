const mongoose = require('mongoose');

// Single-document collection holding the customer-facing prices (in cents).
// The admin dashboard edits this so prices can change live WITHOUT shipping an
// app update — the mobile app fetches these values at runtime and uses them for
// both the displayed price and the amount charged.
//
// All values are integer cents. Defaults mirror the previously-hardcoded prices.
const PricingConfigSchema = new mongoose.Schema(
    {
        // Fixed key so there is always exactly one config document.
        key: { type: String, default: 'default', unique: true },

        parkingCents: { type: Number, default: 1000 },          // standard parking (flat)
        parkAndRetrieveCents: { type: Number, default: 1300 },  // park & retrieve (valet returns car at end)
        aspCents: { type: Number, default: 1500 },              // ASP (alternate-side) parking (flat)
        retrievalCents: { type: Number, default: 500 },         // on-demand retrieval service
        carWatchPerHourCents: { type: Number, default: 100 },   // Car Watch add-on, per hour

        // Optional audit trail of who last changed prices (email / note).
        updatedBy: { type: String },
    },
    { timestamps: true }
);

// Fetch the singleton, creating it with defaults on first access.
PricingConfigSchema.statics.getSingleton = async function () {
    let doc = await this.findOne({ key: 'default' });
    if (!doc) {
        doc = await this.create({ key: 'default' });
    }
    return doc;
};

module.exports = mongoose.model('PricingConfig', PricingConfigSchema);
