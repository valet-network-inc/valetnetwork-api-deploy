const mongoose = require('mongoose');

// The commission agreement a rep signs before the portal opens (spec v2, 17).
// Versioned: a new version means every rep signs again.
const RepAgreementSchema = new mongoose.Schema(
    {
        version: { type: Number, required: true, unique: true },
        text: { type: String, required: true },
    },
    { timestamps: true }
);

module.exports = mongoose.model('RepAgreement', RepAgreementSchema);
