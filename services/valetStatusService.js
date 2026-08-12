/**
 * valetStatusService
 *
 * Single source of truth for valet onboarding status transitions.
 * Called from:
 *   - valetDocumentController (after a DL upload)
 *   - backgroundCheckController (when the Certn webhook fires)
 *   - adminController (when Rishi clicks Authorize / Suspend / etc.)
 *
 * Every transition is logged to User.statusHistory so we can answer
 * "when did this valet move from X to Y, and who triggered it?"
 */

const ValetDocument = require('../models/ValetDocument');
const providerNotifyService = require('./providerNotifyService');

/**
 * Append a status transition to the User's statusHistory and update
 * valetOnboardingStatus to the new value. Caller must have already
 * loaded the user document; this function mutates and saves it.
 *
 * Side effect: when transitioning TO `pending_provider_approval`, fires
 * the provider notification asynchronously (fire-and-forget — callers
 * don't await it). This is the "auto-send to providers" hook.
 *
 * @param {Document} user           - Mongoose User document
 * @param {string}   toStatus       - new value for valetOnboardingStatus
 * @param {string}   triggerSource  - 'system' | 'certn_webhook' | 'admin'
 * @param {ObjectId|null} triggerAdminId - admin user ID if 'admin', else null
 * @param {string}   reason         - optional context string
 */
exports.transitionStatus = async (user, toStatus, triggerSource, triggerAdminId, reason) => {
    const fromStatus = user.valetOnboardingStatus;
    if (fromStatus === toStatus) return; // no-op
    user.valetOnboardingStatus = toStatus;
    user.statusHistory.push({
        from: fromStatus,
        to: toStatus,
        at: new Date(),
        triggerSource,
        triggerAdminId,
        reason,
    });
    await user.save();

    // Auto-notify providers on transition into pending_provider_approval.
    // Fire-and-forget — don't await, so a Resend hiccup can't block this
    // status save from completing for the caller.
    if (toStatus === 'pending_provider_approval') {
        setImmediate(() => {
            providerNotifyService.notifyProvidersForValet(user._id)
                .catch((err) => console.error('notifyProvidersForValet error:', err.message));
        });
    }
};

/**
 * Advance a valet whose background check just passed to
 * `pending_provider_approval` so Rishi can authorize them.
 *
 * DL upload is no longer required — Yardstik's IDV stage captures
 * license info on its hosted form, so the mobile DL upload UI was
 * deferred. The transition now fires as soon as Yardstik passes.
 *
 * Accepts both `pending_certn` (the normal new-valet path) and
 * `pending_documents` (legacy state, retained for any in-flight
 * records still sitting there).
 *
 * Idempotent — safe to call multiple times.
 *
 * @param {Document} user - Mongoose User document
 */
exports.maybeAdvanceToProviderApproval = async (user) => {
    if (!['pending_certn', 'pending_documents'].includes(user.valetOnboardingStatus)) return;
    if (user.backgroundCheck?.status !== 'passed') return;

    user.providerAuthorization = user.providerAuthorization || {};
    user.providerAuthorization.packagePreparedAt = new Date();
    await exports.transitionStatus(
        user,
        'pending_provider_approval',
        'system',
        null,
        'Background check passed; ready for provider review.'
    );
};
