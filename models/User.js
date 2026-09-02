const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    phone: {
        type: String,
        required: true,
        unique: true,
    },
    firebaseUid: {
        type: String,
        sparse: true,
        unique: true,
    },
    // Which client the account was created from. Written ONCE, when the User
    // document is born in authController.loginUser — never on later logins, so
    // it stays "where they signed up" and not "where they were last seen".
    //
    //   'ios' | 'android'  — the mobile app (sends platform + fcmToken)
    //   'web'              — the customer web app at valetnetwork.co/park
    //   'business_web'     — the front-desk portal at valetnetwork.co/business
    //
    // Accounts created before this field existed have nothing here; the admin
    // customer list infers those (see inferLegacyPlatform in adminController).
    // Left un-enum'd on purpose: a new client sending an unrecognised value
    // should be normalised to 'unknown' by the controller, not 500 on save.
    signupPlatform: {
        type: String,
    },
    firstName: {
        type: String,
    },
    lastName: {
        type: String,
    },
    age: {
        type: Number,
    },
    isValet: {
        type: Boolean, 
    },
    isActive: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false },
    // Receives every new-order push regardless of distance. Dispatch normally
    // notifies only the 5 nearest valets; this exists so an owner can watch all
    // requests, including overnight ones in a borough they are not in.
    alwaysNotify: { type: Boolean, default: false },
    verified: { type: Boolean, required: true },
    profileImage: {
        type: String,
    },
    currentLocation: {
        lat: { type: Number },
        lng: { type: Number },
        address: { type: String },
        lastUpdated: { type: Date },
    },
    isDoorman: {
        type: Boolean,
        default: false,
    },
    // Chauffeur (ride-hail driver) role — kept SEPARATE from isValet for now.
    isChauffeur: {
        type: Boolean,
        default: false,
    },
    chauffeurOnline: {
        type: Boolean,
        default: false,
    },
    // Per-driver software-fee subscription (drives resolveFeeMode in the
    // pricing engine: active => $0/ride). Toggled on the driver profile.
    chauffeurSubscription: {
        active: { type: Boolean, default: false },
        plan: { type: String },
        currentPeriodEnd: { type: Date },
        stripeSubscriptionId: { type: String },
    },
    referralCode: {
        type: String
    },
    stripeCustomerId: {
        type: String,
        sparse: true,
    },
    activeSubscription: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Subscription',
    },
    referredUsers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    referredBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    // Enterprise feature fields
    enterpriseCode: {
        type: String,
        sparse: true, // Allows null values while maintaining uniqueness when present
    },
    enterpriseName: {
        type: String,
    },
    // Enterprise account type (isDoorman===true) — business details in place of first/last/age.
    // Named `enterpriseBusinessName` to avoid collision with the legacy `enterpriseName` field
    // above (which belongs to the older event/code affiliation feature).
    enterpriseBusinessName: {
        type: String,
    },
    enterpriseAddress: {
        street: { type: String },
        suite: { type: String }, // optional — suite / floor number
        city: { type: String },
        state: { type: String }, // 2-letter state code
        zip: { type: String },
    },
    shiftStatus: {
        type: String,
        enum: ['on_shift', 'off_shift'],
        default: 'off_shift',
    },
    userAgreementAccepted: {
        type: Boolean,
        default: false,
    },
    // --- Valet payout fields ---
    // currentBalance: cents the valet can request payout for. Resets to 0 on payout request.
    currentBalance: {
        type: Number,
        default: 0,
    },
    // totalEarnings: lifetime earnings (in cents). Never resets, used for analytics/display.
    // INCLUDES tips (the net amount of every tip received) so this is "all money earned".
    totalEarnings: {
        type: Number,
        default: 0,
    },
    // --- Tip-specific counters (in cents, net amount after Stripe fee) ---
    // currentTipsBalance: tip earnings the valet hasn't yet been paid out for.
    // Resets to 0 alongside currentBalance when a payout is processed.
    // Useful for the earnings card to show "of which $X is tips" beneath the base balance.
    currentTipsBalance: {
        type: Number,
        default: 0,
    },
    // totalTips: lifetime tips received (cents, net). Never resets.
    // Powers the "you've earned $X in tips" lifetime stat on the valet's card.
    totalTips: {
        type: Number,
        default: 0,
    },
    // payoutMethod: which handle Rishi should send funds to when fulfilling
    // a payout request. The valet can save handles for multiple methods,
    // but only one is "active" at a time.
    payoutMethod: {
        type: String,
        enum: ['zelle', 'venmo', 'cashapp'],
    },
    // zelleHandle: email or phone (E.164 e.g. '+12125551234') the valet wants paid via Zelle.
    zelleHandle: {
        type: String,
    },
    // venmoHandle: Venmo username (no leading '@'; we strip it on save).
    venmoHandle: {
        type: String,
    },
    // cashappHandle: $cashtag (no leading '$'; we strip it on save).
    cashappHandle: {
        type: String,
    },
    // --- Background check fields ---
    // Provider-neutral. The legacy field names `certnApplicationId` and
    // `certnResult` are reused for both Certn and Yardstik (they store the
    // active provider's application/report id and raw status). The `provider`
    // field disambiguates which provider the record came from. We'll rename
    // these fields during the Phase 5 Certn cleanup.
    backgroundCheck: {
        status: {
            type: String,
            enum: ['not_started', 'pending', 'passed', 'failed', 'expired'],
            default: 'not_started',
        },
        provider: {
            type: String,
            // 'grandfathered' is used by scripts/grandfatherExistingValetsForYardstik.js
            // to mark pre-Yardstik valets whose status was stamped 'passed' so the
            // new gate doesn't lock them out. They weren't actually checked.
            enum: ['certn', 'yardstik', 'grandfathered'],
        },
        certnApplicationId: { type: String },  // application/report id (provider-agnostic despite name)
        certnResult: { type: String },         // raw provider status (terminal only — legacy)
        // Latest provider-side status from any webhook (terminal or not).
        // Drives the mobile step indicator: queued → processing → clear/etc.
        providerStatus: { type: String },
        // Yardstik-only: the invitation id, used by the resend endpoint to
        // refresh expired invitations via POST /invitations/{id}/refresh.
        invitationId: { type: String },
        // Yardstik-only: the candidate id. Webhooks don't reliably include
        // our external_id on the candidate sub-object, so we match incoming
        // webhooks against this stored candidateId as a fallback.
        candidateId: { type: String },
        initiatedAt: { type: Date },
        completedAt: { type: Date },
    },
    // --- Valet onboarding status (single gate for job acceptance) ---
    // Tracks where the valet is in the onboarding lifecycle. Job
    // acceptance gates on `valetOnboardingStatus === 'active'`.
    //
    // New valets default to 'pending_certn' — they must complete Yardstik
    // before they can take jobs. The DL upload step is currently skipped
    // (Yardstik IDV already captures license info), so a passing Yardstik
    // moves the valet straight from 'pending_certn' to
    // 'pending_provider_approval' awaiting Rishi's authorize click.
    valetOnboardingStatus: {
        type: String,
        enum: [
            'pending_certn',                // signup complete, background check running
            'certn_failed',                 // Yardstik rejected — terminal unless Rishi overrides
            'pending_documents',            // (deferred) Yardstik passed, awaiting DL upload
            'pending_provider_approval',    // Yardstik passed; awaiting Rishi to authorize
            'active',                       // can accept jobs
            'suspended_admin',              // admin manually deactivated
        ],
        default: 'pending_certn',
    },
    // --- Provider approval tracking ---
    // The data package is auto-prepared when the valet hits
    // `pending_provider_approval`. Rishi sends it to insurance providers
    // off-system, then clicks "Authorize" once all providers have given
    // the go-ahead, which moves the valet to `active`.
    providerAuthorization: {
        packagePreparedAt: { type: Date },
        authorizedAt: { type: Date },
        authorizedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
    },
    // --- Status history (append-only) ---
    // Every time the valet moves between onboarding statuses, we append
    // a record here. Gives Rishi a chronological view of what happened to
    // a valet's account: "moved to certn_failed at X, why, who triggered it."
    // New valets start with an empty list; entries get added going forward.
    statusHistory: [{
        from: { type: String },                // previous status (null on the very first record)
        to: { type: String, required: true },  // new status
        at: { type: Date, default: Date.now },
        // What triggered the change:
        //   'system'           — backend logic auto-transitioned (e.g., DL upload completed)
        //   'certn_webhook'    — Certn told us pass/fail (legacy provider)
        //   'yardstik_webhook' — Yardstik told us pass/fail
        //   'admin'            — Rishi (or another admin) clicked Authorize / Suspend / etc.
        triggerSource: {
            type: String,
            enum: ['system', 'certn_webhook', 'yardstik_webhook', 'admin'],
        },
        // Populated only when triggerSource === 'admin'
        triggerAdminId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        // Optional context, e.g., "Certn returned 'cleared'" or "manual override after appeal"
        reason: { type: String },
        _id: false,
    }],
    // --- Provider notifications log (append-only) ---
    // Each time the auto-send fires for this valet (on transition to
    // pending_provider_approval), we record the attempt here — recipients,
    // success/failure, error message, and how many attempts it took.
    // Lets Rishi audit which valets got sent to which providers.
    providerNotifications: [{
        sentAt: { type: Date, default: Date.now },
        recipients: [{ type: String }],     // email addresses copied at send-time
        success: { type: Boolean, required: true },
        attempts: { type: Number, default: 1 },
        error: { type: String },             // populated only on failure
        _id: false,
    }],

    // --- Street-cleaning schedule (the free alarm) -----------------------
    //
    // Owned by the PERSON, not by a subscription. This is deliberate: the
    // reminder is free and exists with or without a plan, the subscription
    // scheduler reads its days from here, and cancelling a plan therefore
    // leaves the reminders running instead of dropping the customer off a
    // cliff. `Subscription.aspSchedule` is now a mirror kept for the admin
    // dashboard and for older documents; this field is the source of truth.
    cleaningSchedule: {
        address: {
            streetAddress: { type: String },
            lat: { type: Number },
            lng: { type: Number },
        },
        // Same shape as Subscription.aspSchedule.days so the two can be
        // copied across without translation. 0 = Sunday (JS convention).
        days: [
            {
                _id: false,
                weekday: { type: Number, min: 0, max: 6 },
                hour: { type: Number, min: 0, max: 23 },
                minute: { type: Number, min: 0, max: 59 },
            },
        ],
        // How long before the sweep the customer wants waking. The app
        // schedules a LOCAL notification off this, so it fires with no
        // network and costs nothing.
        reminderLeadMin: { type: Number, default: 60 },
        status: {
            type: String,
            enum: ['active', 'paused'],
            default: 'active',
        },
        // null while paused means "until I turn it back on".
        pausedUntil: { type: Date, default: null },
        source: {
            type: String,
            enum: ['manual', 'from_orders', 'subscription'],
            default: 'manual',
        },
        updatedAt: { type: Date },
    },

    // Set when a customer waves away the "we already know your cleaning day"
    // suggestion. Without this the prompt would come back every launch, which
    // is exactly the kind of nagging that gets an app deleted.
    cleaningScheduleSuggestionDismissedAt: { type: Date },

    // A promo code hung on the account ahead of time, so a campaign can
    // promise a free month without the customer typing anything: subscription
    // create falls back to this when the app sends no code. Cleared the moment
    // a plan actually activates. A code the customer types always wins.
    pendingPromoCode: { type: String, trim: true, uppercase: true },
    pendingPromoSetAt: { type: Date },

    // --- The handoff link the customer gives their doorman ----------------
    //
    // The ritual assumes whoever is holding the keys is also holding a phone
    // with our app on it. A weekly street-cleaning subscriber is in a meeting
    // at 8am; her doorman does the handoff. He cannot be given the code in
    // advance — at that beat the code is the VALET'S, read out loud on
    // arrival, and the person with the keys types it back — so what he needs
    // is not a number, it is a screen to type into.
    //
    // It hangs on the PERSON and not on an order because it is a standing
    // link: it is minted once, texted to the front desk once, and has to keep
    // working next Thursday and the Thursday after that. A per-order token
    // would mean a new URL every week, which in practice means the doorman
    // types the code into a dead page while the valet waits at the curb.
    //
    // For the same reason there is no expiry clock. A link that dies at 3am
    // on its own dies unnoticed, and the failure lands on the one morning it
    // was needed. Revocation is the only off switch, and it is the customer's.
    // The token is still a bearer credential for a car, so what it can SHOW is
    // narrow and gated on a live handoff window — see
    // controllers/shareController.js.
    doormanLink: {
        // `select: false`, and it is the whole point of the field.
        //
        // The token IS the car. Nothing about it is a login, so anybody
        // holding the string can open the handoff screen — and this document
        // is answered whole, to anyone who asks, by
        // `GET /api/auth/getUserById/:userId` and by `POST /api/auth/loginUser`.
        // Neither of those knows the difference between a field that is safe
        // to publish and one that releases a car, so a plain path here put the
        // live token on the open internet beside the customer's name.
        //
        // Deny by default and opt in. The three reads that legitimately need
        // the string all live in controllers/shareController.js and all say
        // `.select('+doormanLink.token')`; every other read of a User — login,
        // the admin console, the valet's customer lookup — now cannot leak it
        // even by accident, and neither can the next field somebody adds to a
        // response.
        //
        // `createdAt` and `revokedAt` stay visible: they say whether a link
        // exists, which is not a credential.
        token: { type: String, select: false },
        createdAt: { type: Date },
        revokedAt: { type: Date },
    },
});

// Every hit on a doorman link is a lookup by token and nothing else. Unique so
// two customers can never collide on one; sparse because only the handful of
// customers who asked for a link carry the field at all.
UserSchema.index({ 'doormanLink.token': 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('User', UserSchema);
