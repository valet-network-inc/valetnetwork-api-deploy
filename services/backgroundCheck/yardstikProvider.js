/**
 * Yardstik provider — uses the invitation flow.
 *
 * Yardstik emails the candidate a link to its hosted intake form, where
 * the candidate enters SSN/DOB/license/etc. and signs the FCRA disclosure.
 * Our backend never touches that PII — we only see masked fields on the
 * report payload. This is the security/compliance posture we want.
 *
 * Required env vars (set in .env.<NODE_ENV>):
 *   YARDSTIK_API_KEY              — sandbox or production key
 *   YARDSTIK_BASE_URL             — https://api.yardstik-staging.com | https://api.yardstik.com
 *   YARDSTIK_PACKAGE_SYSTEM_NAME  — e.g. "idv_premium_mvr" (sandbox) or
 *                                    "idv_basic_plussurcharges_mvr_sequential" (prod)
 *
 * Optional:
 *   YARDSTIK_WEBHOOK_SIGNATURE_KEY — for HMAC verification of inbound webhooks
 */

const axios = require('axios');
const crypto = require('crypto');

const TERMINAL_STATUSES = new Set([
    'clear', 'pass', 'proceed',
    'consider', 'fail', 'final_adverse',
    'expired', 'canceled',
]);

function isConfigured() {
    return !!process.env.YARDSTIK_API_KEY;
}

function getBaseUrl() {
    return process.env.YARDSTIK_BASE_URL || 'https://api.yardstik-staging.com';
}

function authHeader() {
    return `Account ${process.env.YARDSTIK_API_KEY}`;
}

const yardstikClient = axios.create({ timeout: 15000 });

// account_package_id cache. The package list rarely changes, so we resolve
// the configured system_name to a UUID once per process.
let cachedAccountPackageId = null;

async function getAccountPackageId() {
    if (cachedAccountPackageId) return cachedAccountPackageId;
    const systemName = process.env.YARDSTIK_PACKAGE_SYSTEM_NAME;
    if (!systemName) {
        throw new Error('YARDSTIK_PACKAGE_SYSTEM_NAME not set');
    }
    const res = await yardstikClient.get(`${getBaseUrl()}/packages`, {
        headers: { Authorization: authHeader(), Accept: 'application/json' },
    });
    const pkg = (res.data || []).find((p) => p.package_system_name === systemName);
    if (!pkg) {
        const available = (res.data || []).map((p) => p.package_system_name).join(', ');
        throw new Error(
            `Yardstik package "${systemName}" not configured on this account. Available: ${available || 'none'}.`
        );
    }
    cachedAccountPackageId = pkg.id;
    return cachedAccountPackageId;
}

/**
 * Create a Yardstik candidate + invitation. Yardstik emails the candidate
 * a link to complete intake on their hosted form.
 *
 * @returns {Promise<{ applicationId: string, candidateId: string, invitationId: string, applyUrl?: string, message: string }>}
 */
async function initiate({ user, body }) {
    const accountPackageId = await getAccountPackageId();

    // Step 1: create candidate (tag with our user ID for webhook correlation)
    const candidateRes = await yardstikClient.post(
        `${getBaseUrl()}/candidates`,
        {
            first_name: body.firstName,
            last_name: body.lastName,
            email: body.email,
            external_id: user._id.toString(),
        },
        {
            headers: {
                Authorization: authHeader(),
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
        }
    );
    const candidateId = candidateRes.data?.id;
    if (!candidateId) {
        throw new Error('Yardstik candidate creation returned no id');
    }

    // Step 2: create invitation. Yardstik emails the candidate AND creates the
    // corresponding report automatically. The response includes report.id which
    // is what we store as our applicationId.
    const invitationRes = await yardstikClient.post(
        `${getBaseUrl()}/invitations`,
        {
            account_package_id: accountPackageId,
            candidate_id: candidateId,
        },
        {
            headers: {
                Authorization: authHeader(),
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
        }
    );

    const invitation = invitationRes.data || {};
    const reportId = invitation.report?.id;
    if (!reportId) {
        throw new Error('Yardstik invitation creation returned no report id');
    }

    return {
        applicationId: reportId,
        candidateId,
        invitationId: invitation.id,
        applyUrl: invitation.meta?.apply || null,
        message:
            'Background check invitation sent. Check your email to complete your background check.',
    };
}

/**
 * Resend / refresh an invitation. Yardstik's semantics:
 *   - PATCH /invitations/{id}/refresh only works on `expired` or `canceled`
 *     invitations (per Yardstik API docs). Active invitations cannot be refreshed.
 *   - For active invitations, the existing email + apply URL are still valid;
 *     there's no Yardstik primitive for "just resend the email." We return
 *     the existing applyUrl so the iOS app can show "Open form now" without
 *     bothering the candidate's inbox.
 *
 * Returns `refreshed: true` when a new email was triggered, false when the
 * existing invitation is still active and the candidate should use what they
 * already have. Callers translate this into the user-facing message.
 *
 * @returns {Promise<{ invitationId, applyUrl?, expiresAt?, refreshed, status }>}
 */
async function resendInvitation({ invitationId }) {
    if (!invitationId) {
        throw new Error('invitationId required for resend');
    }
    const headers = {
        Authorization: authHeader(),
        Accept: 'application/json',
        'Content-Type': 'application/json',
    };

    // 1. Fetch current invitation state.
    const current = await yardstikClient.get(
        `${getBaseUrl()}/invitations/${invitationId}`,
        { headers }
    );
    const inv = current.data || {};
    const status = (inv.status || '').toLowerCase();

    // Candidate already completed the check — nothing to resend.
    if (status === 'completed') {
        const err = new Error('Background check already completed; nothing to resend.');
        err.statusCode = 409;
        throw err;
    }

    // 2. Expired/canceled → refresh triggers a new email.
    if (status === 'expired' || status === 'canceled') {
        const refreshRes = await yardstikClient.patch(
            `${getBaseUrl()}/invitations/${invitationId}/refresh`,
            {},
            { headers }
        );
        const refreshed = refreshRes.data || {};
        return {
            invitationId: refreshed.id,
            applyUrl: refreshed.meta?.apply || null,
            expiresAt: refreshed.expires_at || null,
            refreshed: true,
            status: (refreshed.status || '').toLowerCase(),
        };
    }

    // 3. Active invitation — just return the existing apply URL. No new email.
    return {
        invitationId,
        applyUrl: inv.meta?.apply || null,
        expiresAt: inv.expires_at || null,
        refreshed: false,
        status,
    };
}

/**
 * Verify HMAC-SHA256 signature on inbound Yardstik webhook.
 * Returns true if signature key isn't configured (dev convenience — logs a warning).
 */
function verifyWebhookSignature(req) {
    const signatureKey = process.env.YARDSTIK_WEBHOOK_SIGNATURE_KEY;
    if (!signatureKey) {
        console.warn(
            'Yardstik webhook: YARDSTIK_WEBHOOK_SIGNATURE_KEY not set — accepting unsigned webhook. ' +
            'Configure WEBHOOK_SIGNATURE API key in Yardstik dashboard before production.'
        );
        return true;
    }
    const provided = req.headers['x-yardstik-webhook-signature'];
    if (!provided) return false;

    // Express body-parser already parsed the JSON; we need the raw bytes for HMAC.
    // server.js must mount express.json with { verify: (req, _, buf) => { req.rawBody = buf } }
    // for this provider's webhook route so req.rawBody is available.
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
    const computed = crypto
        .createHmac('sha256', signatureKey)
        .update(rawBody)
        .digest('hex');

    // timing-safe compare
    try {
        return crypto.timingSafeEqual(
            Buffer.from(computed, 'hex'),
            Buffer.from(provided, 'hex')
        );
    } catch {
        return false;
    }
}

/**
 * Parse a Yardstik webhook. Yardstik POSTs the resource that changed (report,
 * invitation, candidate). We only care about report events here — the report's
 * status drives our internal state machine.
 *
 * The candidate (with our external_id) is nested on the report. If not present
 * we fall back to looking up by report.id matching backgroundCheck.certnApplicationId.
 *
 * @returns {{ externalUserId, providerAppId, candidateId, rawStatus, mappedStatus } | null}
 */
function parseWebhook(req) {
    const body = req.body || {};

    // Diagnostic log so we can audit unknown payload shapes from Yardstik
    // without having to redeploy. Keep until the matching logic is stable
    // across all known event types.
    console.log('Yardstik webhook payload:', JSON.stringify(body));

    // Yardstik wraps events in different shapes — be liberal. The relevant
    // resource may be at body.data, body.report, or the body itself.
    const data = body.data || body.report || body;

    // We only care about report-bearing payloads. If we can't find a status
    // or an ID, ignore.
    //
    // Yardstik webhook envelope shape: `id` is the *event* ID, not the report
    // ID. The report ID lives at `resource_id` (with `resource_type === 'report'`).
    // Matching on `data.id` would never find the user because we store the
    // report ID in `backgroundCheck.certnApplicationId` at initiate time.
    const providerAppId =
        (data.resource_type === 'report' && data.resource_id) ||
        data.report_id ||
        (data.report && data.report.id) ||
        null;
    const rawStatus = (data.status || (data.report && data.report.status) || '').toLowerCase();

    if (!providerAppId && !rawStatus) return null;

    // external_id is the most-reliable correlator (we set it at candidate
    // creation), but Yardstik's webhook payloads don't consistently include
    // it. Try every nesting we've observed.
    const candidate = data.candidate || (data.report && data.report.candidate) || {};
    const externalUserId =
        candidate.external_id ||
        data.external_id ||
        body.external_id ||
        null;

    // candidate_id is the secondary correlator — we store it on the user
    // record at initiate time, then match by it here. Yardstik webhooks
    // include it more reliably than external_id.
    const candidateId =
        data.candidate_id ||
        candidate.id ||
        (data.report && data.report.candidate_id) ||
        body.candidate_id ||
        null;

    let mappedStatus = 'pending';
    if (['clear', 'pass', 'proceed'].includes(rawStatus)) {
        mappedStatus = 'passed';
    } else if (['consider', 'fail', 'final_adverse'].includes(rawStatus)) {
        mappedStatus = 'failed';
    } else if (['expired', 'canceled'].includes(rawStatus)) {
        mappedStatus = 'expired';
    }

    // Only act on terminal statuses. Intermediate statuses (queued/processing/
    // pending/etc.) are noise — the report's still cooking. Acting on a
    // non-terminal status would mis-mark the valet as still pending after
    // an earlier passed result.
    const isTerminal = TERMINAL_STATUSES.has(rawStatus);
    if (!isTerminal) {
        return { externalUserId, providerAppId, candidateId, rawStatus, mappedStatus, terminal: false };
    }

    return { externalUserId, providerAppId, candidateId, rawStatus, mappedStatus, terminal: true };
}

/**
 * Fetch a Yardstik report by ID. Used as a webhook-matching fallback:
 * if a webhook arrives and we can't find the user via external_id or
 * candidate_id in the payload, we hit the API for the authoritative
 * record (the report endpoint returns the candidate's external_id
 * reliably).
 *
 * Returns null on 404 / any error rather than throwing — webhook
 * matching is best-effort and shouldn't crash on transient API hiccups.
 *
 * @param {string} reportId
 * @returns {Promise<{ externalUserId: string|null, candidateId: string|null } | null>}
 */
async function fetchReportCorrelators(reportId) {
    if (!reportId) return null;
    try {
        const res = await yardstikClient.get(
            `${getBaseUrl()}/reports/${reportId}`,
            { headers: { Authorization: authHeader(), Accept: 'application/json' } }
        );
        const r = res.data || {};
        return {
            externalUserId: r.external_id || r.candidate?.external_id || null,
            candidateId: r.candidate_id || r.candidate?.id || null,
        };
    } catch (err) {
        console.warn(`Yardstik fetchReportCorrelators(${reportId}) failed:`, err.message);
        return null;
    }
}

module.exports = {
    name: 'yardstik',
    // Invitation flow only needs name + email. Yardstik collects SSN/DOB/license
    // on its hosted form — we never see that data.
    requiredInitiateFields: ['userId', 'firstName', 'lastName', 'email'],
    isConfigured,
    initiate,
    resendInvitation,
    parseWebhook,
    verifyWebhookSignature,
    fetchReportCorrelators,
};
