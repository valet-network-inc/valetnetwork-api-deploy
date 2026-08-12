/**
 * valetOnboardingAdminController
 *
 * Admin-side endpoints powering the "Contractor Onboarding" tab in the
 * admin dashboard. Distinct from the existing adminController which deals
 * with metrics + general valet management. These endpoints all relate to
 * the onboarding lifecycle: provider approval queue, document review,
 * authorize/suspend/reinstate actions, data package generation.
 *
 * Auth note: matches the existing controller pattern (no JWT middleware,
 * caller passes adminUserId in the body for action endpoints). When
 * multi-admin auth lands later, swap the `adminUserId` body field for a
 * proper auth middleware that injects req.adminUser.
 */

const User = require('../models/User');
const ValetDocument = require('../models/ValetDocument');
const firebaseStorage = require('../services/firebaseStorage');
const valetStatusService = require('../services/valetStatusService');

// ---------------------------------------------------------------------
// LIST views
// ---------------------------------------------------------------------

/**
 * GET /api/admin/valets/onboarding/pending-provider-approval
 *
 * Queue of valets ready to be sent to insurance providers. This is the
 * primary list Rishi works through — each row represents a valet who has
 * passed Certn AND uploaded both DL sides, and is now waiting for Rishi
 * to send their data to providers and click Authorize.
 *
 * Returns: { success, valets: [{ userId, firstName, lastName, phone,
 *           backgroundCheckStatus, packagePreparedAt, hoursWaiting }] }
 */
exports.listPendingProviderApproval = async (req, res) => {
    try {
        const valets = await User
            .find({ valetOnboardingStatus: 'pending_provider_approval' })
            .select('firstName lastName phone backgroundCheck providerAuthorization createdAt')
            .sort({ 'providerAuthorization.packagePreparedAt': 1 })   // oldest first
            .lean();

        const now = Date.now();
        const result = valets.map((v) => ({
            userId: v._id,
            firstName: v.firstName,
            lastName: v.lastName,
            phone: v.phone,
            backgroundCheckStatus: v.backgroundCheck?.status,
            packagePreparedAt: v.providerAuthorization?.packagePreparedAt || null,
            hoursWaiting: v.providerAuthorization?.packagePreparedAt
                ? Math.round((now - new Date(v.providerAuthorization.packagePreparedAt).getTime()) / (1000 * 60 * 60))
                : null,
            signedUpAt: v.createdAt,
        }));

        return res.json({ success: true, valets: result });
    } catch (err) {
        console.error('listPendingProviderApproval error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * GET /api/admin/valets/onboarding/by-status?status=<status>&limit=<n>
 *
 * General list filter — pass a valetOnboardingStatus value, get all valets
 * in that state. Used by the dashboard's filterable list view.
 */
exports.listByStatus = async (req, res) => {
    try {
        const { status } = req.query;
        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

        const filter = { isValet: true };
        if (status) filter.valetOnboardingStatus = status;

        const valets = await User
            .find(filter)
            .select('firstName lastName phone valetOnboardingStatus backgroundCheck.status providerAuthorization createdAt')
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();

        return res.json({
            success: true,
            valets: valets.map((v) => ({
                userId: v._id,
                firstName: v.firstName,
                lastName: v.lastName,
                phone: v.phone,
                onboardingStatus: v.valetOnboardingStatus,
                certnStatus: v.backgroundCheck?.status,
                authorizedAt: v.providerAuthorization?.authorizedAt || null,
                signedUpAt: v.createdAt,
            })),
        });
    } catch (err) {
        console.error('listByStatus error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ---------------------------------------------------------------------
// DETAIL view
// ---------------------------------------------------------------------

/**
 * GET /api/admin/valets/onboarding/:userId
 *
 * Full per-valet detail page — everything Rishi might want to see when
 * deciding whether to authorize. Combines User fields, all current docs,
 * status history, and Certn results.
 *
 * NOTE: doc viewUrls are NOT included here (would require generating
 * signed URLs for every doc on every page load). Frontend calls the
 * signed-url endpoint when the user clicks to view a specific doc.
 */
exports.getValetOnboardingDetail = async (req, res) => {
    try {
        const { userId } = req.params;
        const user = await User
            .findById(userId)
            .select('firstName lastName phone email isValet isActive valetOnboardingStatus backgroundCheck providerAuthorization statusHistory createdAt')
            .lean();

        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        if (!user.isValet) return res.status(400).json({ success: false, message: 'Not a valet account' });

        // Currently-stored documents (skip superseded versions for the main view)
        const currentDocs = await ValetDocument
            .find({ userId, status: 'stored' })
            .select('type uploadedAt mimeType fileSize originalFilename')
            .lean();

        // Full document history (including superseded) for audit display
        const allDocs = await ValetDocument
            .find({ userId })
            .select('type status uploadedAt mimeType')
            .sort({ uploadedAt: -1 })
            .lean();

        return res.json({
            success: true,
            valet: {
                userId: user._id,
                firstName: user.firstName,
                lastName: user.lastName,
                phone: user.phone,
                email: user.email,
                isActive: user.isActive,
                onboardingStatus: user.valetOnboardingStatus,
                signedUpAt: user.createdAt,
            },
            backgroundCheck: user.backgroundCheck || { status: 'not_started' },
            providerAuthorization: user.providerAuthorization || {},
            currentDocuments: currentDocs.map((d) => ({
                docId: d._id,
                type: d.type,
                uploadedAt: d.uploadedAt,
                mimeType: d.mimeType,
                fileSize: d.fileSize,
                originalFilename: d.originalFilename,
            })),
            documentHistory: allDocs.map((d) => ({
                docId: d._id,
                type: d.type,
                status: d.status,
                uploadedAt: d.uploadedAt,
                mimeType: d.mimeType,
            })),
            statusHistory: user.statusHistory || [],
        });
    } catch (err) {
        console.error('getValetOnboardingDetail error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ---------------------------------------------------------------------
// Document viewing
// ---------------------------------------------------------------------

/**
 * GET /api/admin/valets/onboarding/:userId/documents/:docId/signed-url
 *
 * Generate a short-lived signed URL the admin frontend can use to
 * actually display the DL photo. The bucket is private — direct URLs
 * don't work; only signed URLs grant temporary read access.
 */
exports.getDocumentSignedUrl = async (req, res) => {
    try {
        const { userId, docId } = req.params;
        const doc = await ValetDocument.findOne({ _id: docId, userId }).lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });

        const url = await firebaseStorage.getSignedUrl(doc.s3Key, 15);   // 15 min expiry
        return res.json({
            success: true,
            url,
            mimeType: doc.mimeType,
            expiresInMinutes: 15,
        });
    } catch (err) {
        console.error('getDocumentSignedUrl error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ---------------------------------------------------------------------
// Action endpoints
// ---------------------------------------------------------------------

/**
 * POST /api/admin/valets/onboarding/:userId/authorize
 * Body: { note? }
 *
 * Rishi clicks Authorize after providers have given the green light.
 * Moves the valet from `pending_provider_approval` → `active`.
 *
 * No auth: matches existing dashboard pattern. When per-admin auth
 * lands later, we'll record req.adminUser._id on the transition.
 */
exports.authorizeValet = async (req, res) => {
    try {
        const { userId } = req.params;
        const { note } = req.body;

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        if (!user.isValet) return res.status(400).json({ success: false, message: 'Not a valet account' });

        if (user.valetOnboardingStatus !== 'pending_provider_approval') {
            return res.status(409).json({
                success: false,
                message: `Cannot authorize: valet is in '${user.valetOnboardingStatus}', expected 'pending_provider_approval'.`,
            });
        }

        // Stamp the authorization (admin identity will be wired in once auth exists)
        user.providerAuthorization = user.providerAuthorization || {};
        user.providerAuthorization.authorizedAt = new Date();

        await valetStatusService.transitionStatus(
            user,
            'active',
            'admin',
            null,
            note || 'Authorized after provider approval'
        );

        return res.json({
            success: true,
            valetOnboardingStatus: user.valetOnboardingStatus,
        });
    } catch (err) {
        console.error('authorizeValet error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * POST /api/admin/valets/onboarding/:userId/force-activate
 * Body: { reason? }
 *
 * Admin override — flip a valet to `active` from ANY non-active state.
 * Unlike `authorizeValet` (which requires `pending_provider_approval`),
 * this works regardless of where the valet is in the lifecycle. Used to
 * unstick test accounts, manually authorize a valet whose Certn check
 * failed but is being given a chance, or restore a valet whose state
 * got stuck mid-flow.
 *
 * Also clears the background-check gate — see the comment below for why
 * that's part of the override rather than a separate action.
 *
 * Logged in statusHistory with reason so the override is auditable.
 */
exports.forceActivate = async (req, res) => {
    try {
        const { userId } = req.params;
        const { reason } = req.body;

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        if (!user.isValet) return res.status(400).json({ success: false, message: 'Not a valet account' });

        const wasOnboardingActive = user.valetOnboardingStatus === 'active';
        const wasIsActive = !!user.isActive;
        const wasBgPassed = user.backgroundCheck?.status === 'passed';
        if (wasOnboardingActive && wasIsActive && wasBgPassed) {
            return res.json({
                success: true,
                noop: true,
                valetOnboardingStatus: user.valetOnboardingStatus,
                isActive: user.isActive,
                backgroundCheckStatus: user.backgroundCheck?.status,
                message: 'Valet was already active. No changes.',
            });
        }

        // Always flip the legacy isActive flag to true (lots of older code
        // still reads this).
        user.isActive = true;
        user.providerAuthorization = user.providerAuthorization || {};
        user.providerAuthorization.authorizedAt = new Date();

        // Clear the background-check gate too. The mobile app routes valets
        // to BackgroundCheckScreen unless `backgroundCheck.status === 'passed'`
        // (AuthLoadingScreen) — independently of isActive and
        // valetOnboardingStatus. Without this, a force-activated valet is
        // "active" everywhere the admin can see, but the app still parks them
        // on the Yardstik email form forever.
        //
        // `provider: 'grandfathered'` marks it as "not actually screened" —
        // the same marker scripts/grandfatherExistingValetsForYardstik.js used
        // for the pre-Yardstik valets. Don't use 'yardstik' here; that would
        // claim a screening that never ran.
        if (!wasBgPassed) {
            user.backgroundCheck = user.backgroundCheck || {};
            user.backgroundCheck.status = 'passed';
            user.backgroundCheck.provider = 'grandfathered';
            user.backgroundCheck.completedAt = new Date();
        }

        // Only transition the onboarding status if it isn't already active —
        // transitionStatus is a no-op if from === to, so this is just an
        // optimization to avoid pushing a redundant statusHistory entry.
        if (!wasOnboardingActive) {
            await valetStatusService.transitionStatus(
                user,
                'active',
                'admin',
                null,
                reason || 'Admin force-activate (override)'
            );
        } else {
            // isActive / backgroundCheck changed, onboarding status unchanged —
            // still need an explicit save.
            await user.save();
        }

        return res.json({
            success: true,
            valetOnboardingStatus: user.valetOnboardingStatus,
            isActive: user.isActive,
            backgroundCheckStatus: user.backgroundCheck?.status,
            backgroundCheckCleared: !wasBgPassed,
        });
    } catch (err) {
        console.error('forceActivate error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * POST /api/admin/valets/onboarding/:userId/suspend
 * Body: { reason }
 *
 * Move valet to `suspended_admin`. Allowed from any non-terminal state.
 */
exports.suspendValet = async (req, res) => {
    try {
        const { userId } = req.params;
        const { reason } = req.body;

        if (!reason) {
            return res.status(400).json({ success: false, message: 'reason is required' });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        if (!user.isValet) return res.status(400).json({ success: false, message: 'Not a valet account' });

        if (user.valetOnboardingStatus === 'suspended_admin') {
            return res.status(409).json({
                success: false,
                message: 'Valet is already suspended',
            });
        }

        await valetStatusService.transitionStatus(
            user,
            'suspended_admin',
            'admin',
            null,
            reason
        );

        return res.json({
            success: true,
            valetOnboardingStatus: user.valetOnboardingStatus,
        });
    } catch (err) {
        console.error('suspendValet error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

/**
 * POST /api/admin/valets/onboarding/:userId/reinstate
 * Body: { note? }
 *
 * Move a suspended valet back to `active` (assumes prereqs are still
 * met — this endpoint doesn't re-validate Certn/docs since we don't
 * supersede them on suspension).
 */
exports.reinstateValet = async (req, res) => {
    try {
        const { userId } = req.params;
        const { note } = req.body;

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        if (user.valetOnboardingStatus !== 'suspended_admin') {
            return res.status(409).json({
                success: false,
                message: `Cannot reinstate: valet is in '${user.valetOnboardingStatus}', expected 'suspended_admin'.`,
            });
        }

        await valetStatusService.transitionStatus(
            user,
            'active',
            'admin',
            null,
            note || 'Reinstated by admin'
        );

        return res.json({
            success: true,
            valetOnboardingStatus: user.valetOnboardingStatus,
        });
    } catch (err) {
        console.error('reinstateValet error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};

// ---------------------------------------------------------------------
// Data package for sending to insurance providers
// ---------------------------------------------------------------------

/**
 * GET /api/admin/valets/onboarding/:userId/data-package
 *
 * Returns the structured "package" of contractor data Rishi forwards to
 * insurance providers off-system. Includes signed URLs for the DL
 * photos (15-min expiry — generate fresh on each download).
 *
 * The frontend renders this as a viewable / copyable / downloadable
 * block in the dashboard.
 */
exports.getDataPackage = async (req, res) => {
    try {
        const { userId } = req.params;
        const user = await User.findById(userId).lean();
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        if (!user.isValet) return res.status(400).json({ success: false, message: 'Not a valet account' });

        const docs = await ValetDocument
            .find({ userId, status: 'stored' })
            .lean();

        // Generate signed URLs for each current doc
        const documents = await Promise.all(
            docs.map(async (d) => ({
                type: d.type,
                viewUrl: await firebaseStorage.getSignedUrl(d.s3Key, 15),
                mimeType: d.mimeType,
                uploadedAt: d.uploadedAt,
            }))
        );

        return res.json({
            success: true,
            generatedAt: new Date(),
            urlExpiresInMinutes: 15,
            valet: {
                userId: user._id,
                firstName: user.firstName,
                lastName: user.lastName,
                phone: user.phone,
                email: user.email,
                signedUpAt: user.createdAt,
            },
            backgroundCheck: {
                status: user.backgroundCheck?.status,
                certnApplicationId: user.backgroundCheck?.certnApplicationId,
                certnResult: user.backgroundCheck?.certnResult,
                completedAt: user.backgroundCheck?.completedAt,
            },
            documents,
            onboarding: {
                currentStatus: user.valetOnboardingStatus,
                packagePreparedAt: user.providerAuthorization?.packagePreparedAt,
                authorizedAt: user.providerAuthorization?.authorizedAt,
            },
        });
    } catch (err) {
        console.error('getDataPackage error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};
