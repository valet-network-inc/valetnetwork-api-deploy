/**
 * providerNotifyService
 *
 * Auto-sends a contractor's data package to insurance providers (and/or
 * Rishi as a placeholder) when the valet transitions to
 * `pending_provider_approval`. Triggered from valetStatusService.
 *
 * Send strategy:
 *   - Read active recipients from ProviderRecipient collection
 *   - Pull personal info from Certn (TODO once Certn API is configured)
 *   - Generate fresh signed URLs for DL photos (7-day expiry — providers
 *     may not click immediately)
 *   - Format an email containing summary + signed URLs
 *   - Resend.send() with retry up to 3 attempts (5s, then 30s backoff)
 *   - Log every attempt to User.providerNotifications
 *
 * Fire-and-forget: callers don't await the notification. We don't want a
 * Resend hiccup to block status transitions or upload responses.
 *
 * Security note: today the only recipient is Rishi (placeholder). When
 * external provider emails are added, the email body will be carrying
 * sensitive PII (SSN, DOB, DL number once Certn API is wired in). Email
 * is not a secure channel for SSN-level data — revisit delivery method
 * (encrypted PDF, secure portal upload, S/MIME) before external
 * recipients are added.
 */

const axios = require('axios');

const User = require('../models/User');
const ValetDocument = require('../models/ValetDocument');
const ProviderRecipient = require('../models/ProviderRecipient');
const firebaseStorage = require('./firebaseStorage');

const RESEND_API = 'https://api.resend.com/emails';
const RESEND_FROM = process.env.RESEND_FROM || 'noreply@valetnetwork.co';

const SIGNED_URL_EXPIRY_MINUTES = 60 * 24 * 7;     // 7 days, so providers have time to click
const MAX_ATTEMPTS = 3;
const BACKOFFS_MS = [5000, 30000];                  // gap before retry attempts 2, 3

/**
 * Build the data package payload for a valet.
 * Currently uses what's stored on our side. When the Certn API is wired
 * in, this is where we'd merge in DOB / SSN / DL number / address /
 * email pulled live from Certn.
 */
const buildPackage = async (user) => {
    const docs = await ValetDocument
        .find({ userId: user._id, status: 'stored' })
        .lean();

    const documents = await Promise.all(
        docs.map(async (d) => ({
            type: d.type,
            viewUrl: await firebaseStorage.getSignedUrl(d.s3Key, SIGNED_URL_EXPIRY_MINUTES),
            uploadedAt: d.uploadedAt,
        }))
    );

    return {
        valet: {
            userId: user._id,
            firstName: user.firstName,
            lastName: user.lastName,
            phone: user.phone,
            signedUpAt: user.createdAt,
        },
        backgroundCheck: {
            status: user.backgroundCheck?.status,
            certnApplicationId: user.backgroundCheck?.certnApplicationId,
            completedAt: user.backgroundCheck?.completedAt,
        },
        documents,
        // TODO: pull DOB / SSN / DL number / address / email from Certn API
        // once the certn-data-retrieval endpoint is confirmed with the rep.
        // certnPersonalInfo: await certnApi.getApplicationDetails(...),
    };
};

/**
 * Render the email subject + HTML body from the package.
 */
const renderEmail = (pkg) => {
    const fullName = `${pkg.valet.firstName || ''} ${pkg.valet.lastName || ''}`.trim() || 'Unnamed valet';
    const docList = pkg.documents.map((d) => `
        <li>
            <strong>${d.type.replace(/_/g, ' ')}</strong>
            — uploaded ${new Date(d.uploadedAt).toLocaleString()}
            — <a href="${d.viewUrl}">View document (link valid 7 days)</a>
        </li>
    `).join('');

    const subject = `[Valet Network] ${fullName} ready for provider review`;

    const html = `
        <h2>Contractor ready for provider approval</h2>
        <p>A new contractor has completed onboarding and is awaiting provider approval.</p>
        <h3>Contractor</h3>
        <ul>
            <li><strong>Name:</strong> ${fullName}</li>
            <li><strong>Phone:</strong> ${pkg.valet.phone || '—'}</li>
            <li><strong>Signed up:</strong> ${pkg.valet.signedUpAt ? new Date(pkg.valet.signedUpAt).toLocaleString() : '—'}</li>
            <li><strong>User ID:</strong> ${pkg.valet.userId}</li>
        </ul>
        <h3>Background check (Certn)</h3>
        <ul>
            <li><strong>Status:</strong> ${pkg.backgroundCheck.status || '—'}</li>
            <li><strong>Certn application ID:</strong> ${pkg.backgroundCheck.certnApplicationId || '—'}</li>
            <li><strong>Completed:</strong> ${pkg.backgroundCheck.completedAt ? new Date(pkg.backgroundCheck.completedAt).toLocaleString() : '—'}</li>
        </ul>
        <h3>Documents</h3>
        <ul>${docList || '<li>No documents on file.</li>'}</ul>
        <p style="color:#888;font-size:12px;">
            Personal info (DOB, SSN, DL number, address) will appear here once the Certn API integration is enabled.
        </p>
    `;

    return { subject, html };
};

/**
 * Single send attempt. Throws on failure (caller handles retry).
 */
const sendOnce = async (recipientEmails, subject, html) => {
    if (!process.env.RESEND_API_KEY) {
        throw new Error('RESEND_API_KEY not configured');
    }
    await axios.post(
        RESEND_API,
        {
            from: RESEND_FROM,
            to: recipientEmails,
            subject,
            html,
        },
        {
            headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            timeout: 15000,
        }
    );
};

/**
 * Append a notification record (success or failure) to User.providerNotifications.
 */
const logAttempt = async (userId, { recipients, success, attempts, error }) => {
    try {
        await User.findByIdAndUpdate(userId, {
            $push: {
                providerNotifications: {
                    sentAt: new Date(),
                    recipients,
                    success,
                    attempts,
                    error,
                },
            },
        });
    } catch (logErr) {
        console.error('providerNotify: failed to write log entry', logErr.message);
    }
};

/**
 * Public entry point. Fire-and-forget — callers don't need to await.
 *
 * @param {string|ObjectId} userId
 */
exports.notifyProvidersForValet = async (userId) => {
    try {
        const user = await User.findById(userId);
        if (!user) {
            console.warn('providerNotify: user not found', userId);
            return;
        }

        const recipients = await ProviderRecipient.find({ active: true }).lean();
        if (recipients.length === 0) {
            console.warn(
                'providerNotify: no active recipients configured for valet',
                userId.toString(),
                '— add at least one in the admin dashboard'
            );
            await logAttempt(user._id, {
                recipients: [],
                success: false,
                attempts: 0,
                error: 'No active recipients configured',
            });
            return;
        }

        const recipientEmails = recipients.map((r) => r.email);
        const pkg = await buildPackage(user);
        const { subject, html } = renderEmail(pkg);

        // Retry loop — up to MAX_ATTEMPTS attempts with backoff between them
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            try {
                await sendOnce(recipientEmails, subject, html);
                await logAttempt(user._id, {
                    recipients: recipientEmails,
                    success: true,
                    attempts: attempt,
                });
                console.log(
                    `providerNotify: sent for valet ${user._id} on attempt ${attempt} to ${recipientEmails.length} recipient(s)`
                );
                return;
            } catch (err) {
                console.warn(
                    `providerNotify: attempt ${attempt}/${MAX_ATTEMPTS} failed for valet ${user._id}:`,
                    err.message
                );
                if (attempt < MAX_ATTEMPTS) {
                    await new Promise((r) => setTimeout(r, BACKOFFS_MS[attempt - 1]));
                } else {
                    // Final failure — record it
                    await logAttempt(user._id, {
                        recipients: recipientEmails,
                        success: false,
                        attempts: attempt,
                        error: err.message,
                    });
                }
            }
        }
    } catch (outerErr) {
        // Catch-all so this service can never crash a status transition
        console.error('providerNotify: unexpected error', outerErr);
        try {
            await logAttempt(userId, {
                recipients: [],
                success: false,
                attempts: 0,
                error: outerErr.message,
            });
        } catch (_) {
            // best effort
        }
    }
};
