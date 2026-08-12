/**
 * backgroundCheckController
 *
 * Provider-neutral controller for valet background checks. Dispatches to the
 * active provider (Certn or Yardstik) selected via the BACKGROUND_CHECK_PROVIDER
 * env var (defaults to 'certn'). Provider implementations live in
 * services/backgroundCheck/.
 *
 * Flow:
 *   1. Valet completes signup → mobile app navigates to BackgroundCheckScreen.
 *   2. iOS POSTs to /api/valet/initiateBackgroundCheck. Required body fields
 *      depend on the active provider (Certn needs SSN/DOB/license; Yardstik
 *      invitation flow only needs name + email).
 *   3. Provider creates the check and returns an application/report id.
 *   4. The provider's webhook fires later when results are ready. We update
 *      the User and drive the onboarding state machine forward.
 */

const dotenv = require('dotenv');
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });

const User = require('../models/User');
const valetStatusService = require('../services/valetStatusService');
const { getActiveProvider, getProviderByName } = require('../services/backgroundCheck');

/**
 * POST /api/valet/initiateBackgroundCheck
 * Body: { userId, firstName, lastName, email, ...provider-specific fields }
 * Returns: { success, status, applicationId, message }
 */
exports.initiate = async (req, res) => {
    try {
        const provider = getActiveProvider();
        if (!provider.isConfigured()) {
            return res.status(503).json({
                success: false,
                message: `Background check service (${provider.name}) not yet configured. Add the required env vars.`,
            });
        }

        const missing = provider.requiredInitiateFields.filter((k) => !req.body[k]);
        if (missing.length) {
            return res.status(400).json({
                success: false,
                message: `Missing required fields: ${missing.join(', ')}`,
            });
        }

        const user = await User.findById(req.body.userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        if (!user.isValet) {
            return res.status(403).json({
                success: false,
                message: 'Background checks are only for valet accounts',
            });
        }
        if (
            user.backgroundCheck?.status === 'pending' ||
            user.backgroundCheck?.status === 'passed'
        ) {
            return res.status(400).json({
                success: false,
                message: `Background check already ${user.backgroundCheck.status}`,
                status: user.backgroundCheck.status,
            });
        }

        const result = await provider.initiate({ user, body: req.body });

        const update = {
            'backgroundCheck.status': 'pending',
            'backgroundCheck.provider': provider.name,
            // We continue to reuse the legacy `certnApplicationId` field as the
            // provider-agnostic application/report id, to avoid a schema rename.
            // The new `provider` field disambiguates which provider it came from.
            'backgroundCheck.certnApplicationId': result.applicationId,
            'backgroundCheck.initiatedAt': new Date(),
        };
        // Yardstik-specific: save invitationId so the resend endpoint can
        // refresh it later without a round-trip to fetch the report first.
        if (result.invitationId) {
            update['backgroundCheck.invitationId'] = result.invitationId;
        }
        // Yardstik-specific: save candidateId so webhook matching can fall
        // back to it when the payload doesn't carry our external_id.
        if (result.candidateId) {
            update['backgroundCheck.candidateId'] = result.candidateId;
        }
        await User.findByIdAndUpdate(user._id, update);

        res.status(200).json({
            success: true,
            status: 'pending',
            provider: provider.name,
            applicationId: result.applicationId,
            // Legacy alias for older iOS builds that read `certnApplicationId`.
            certnApplicationId: result.applicationId,
            // Yardstik invitation flow returns an apply URL — useful for testing.
            applyUrl: result.applyUrl,
            message:
                result.message ||
                'Background check submitted. Results typically arrive within 1-3 business days.',
        });
    } catch (err) {
        const upstream = err.response?.data;
        console.error(
            'Background check initiate error:',
            upstream || err.message
        );
        res.status(500).json({
            success: false,
            message:
                upstream?.detail ||
                upstream?.message ||
                err.message ||
                'Failed to initiate background check',
        });
    }
};

/**
 * POST /api/valet/resendBackgroundCheckInvitation
 * Body: { userId }
 * Returns: { success, applyUrl?, expiresAt?, message }
 *
 * Refreshes a Yardstik invitation when the candidate has lost the email,
 * the email went to spam, or the 7-day expiration window has lapsed.
 *
 * Provider-gated: only available when the active provider supports it.
 * Certn doesn't have a resend concept, so calls return 501 in that case.
 */
exports.resendInvitation = async (req, res) => {
    try {
        const provider = getActiveProvider();
        if (typeof provider.resendInvitation !== 'function') {
            return res.status(501).json({
                success: false,
                message: `Resend not supported by active provider (${provider.name}).`,
            });
        }
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({ success: false, message: 'userId is required' });
        }
        const user = await User.findById(userId).select('backgroundCheck isValet');
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        if (!user.isValet) {
            return res.status(403).json({
                success: false,
                message: 'Background checks are only for valet accounts',
            });
        }
        const invitationId = user.backgroundCheck?.invitationId;
        if (!invitationId) {
            return res.status(400).json({
                success: false,
                message: 'No active invitation to resend. Submit a new background check first.',
            });
        }
        const result = await provider.resendInvitation({ invitationId });
        res.status(200).json({
            success: true,
            applyUrl: result.applyUrl,
            expiresAt: result.expiresAt,
            refreshed: result.refreshed,
            message: result.refreshed
                ? 'Invitation email resent. Check your inbox.'
                : 'Your invitation is still active — the original email is valid. ' +
                  'Open the form directly to continue.',
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        const upstream = err.response?.data;
        console.error(
            'Background check resend error:',
            upstream || err.message
        );
        res.status(statusCode).json({
            success: false,
            message:
                upstream?.detail ||
                upstream?.message ||
                err.message ||
                'Failed to resend background check invitation',
        });
    }
};

/**
 * GET /api/valet/backgroundCheckStatus?userId=...
 */
exports.getStatus = async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) {
            return res
                .status(400)
                .json({ success: false, message: 'userId is required' });
        }
        const user = await User.findById(userId).select('backgroundCheck isValet');
        if (!user) {
            return res
                .status(404)
                .json({ success: false, message: 'User not found' });
        }
        res.status(200).json({
            success: true,
            backgroundCheck: user.backgroundCheck || { status: 'not_started' },
        });
    } catch (err) {
        console.error('getStatus error:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch background check status',
        });
    }
};

/**
 * Resolve a user from any combination of correlators a webhook might
 * carry. Tries external_id (our user._id), then candidate_id stored at
 * initiate, then the application/report id. Returns null if nothing
 * matches.
 */
async function findUserForWebhook({ externalUserId, candidateId, providerAppId }) {
    if (externalUserId) {
        try {
            const u = await User.findById(externalUserId);
            if (u) return u;
        } catch {
            // invalid ObjectId — fall through
        }
    }
    if (candidateId) {
        const u = await User.findOne({ 'backgroundCheck.candidateId': candidateId });
        if (u) return u;
    }
    if (providerAppId) {
        const u = await User.findOne({ 'backgroundCheck.certnApplicationId': providerAppId });
        if (u) return u;
    }
    return null;
}

/**
 * Generic webhook handler used by both providers. Each provider parses its own
 * payload shape, then this function does the provider-agnostic User update +
 * onboarding-state transition.
 *
 * Triggered via:
 *   POST /api/webhooks/certn      (handler: exports.certnWebhook)
 *   POST /api/webhooks/yardstik   (handler: exports.yardstikWebhook)
 */
async function handleParsedWebhook(parsed, providerName, res) {
    if (!parsed) {
        // Unrecognized event shape — ack so provider doesn't keep retrying.
        return res.status(200).json({ success: true, ignored: true });
    }

    const { externalUserId, providerAppId, candidateId, rawStatus, mappedStatus, terminal } = parsed;

    // Resolve the user via a series of fallbacks. external_id is the most
    // direct (it's our user._id), but Yardstik webhooks don't reliably
    // include it. candidate_id is stored on the user record at initiate
    // time. application/report id matches when the webhook is for the
    // main report we created. As a last resort, we call the provider API
    // to look up the canonical external_id/candidate_id and retry.
    let user = await findUserForWebhook({ externalUserId, candidateId, providerAppId });

    if (!user && providerName === 'yardstik' && providerAppId) {
        const provider = getProviderByName('yardstik');
        if (typeof provider.fetchReportCorrelators === 'function') {
            const correlators = await provider.fetchReportCorrelators(providerAppId);
            if (correlators) {
                user = await findUserForWebhook({
                    externalUserId: correlators.externalUserId,
                    candidateId: correlators.candidateId,
                    providerAppId,
                });
            }
        }
    }

    if (!user) {
        console.warn(
            `${providerName} webhook: no matching user`,
            { externalUserId, candidateId, providerAppId, rawStatus }
        );
        return res.status(200).json({ success: true, ignored: true });
    }

    // Save the raw provider status on every webhook (terminal or not) so
    // the mobile step indicator can render the current Yardstik phase
    // ("queued" → "processing" → "clear"/etc.).
    user.backgroundCheck = user.backgroundCheck || {};
    if (rawStatus) user.backgroundCheck.providerStatus = rawStatus;

    // Non-terminal events stop here — don't transition the high-level
    // `status` field on intermediate updates.
    if (terminal === false) {
        await user.save();
        return res.status(200).json({ success: true, nonTerminal: true });
    }

    user.backgroundCheck.status = mappedStatus;
    user.backgroundCheck.provider = providerName;
    user.backgroundCheck.certnResult = rawStatus; // legacy field, repurposed for both providers
    user.backgroundCheck.completedAt = new Date();

    const triggerSource =
        providerName === 'yardstik' ? 'yardstik_webhook' : 'certn_webhook';
    const reason = `${providerName} returned ${rawStatus}`;

    if (
        mappedStatus === 'passed' &&
        ['pending_certn', 'pending_documents'].includes(user.valetOnboardingStatus)
    ) {
        // Save backgroundCheck fields, then advance straight to
        // pending_provider_approval (DL upload deferred — Yardstik IDV
        // already captured license info).
        await user.save();
        await valetStatusService.maybeAdvanceToProviderApproval(user);
    } else if (
        mappedStatus === 'failed' &&
        ['pending_certn', 'pending_documents'].includes(user.valetOnboardingStatus)
    ) {
        await valetStatusService.transitionStatus(
            user,
            'certn_failed',
            triggerSource,
            null,
            reason
        );
    } else {
        await user.save();
    }

    // Notify the valet via FCM on terminal results. The mobile app polls
    // every 30s while on BackgroundCheckScreen, but a push lets us reach
    // valets who closed the app after submitting the email — they don't
    // need to keep reopening to check.
    if (
        (mappedStatus === 'passed' || mappedStatus === 'failed') &&
        user.firebaseUid
    ) {
        try {
            const { sendPushNotification } = require('./notificationController');
            const title = mappedStatus === 'passed'
                ? 'Background check approved'
                : 'Background check update';
            const body = mappedStatus === 'passed'
                ? "You're cleared. Open the app to finish setup."
                : 'There was an issue with your background check. Tap to see next steps.';
            await sendPushNotification(user.firebaseUid, title, body, {
                type: 'BACKGROUND_CHECK_RESULT',
                status: mappedStatus,
            });
        } catch (pushErr) {
            console.warn(
                `${providerName} webhook: push notify failed for user ${user._id}: ${pushErr.message}`
            );
        }
    }

    console.log(
        `${providerName} webhook: user`,
        user._id.toString(),
        '->',
        mappedStatus,
        `(${providerName}=${rawStatus}, onboarding=${user.valetOnboardingStatus})`
    );

    res.status(200).json({ success: true });
}

exports.certnWebhook = async (req, res) => {
    try {
        const certn = getProviderByName('certn');
        const parsed = certn.parseWebhook(req);
        return await handleParsedWebhook(parsed, 'certn', res);
    } catch (err) {
        console.error('Certn webhook error:', err.message);
        // 200 so Certn doesn't retry on every transient error
        res.status(200).json({ success: false, message: err.message });
    }
};

exports.yardstikWebhook = async (req, res) => {
    try {
        const yardstik = getProviderByName('yardstik');
        if (!yardstik.verifyWebhookSignature(req)) {
            console.warn('Yardstik webhook: signature verification failed');
            return res.status(401).json({ success: false, message: 'invalid signature' });
        }
        const parsed = yardstik.parseWebhook(req);
        return await handleParsedWebhook(parsed, 'yardstik', res);
    } catch (err) {
        console.error('Yardstik webhook error:', err.message);
        res.status(200).json({ success: false, message: err.message });
    }
};

// Backwards-compat alias: existing routes/webhook.js mounts `.webhook` for Certn.
// Kept so the old route binding continues to work if we miss the route update.
exports.webhook = exports.certnWebhook;
