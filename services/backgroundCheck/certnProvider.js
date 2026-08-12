/**
 * Certn provider — wraps Certn (https://certn.co) for valet background checks.
 * Behavior preserved from the pre-refactor controller; see backgroundCheckController.js
 * git history for the original implementation.
 *
 * Two checks are requested: US Criminal Record + Motor Vehicle Records (MVR),
 * since valets drive customers' cars.
 */

const axios = require('axios');

// Region-scoped base URL. Sandbox keys start with `test_`.
//   - Sandbox:    https://api.sandbox.certn.co
//   - Production: https://api.ca.certn.co (North America region)
function getBaseUrl() {
    return (process.env.CERTN_API_KEY || '').startsWith('test_')
        ? 'https://api.sandbox.certn.co'
        : 'https://api.ca.certn.co';
}

const certnClient = axios.create({ timeout: 15000 });

function isConfigured() {
    return !!process.env.CERTN_API_KEY;
}

/**
 * Create a Certn application for the given user.
 * @returns {Promise<{ applicationId: string }>}
 */
async function initiate({ user, body }) {
    const payload = {
        applicant: {
            first_name: body.firstName,
            last_name: body.lastName,
            email: body.email,
            date_of_birth: body.dob, // YYYY-MM-DD
            social_security_number: body.ssn,
            driver_license_number: body.driverLicense,
            driver_license_state: body.driverLicenseState,
            address: {
                line1: body.addressStreet,
                city: body.addressCity,
                state: body.addressState,
                postal_code: body.addressZip,
                country: 'US',
            },
        },
        services: ['us_criminal_record', 'motor_vehicle_record'],
        webhook_url: `${process.env.PUBLIC_BACKEND_URL || 'https://api.valetnetwork.co'}/api/webhooks/certn`,
        external_id: user._id.toString(),
    };

    const res = await certnClient.post(`${getBaseUrl()}/v1/applications/`, payload, {
        headers: {
            Authorization: `Token ${process.env.CERTN_API_KEY}`,
            'Content-Type': 'application/json',
        },
    });

    const applicationId = res.data?.id || res.data?.application_id;
    return { applicationId };
}

/**
 * Parse a Certn webhook payload. Liberal — accepts shape variations so different
 * Certn payload versions don't break the handler.
 *
 * @returns {{ externalUserId, providerAppId, rawStatus, mappedStatus } | null}
 */
function parseWebhook(req) {
    const body = req.body || {};
    const data = body.data || body.application || body;
    const externalUserId = data.external_id || data.externalId || null;
    const providerAppId = data.id || data.application_id || null;
    const rawStatus = (data.status || data.result || '').toLowerCase();

    if (!rawStatus && !externalUserId && !providerAppId) return null;

    let mappedStatus = 'pending';
    if (['cleared', 'clear', 'passed'].includes(rawStatus)) {
        mappedStatus = 'passed';
    } else if (['consider', 'failed', 'rejected', 'declined'].includes(rawStatus)) {
        mappedStatus = 'failed';
    } else if (['expired', 'cancelled'].includes(rawStatus)) {
        mappedStatus = 'expired';
    }

    return { externalUserId, providerAppId, rawStatus, mappedStatus };
}

module.exports = {
    name: 'certn',
    requiredInitiateFields: [
        'userId',
        'firstName',
        'lastName',
        'email',
        'dob',
        'ssn',
        'driverLicense',
        'driverLicenseState',
        'addressStreet',
        'addressCity',
        'addressState',
        'addressZip',
    ],
    isConfigured,
    initiate,
    parseWebhook,
};
