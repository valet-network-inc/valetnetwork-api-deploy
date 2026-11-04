const mongoose = require('mongoose');

/**
 * AccountLink — two customer accounts that share their parks and a plan.
 *
 * A customer asked "How can Peter and I share an account?" The answer is a
 * pair: both keep their own login, profile, card and history, and each sees
 * the other's parks. A plan held by either of them covers both, one park at a
 * time (services/accountLinks.js holds every rule that reads this).
 *
 * THE HANDSHAKE. Either phone shows a QR; the other scans it. Whoever SHOWED
 * the code is the inviter and taps Authorize — that tap is the one
 * verification step. So:
 *
 *   open     — the inviter minted a code; nobody has scanned it
 *   pending  — someone scanned it (`invitee` set), waiting on Authorize
 *   active   — linked
 *   revoked  — declined, unlinked by either side, or an account was deleted
 *   expired  — the code or the request ran out, or a newer code replaced it
 *
 * The token in the QR is never stored, only its sha256, exactly as the
 * doorman share link does it (controllers/shareController.js).
 *
 * Deliberately no car on this document. A plan will later take a list of cars,
 * and that belongs on the plan, not on the pair.
 */
const AccountLinkSchema = new mongoose.Schema(
    {
        // Showed the QR; taps Authorize.
        inviter: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        // Scanned it. Unset until the code is claimed.
        invitee: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        // Both ids once the code is claimed ([inviter, invitee]). This is
        // what every "who is linked to whom" read queries, and what the
        // one-link-per-account index below is built on.
        members: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'User',
            },
        ],
        status: {
            type: String,
            enum: ['open', 'pending', 'active', 'revoked', 'expired'],
            default: 'open',
            required: true,
        },
        // sha256 (hex) of the token in the QR. Unset once the link is
        // settled, so a spent token can never be looked up again.
        tokenHash: { type: String },
        tokenExpiresAt: { type: Date },
        claimedAt: { type: Date },
        authorizedAt: { type: Date },
        revokedAt: { type: Date },
        revokedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
    },
    { timestamps: true }
);

AccountLinkSchema.index({ tokenHash: 1 }, { unique: true, sparse: true });
// "My open code / my pending request": minting, the status read, expiry.
// Compound rather than `index: true` on the field, which Mongoose would treat
// as a duplicate of the partial unique index below and skip building one.
AccountLinkSchema.index({ inviter: 1, status: 1 });
AccountLinkSchema.index({ invitee: 1, status: 1 });

// One active link per account, even under a race: two Authorize taps landing
// together cannot both win.
//
// The per-side indexes stop an account being the inviter on two active links,
// or the invitee on two. They cannot stop it being the inviter on one and the
// invitee on another — which is a real race: show a code, scan somebody
// else's, and have both approved in the same second. `members` closes that.
// A unique index over an array is enforced per element across documents, so
// no id can sit in two active links whichever side it was on.
AccountLinkSchema.index(
    { inviter: 1 },
    { unique: true, partialFilterExpression: { status: 'active' } }
);
AccountLinkSchema.index(
    { invitee: 1 },
    { unique: true, partialFilterExpression: { status: 'active' } }
);
AccountLinkSchema.index(
    { members: 1 },
    { unique: true, partialFilterExpression: { status: 'active' } }
);

module.exports = mongoose.model('AccountLink', AccountLinkSchema);
