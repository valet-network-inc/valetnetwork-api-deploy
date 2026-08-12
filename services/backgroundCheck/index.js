/**
 * Background check provider dispatcher.
 *
 * Selects the active provider based on BACKGROUND_CHECK_PROVIDER env var.
 * Defaults to 'certn' so production behavior is unchanged until the var is
 * flipped to 'yardstik' during the migration cutover.
 *
 * Each provider exports the same shape:
 *   name                  : string — 'certn' | 'yardstik'
 *   requiredInitiateFields: string[] — keys validated on /initiateBackgroundCheck
 *   initiate({ user, body }) → Promise<{ applicationId, message? }>
 *   parseWebhook(req)        → { externalUserId, providerAppId, rawStatus, mappedStatus } | null
 *   verifyWebhookSignature?(req) → boolean (optional; only used if provider supports it)
 *   isConfigured()           → boolean
 */

const certn = require('./certnProvider');
const yardstik = require('./yardstikProvider');

const PROVIDERS = { certn, yardstik };

function getActiveProvider() {
    const key = (process.env.BACKGROUND_CHECK_PROVIDER || 'certn').toLowerCase();
    const provider = PROVIDERS[key];
    if (!provider) {
        throw new Error(
            `Unknown BACKGROUND_CHECK_PROVIDER "${key}". Set it to one of: ${Object.keys(PROVIDERS).join(', ')}.`
        );
    }
    return provider;
}

module.exports = {
    getActiveProvider,
    getProviderByName: (name) => PROVIDERS[name],
};
