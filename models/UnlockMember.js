const mongoose = require('mongoose');

// One person's place in a neighborhood (spec v2, 2026-10-09).
//
// Neighborhood unlocks replace waitlists. A neighborhood unlocks when it has
// 10 members with a card saved, counting every rep and every self-signup, so
// both kinds of signup are rows of this one model:
//
//   source 'self' — the customer subscribed in the app or on the web, in a
//                   neighborhood that has not unlocked: a SetupIntent saved
//                   their card and nothing was charged. Also written, already
//                   'active', for a customer who subscribed after it unlocked,
//                   so "Total subscribers" counts everyone.
//   source 'rep'  — a rep created it for the customer in the portal and sent
//                   them the /join/<token> link. It has no User until the
//                   customer opens the link signed in.
//
// The life of a row:
//
//   invited ─┐                 (rep-created, no card yet)
//   pending_card ─┤            (self-signup, SetupIntent not confirmed)
//                 ▼
//              waiting          card saved, neighborhood locked
//                 │  ← the 10th card unlocks it: start date = 3 days on, 8 AM ET
//              scheduled        card saved, start date set
//                 │  ← the start job, one charge per member
//              starting ──► active (Subscription made and paid)
//                       └─► failed (the charge did not go through; a human looks)
//
//   declined  "Not for me" on an invite
//   left      "Cancel before it starts"
//   cancelled the plan it started was cancelled later
//
// A row never charges anyone by itself. The start job (services/
// neighborhoodUnlocks.js) claims a scheduled row by moving it to 'starting'
// with a conditional update, and only the process that won the claim talks
// to Stripe, with an idempotency key on the member id.

const LIVE_STATUSES = ['invited', 'pending_card', 'waiting', 'scheduled', 'starting', 'active', 'failed'];
// Counted toward an unlock: a card is behind it.
const COUNTED_STATUSES = ['waiting', 'scheduled', 'starting', 'active'];

const UnlockMemberSchema = new mongoose.Schema(
    {
        // neighborhoodPricing.neighborhoodKey, e.g. 'manhattan-chelsea'.
        neighborhood: { type: String, required: true, index: true },
        borough: { type: String },
        neighborhoodName: { type: String },

        source: { type: String, enum: ['self', 'rep'], required: true },
        // Why an invite ended without the invitee answering it:
        // 'joined_elsewhere' = they joined on their own or with another code.
        endedBecause: { type: String },
        status: {
            type: String,
            enum: [...LIVE_STATUSES, 'declined', 'left', 'cancelled'],
            required: true,
        },
        // Set while the row is live and cleared when it ends, so the unique
        // sparse index below allows one live membership per customer.
        liveUser: { type: mongoose.Schema.Types.ObjectId },

        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
        rep: { type: mongoose.Schema.Types.ObjectId, ref: 'Rep', index: true },
        // A customer's referral code that brought them in (services/referrals.js).
        referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        referralCode: { type: String },

        // What the customer agreed to. The price is the table's at signup and
        // is what the start job charges, even if the table changes before.
        plan: {
            tier: { type: String, default: 'home_garage' },
            interval: { type: String, enum: ['week', 'month'], default: 'month' },
            amountCents: { type: Number, required: true },
            commissionCents: { type: Number },
            promoCode: { type: String },
        },
        homeAddress: {
            streetAddress: { type: String },
            lat: { type: Number },
            lng: { type: Number },
        },
        vehicle: {
            color: { type: String, trim: true },
            model: { type: String, trim: true },
            licensePlate: { type: String, trim: true, uppercase: true },
        },
        // A rep invite's details about the person, before they have an account.
        contact: {
            name: { type: String, trim: true },
            phone: { type: String, trim: true },
            email: { type: String, trim: true, lowercase: true },
        },
        notes: { type: String },

        // The /join/<token> link. A bearer secret: whoever opens it signed in
        // claims the row.
        inviteToken: { type: String },
        inviteOpenedAt: { type: Date },
        claimedAt: { type: Date },

        // The card.
        stripeCustomerId: { type: String },
        setupIntentId: { type: String },
        paymentMethodId: { type: String },
        cardBrand: { type: String },
        cardLast4: { type: String },
        cardSavedAt: { type: Date },

        // The start.
        startsAt: { type: Date },
        // "We'll tell you the day before your card is charged."
        remindedAt: { type: Date },
        unlockNotifiedAt: { type: Date },
        startClaimedAt: { type: Date },
        startedAt: { type: Date },
        subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription' },
        startError: { type: String },

        endedAt: { type: Date },
    },
    { timestamps: true }
);

UnlockMemberSchema.index({ neighborhood: 1, status: 1 });
UnlockMemberSchema.index({ liveUser: 1 }, { unique: true, sparse: true });
UnlockMemberSchema.index({ inviteToken: 1 }, { unique: true, sparse: true });
UnlockMemberSchema.index({ status: 1, startsAt: 1 });
UnlockMemberSchema.index({ 'contact.phone': 1 }, { sparse: true });

UnlockMemberSchema.statics.LIVE_STATUSES = LIVE_STATUSES;
UnlockMemberSchema.statics.COUNTED_STATUSES = COUNTED_STATUSES;

module.exports = mongoose.model('UnlockMember', UnlockMemberSchema);
