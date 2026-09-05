/**
 * "Prove you are the account you are naming."
 *
 * Several endpoints read a `userId` out of the body or the query string and
 * act on it with no proof at all. A customer ObjectId is not a secret — the
 * pending-order feed publishes them — so those endpoints answer to anybody.
 *
 * This is the smallest thing that closes one: verify the caller's Firebase ID
 * token and require its uid to match the `firebaseUid` on the user they named.
 * Both clients already send the token (the iOS app has an axios interceptor
 * that attaches it to every call to our API; the web app attaches it in
 * `request()`), so mounting this in front of a route costs a signed-in caller
 * nothing.
 *
 * IT DOES COST A CALLER WITH NO TOKEN EVERYTHING, so mount it deliberately.
 * A route the web app calls cannot take this until we are sure the token is
 * arriving there for every signed-in customer — the web session is restored
 * from localStorage, and a stored session can outlive its Firebase one.
 */
const admin = require('firebase-admin');
const User = require('../models/User');

/** The verified Firebase uid on this request, or null. Never throws. */
async function callerFirebaseUid(req) {
    const header = req.headers?.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
    if (!match) return null;
    try {
        const decoded = await admin.auth().verifyIdToken(match[1]);
        return decoded?.uid || null;
    } catch (err) {
        // An expired token is the ordinary case. Logged at warn so a server
        // that genuinely cannot reach Google is still visible.
        console.warn('requireSelf: token did not verify —', err.message);
        return null;
    }
}

/**
 * @param {(req) => string|undefined} pick  where the userId lives on this route
 */
function requireSelf(pick = (req) => req.body?.userId || req.query?.userId) {
    return async function (req, res, next) {
        try {
            const namedId = pick(req);
            if (!namedId) {
                return res.status(400).json({ success: false, message: 'userId is required' });
            }

            const uid = await callerFirebaseUid(req);
            if (!uid) {
                return res.status(401).json({
                    success: false,
                    message: 'Sign in again to continue.',
                });
            }

            const user = await User.findById(namedId).select('firebaseUid').lean();
            // One answer for "no such account" and "not your account": telling
            // them apart is a way to enumerate who exists.
            if (!user || !user.firebaseUid || user.firebaseUid !== uid) {
                return res.status(403).json({
                    success: false,
                    message: 'That is not your account.',
                });
            }

            req.callerUserId = String(user._id);
            return next();
        } catch (err) {
            console.error('requireSelf failed:', err.message);
            return res.status(500).json({ success: false, message: 'Could not verify your account.' });
        }
    };
}

module.exports = requireSelf;
module.exports.callerFirebaseUid = callerFirebaseUid;

/**
 * "You are a signed-in valet."
 *
 * For routes that name nobody — the open job board is the one that matters.
 * It published every pending order, including each customer's ObjectId, their
 * pickup address and their licence plate, to anyone who asked. Those ObjectIds
 * are what made the other unauthenticated endpoints worth attacking: they are
 * the input those take and trust.
 *
 * Safe to enforce on the board because the valet app is its only caller, and
 * it has attached a token to every request since 2.2.0.
 */
function requireValet() {
    return async function (req, res, next) {
        try {
            const uid = await callerFirebaseUid(req);
            if (!uid) {
                return res.status(401).json({ success: false, message: 'Sign in again to continue.' });
            }
            const user = await User.findOne({ firebaseUid: uid })
                .select('isValet isDeleted')
                .lean();
            if (!user || user.isDeleted || !user.isValet) {
                return res.status(403).json({ success: false, message: 'Valets only.' });
            }
            req.callerUserId = String(user._id);
            return next();
        } catch (err) {
            console.error('requireValet failed:', err.message);
            return res.status(500).json({ success: false, message: 'Could not verify your account.' });
        }
    };
}

module.exports.requireValet = requireValet;

/**
 * "You are the customer this ORDER belongs to."
 *
 * For routes that name an order rather than a person — tipping, and minting a
 * payment intent. Both move money on a saved card, and both took the orderId
 * alone: order ids are handed out with the order documents themselves, so a
 * stranger holding one could tip a valet off somebody else's card, or mint a
 * payment intent against their booking.
 *
 * @param {(req) => string|undefined} pickOrderId
 */
function requireOrderOwner(pickOrderId = (req) => req.params?.orderId || req.body?.orderId) {
    return async function (req, res, next) {
        try {
            const orderId = pickOrderId(req);
            if (!orderId) {
                return res.status(400).json({ success: false, message: 'orderId is required' });
            }

            const uid = await callerFirebaseUid(req);
            if (!uid) {
                return res.status(401).json({ success: false, message: 'Sign in again to continue.' });
            }

            const Order = require('../models/Order');
            const order = await Order.findById(orderId).select('customer').lean();
            // Same answer for "no such order" and "not your order", so this
            // cannot be used to find out which order ids are real.
            if (!order) {
                return res.status(403).json({ success: false, message: 'That is not your order.' });
            }

            const owner = await User.findById(order.customer).select('firebaseUid').lean();
            if (!owner || !owner.firebaseUid || owner.firebaseUid !== uid) {
                return res.status(403).json({ success: false, message: 'That is not your order.' });
            }

            req.callerUserId = String(owner._id);
            return next();
        } catch (err) {
            console.error('requireOrderOwner failed:', err.message);
            return res.status(500).json({ success: false, message: 'Could not verify your account.' });
        }
    };
}

module.exports.requireOrderOwner = requireOrderOwner;
