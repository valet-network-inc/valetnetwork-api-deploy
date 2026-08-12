/**
 * savedCustomerController
 *
 * CRUD for an Enterprise (doorman) account's roster of recurring
 * residents. Used by the Enterprise summon flow on mobile to one-tap
 * autofill the order.
 *
 * Routes (mounted at /api/saved-customers):
 *   GET    /                  — list active for ?enterpriseId=
 *   POST   /                  — create
 *   PATCH  /:id               — update
 *   DELETE /:id               — soft-delete
 *
 * Authorization: caller must pass enterpriseId either in body or query;
 * the controller enforces ownership of the SavedCustomer record.
 * (Build 11 ships without per-route JWT middleware on this set — same
 * trust model as the existing order/payment endpoints.)
 */

const mongoose = require('mongoose');
const SavedCustomer = require('../models/SavedCustomer');

const sanitize = (input = {}) => {
    const out = {};
    if (typeof input.name === 'string') out.name = input.name.trim();
    if (typeof input.phone === 'string') out.phone = input.phone.trim();
    if (typeof input.unit === 'string') out.unit = input.unit.trim();
    if (input.vehicle && typeof input.vehicle === 'object') {
        out.vehicle = {
            color: typeof input.vehicle.color === 'string' ? input.vehicle.color.trim() : undefined,
            model: typeof input.vehicle.model === 'string' ? input.vehicle.model.trim() : undefined,
            licensePlate:
                typeof input.vehicle.licensePlate === 'string'
                    ? input.vehicle.licensePlate.trim().toUpperCase()
                    : undefined,
        };
    }
    if (
        typeof input.preferredService === 'string' &&
        ['standard', 'park-and-hold'].includes(input.preferredService)
    ) {
        out.preferredService = input.preferredService;
    }
    if (typeof input.notes === 'string') out.notes = input.notes;
    return out;
};

/**
 * GET /api/saved-customers?enterpriseId=...
 */
exports.listSavedCustomers = async (req, res) => {
    try {
        const enterpriseId = req.query.enterpriseId;
        if (!enterpriseId) {
            return res.status(400).json({
                success: false,
                message: 'enterpriseId query param is required.',
            });
        }
        // Guard against invalid ObjectId strings so bad query input
        // returns 400 instead of a Mongoose CastError surfacing as 500.
        if (!mongoose.Types.ObjectId.isValid(enterpriseId)) {
            return res.status(400).json({
                success: false,
                message: 'enterpriseId is not a valid ObjectId.',
            });
        }
        const rows = await SavedCustomer.find({
            enterprise: enterpriseId,
            isDeleted: { $ne: true },
        })
            .sort({ name: 1 })
            .lean();
        return res.json({ success: true, savedCustomers: rows });
    } catch (err) {
        console.error('listSavedCustomers error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to list saved customers.',
        });
    }
};

/**
 * POST /api/saved-customers
 * Body: { enterpriseId, name, phone?, unit?, vehicle?, preferredService?, notes? }
 */
exports.createSavedCustomer = async (req, res) => {
    try {
        const { enterpriseId } = req.body;
        if (!enterpriseId) {
            return res.status(400).json({
                success: false,
                message: 'enterpriseId is required.',
            });
        }

        const fields = sanitize(req.body);
        if (!fields.name) {
            return res.status(400).json({
                success: false,
                message: 'name is required.',
            });
        }

        const created = await SavedCustomer.create({
            enterprise: enterpriseId,
            ...fields,
        });
        return res.json({ success: true, savedCustomer: created });
    } catch (err) {
        console.error('createSavedCustomer error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to create saved customer.',
        });
    }
};

/**
 * PATCH /api/saved-customers/:id
 * Body: { enterpriseId, ...fields to update }
 */
exports.updateSavedCustomer = async (req, res) => {
    try {
        const { id } = req.params;
        const { enterpriseId } = req.body;
        if (!enterpriseId) {
            return res.status(400).json({
                success: false,
                message: 'enterpriseId is required.',
            });
        }

        const existing = await SavedCustomer.findOne({
            _id: id,
            enterprise: enterpriseId,
            isDeleted: { $ne: true },
        });
        if (!existing) {
            return res.status(404).json({
                success: false,
                message: 'Saved customer not found.',
            });
        }

        const updates = sanitize(req.body);
        // Only overwrite vehicle subdoc if any of its fields were sent —
        // sanitize returns vehicle:{} when nothing was provided, which
        // would clobber the saved data.
        if (updates.vehicle) {
            const v = updates.vehicle;
            const empty =
                v.color === undefined && v.model === undefined && v.licensePlate === undefined;
            if (empty) delete updates.vehicle;
            else
                updates.vehicle = {
                    ...existing.vehicle?.toObject?.(),
                    ...Object.fromEntries(
                        Object.entries(v).filter(([, val]) => val !== undefined)
                    ),
                };
        }

        Object.assign(existing, updates);
        await existing.save();
        return res.json({ success: true, savedCustomer: existing });
    } catch (err) {
        console.error('updateSavedCustomer error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to update saved customer.',
        });
    }
};

/**
 * DELETE /api/saved-customers/:id
 * Body: { enterpriseId }
 *
 * Soft-delete so any old Order references that point at this record by
 * id can still resolve the original metadata for receipts.
 */
exports.deleteSavedCustomer = async (req, res) => {
    try {
        const { id } = req.params;
        const { enterpriseId } = req.body;
        if (!enterpriseId) {
            return res.status(400).json({
                success: false,
                message: 'enterpriseId is required.',
            });
        }
        const updated = await SavedCustomer.findOneAndUpdate(
            { _id: id, enterprise: enterpriseId, isDeleted: { $ne: true } },
            { isDeleted: true },
            { new: true }
        );
        if (!updated) {
            return res.status(404).json({
                success: false,
                message: 'Saved customer not found.',
            });
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('deleteSavedCustomer error:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to delete saved customer.',
        });
    }
};
