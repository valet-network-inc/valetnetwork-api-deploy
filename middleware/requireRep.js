/**
 * The rep portal's door (spec v2, 16-17). A rep signs in on the web with a
 * text code (Firebase phone auth); the ID token's phone number is matched to
 * a Rep that Rishi added in admin. Nothing but /me and the agreement works
 * until the current agreement is signed. Admin is a rep with role 'admin'.
 */
const admin = require('firebase-admin');
const Rep = require('../models/Rep');
const { phoneCode } = require('../services/phoneCodes');
const repAgreement = require('../services/repAgreement');

async function verifiedToken(req) {
    const header = req.headers?.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
    if (!match) return null;
    try {
        return await admin.auth().verifyIdToken(match[1]);
    } catch (err) {
        console.warn('requireRep: token did not verify —', err.message);
        return null;
    }
}

function requireRep({ signed = true, adminOnly = false } = {}) {
    return async function (req, res, next) {
        try {
            const token = await verifiedToken(req);
            if (!token) return res.status(401).json({ success: false, message: 'Sign in again to continue.' });
            const phone = phoneCode(token.phone_number);
            const rep = phone ? await Rep.findOne({ phone, active: { $ne: false } }) : null;
            if (!rep) {
                return res.status(403).json({
                    success: false,
                    code: 'NOT_A_REP',
                    message: 'This number isn’t set up as a Valet Network rep. Rishi adds your number before you can sign in.',
                });
            }
            if (!rep.firebaseUid) {
                rep.firebaseUid = token.uid;
                await rep.save().catch(() => {});
            }
            if (adminOnly && rep.role !== 'admin') {
                return res.status(403).json({ success: false, code: 'NOT_ADMIN', message: 'Only Rishi can do that.' });
            }
            // Admin (Rishi) is Valet Network's side of the agreement, not a rep.
            if (signed && rep.role !== 'admin' && !(await repAgreement.isSignedNow(rep))) {
                return res.status(403).json({
                    success: false,
                    code: 'AGREEMENT_REQUIRED',
                    message: 'Sign the commission agreement to open your portal.',
                });
            }
            req.rep = rep;
            return next();
        } catch (err) {
            console.error('requireRep failed:', err.message);
            return res.status(500).json({ success: false, message: 'Could not verify your account.' });
        }
    };
}

module.exports = requireRep;
module.exports.verifiedToken = verifiedToken;
