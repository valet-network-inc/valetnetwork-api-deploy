// The one Stripe client the subscription code talks to.
//
// Every controller used to build its own at require time from STRIPE_API_KEY.
// That is fine for a server, but it means a test can only swap Stripe out by
// mocking the whole `stripe` module before anything is required. The pricing,
// promo and waitlist code reach Stripe through get() instead, so a test can
// hand it a stub with set() and take it back with reset().
//
// Unset STRIPE_API_KEY keeps meaning what it always meant: get() returns null
// and every caller answers "payment service unavailable" rather than crashing.

let client;
let overridden = false;

function get() {
    if (overridden) return client;
    if (client === undefined) {
        const key = process.env.STRIPE_API_KEY;
        client = key ? require('stripe')(key) : null;
    }
    return client;
}

/** Tests: use this object (or null) as Stripe until reset(). */
function set(stub) {
    client = stub;
    overridden = true;
}

/** Back to the key in the environment, read fresh on the next get(). */
function reset() {
    client = undefined;
    overridden = false;
}

module.exports = { get, set, reset };
