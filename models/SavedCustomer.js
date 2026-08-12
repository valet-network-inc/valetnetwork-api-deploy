const mongoose = require('mongoose');

/**
 * SavedCustomer — recurring end-customer records for Enterprise (doorman)
 * accounts. The doorman keeps a roster of building residents so summoning
 * a valet for "Mr. Patel in 14C" is one tap instead of typing four fields.
 *
 * Owned by the Enterprise User. The User itself can have many — typically
 * one per resident.
 *
 * Tap-to-autofill on the Enterprise summon screen pulls:
 *   - endCustomerName + endCustomerPhone (already on Order)
 *   - vehicle.{color, model, licensePlate}
 *   - serviceType (preferredService → 'standard' | 'park-and-hold')
 *   - notes (free text — surfaced to the valet on the order screen)
 */

const SavedCustomerSchema = new mongoose.Schema(
    {
        enterprise: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },

        // Display + dispatch
        name: { type: String, required: true, trim: true },
        phone: { type: String, trim: true },                    // E.164 preferred, not enforced
        unit: { type: String, trim: true },                     // e.g. "14C" — useful for doorman context

        // Vehicle defaults — applied to the order's vehicle subdoc unless
        // the doorman edits at summon time.
        vehicle: {
            color: { type: String, trim: true },
            model: { type: String, trim: true },
            licensePlate: { type: String, trim: true, uppercase: true },
        },

        // Default service when summoning. 'park-and-hold' = $13 bundle
        // (parking + retrieval), 'standard' = $10 parking only.
        preferredService: {
            type: String,
            enum: ['standard', 'park-and-hold'],
            default: 'standard',
        },

        notes: { type: String, default: '' },

        // Soft-delete so order history can still resolve a SavedCustomer
        // ref after the doorman removes it from the active roster.
        isDeleted: { type: Boolean, default: false },
    },
    { timestamps: true }
);

// Plate is a useful secondary lookup — find the saved customer for a car
// the doorman just spotted pulling up. Sparse so blank plates don't all
// collide on null.
SavedCustomerSchema.index(
    { enterprise: 1, 'vehicle.licensePlate': 1 },
    { sparse: true }
);

module.exports = mongoose.model('SavedCustomer', SavedCustomerSchema);
