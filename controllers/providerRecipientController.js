/**
 * providerRecipientController
 *
 * CRUD for the editable list of email recipients that get the contractor
 * data package whenever a valet hits `pending_provider_approval`.
 *
 * Today: typically just Rishi's own email is in this list, so he gets a
 * notification whenever a valet is ready and forwards manually.
 * Later: insurance providers' intake addresses get added here as they
 * come on board, and the system delivers to them directly.
 */

const ProviderRecipient = require('../models/ProviderRecipient');

/**
 * GET /api/admin/provider-recipients
 * Returns all recipients (active and inactive) with newest first.
 */
exports.list = async (req, res) => {
    try {
        const recipients = await ProviderRecipient
            .find({})
            .sort({ createdAt: -1 })
            .lean();
        return res.json({ success: true, recipients });
    } catch (err) {
        console.error('providerRecipient.list error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * POST /api/admin/provider-recipients
 * Body: { email, label?, notes? }
 */
exports.create = async (req, res) => {
    try {
        const { email, label, notes } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, message: 'email is required' });
        }
        const recipient = await ProviderRecipient.create({
            email: String(email).toLowerCase().trim(),
            label,
            notes,
            active: true,
        });
        return res.json({ success: true, recipient });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({
                success: false,
                message: 'A recipient with this email already exists',
            });
        }
        console.error('providerRecipient.create error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * PATCH /api/admin/provider-recipients/:id
 * Body: any of { email, label, notes, active }
 */
exports.update = async (req, res) => {
    try {
        const { id } = req.params;
        const updates = {};
        ['label', 'notes', 'active'].forEach((k) => {
            if (req.body[k] !== undefined) updates[k] = req.body[k];
        });
        if (req.body.email !== undefined) {
            updates.email = String(req.body.email).toLowerCase().trim();
        }

        const recipient = await ProviderRecipient.findByIdAndUpdate(id, updates, {
            new: true,
            runValidators: true,
        });
        if (!recipient) {
            return res.status(404).json({ success: false, message: 'Recipient not found' });
        }
        return res.json({ success: true, recipient });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({
                success: false,
                message: 'A recipient with this email already exists',
            });
        }
        console.error('providerRecipient.update error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * DELETE /api/admin/provider-recipients/:id
 *
 * Hard delete — use the PATCH endpoint with `active: false` instead if
 * you want to preserve the row for audit history.
 */
exports.remove = async (req, res) => {
    try {
        const { id } = req.params;
        const recipient = await ProviderRecipient.findByIdAndDelete(id);
        if (!recipient) {
            return res.status(404).json({ success: false, message: 'Recipient not found' });
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('providerRecipient.remove error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};
