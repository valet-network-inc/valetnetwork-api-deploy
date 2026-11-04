/**
 * accountLinkController — two customer accounts becoming a pair.
 *
 * A customer texted Rishi: "How can Peter and I share an account?" The answer
 * is a link. Both keep their own login, profile, card and history; each sees
 * the other's parks; a plan held by either covers both, one park at a time.
 * Every rule that READS a pair lives in services/accountLinks.js. This file is
 * only the handshake that makes one and the two ways it ends.
 *
 * THE HANDSHAKE (brief §1, §5). Either phone shows a QR, the other scans it.
 *
 *   POST /invite     the phone showing the code mints it           → open
 *   POST /claim      the other phone scans it                       → pending
 *   POST /authorize  the phone that SHOWED the code taps Authorize  → active
 *   POST /decline    …or taps "Not them"                            → revoked
 *   POST /unlink     either side, any time; also the scanner's
 *                    "Cancel" while it waits                        → revoked
 *   GET  /status     the panel's one read, polled every 3 s
 *
 * Authorize is the one verification step, and it sits with whoever showed the
 * code on purpose: a QR on a screen can be photographed from across a room, so
 * scanning proves nothing. The person holding the phone that showed it looks
 * at the scanner's name and says yes.
 *
 * THE TOKEN is modelled on the doorman link (controllers/shareController.js):
 * 32 random bytes, never derived from an id, and — one step further than that
 * link goes — only its sha256 is stored. A database read never yields a
 * working code. It is good for ten minutes, and a scan starts a second ten
 * minutes for the Authorize tap. Nothing sweeps expired rows; every read that
 * finds an open or pending link past its time marks it `expired` there and
 * then (`lapsed`), so the answer is right whoever asks first.
 *
 * ONE ANSWER for "no such" and "not yours", as everywhere else that takes an
 * id or a secret: a code that never existed, was replaced, or was already
 * used is INVALID; a link id that does not exist or is somebody else's is the
 * same 403.
 *
 * WHAT LEAVES THE SERVER about the other person is `partnerSummary` and
 * nothing else: first and last name, photo, last four digits of the phone.
 * Their firebaseUid is read here to push them, and never returned.
 *
 * NO TRANSACTIONS. There are none anywhere in this codebase and the tests run
 * on a standalone mongodb-memory-server that cannot hold one. Every state
 * change below is a single conditional write guarded on the status it expects
 * to find, and the partial unique indexes on models/AccountLink.js are the
 * last word on "one active link per account": a race that gets past every
 * check here still cannot write a second active link, and its E11000 is
 * answered as ALREADY_LINKED.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');

const AccountLink = require('../models/AccountLink');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const { getPlan } = require('../services/subscriptionPlans');
const {
    partnerSummary,
    firstNameOf,
    activeLinkFor,
    getHouseholdSubscription,
    SUMMARY_FIELDS,
} = require('../services/accountLinks');
// Called through the module rather than destructured so a test can spy on it.
const notifications = require('./notificationController');

// How long a code on screen can be scanned, and how long a scan waits for the
// Authorize tap. The app re-mints silently when the first runs out, so the
// person looking at their own code never sees it expire.
const TOKEN_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;

// What the QR encodes. The app registers the scheme (app.config.js) so the
// iPhone's own Camera app can open a scanned code straight into the panel.
const QR_PREFIX = 'valetnyc://link/';

// Error copy is the brief's (§7). The clients map `code` to their own copy and
// fall back to "Something went wrong. Try again."; `message` is here so an API
// reader, or an older client, still gets a sentence a person can act on.
const MESSAGES = {
    EXPIRED: 'That code has expired. Ask them to open Link account again.',
    SELF_LINK: "That's your own code.",
    ALREADY_LINKED: 'That account is already linked with someone.',
    BOTH_HAVE_PLANS: 'You both have a plan. One of you has to cancel theirs first.',
    INVALID: "We don't recognise that code.",
    NOT_PENDING: 'That request is no longer waiting.',
    NOT_LINKED: "You're not linked with anyone.",
    NOT_YOURS: 'That request is not yours.',
    NOT_A_CUSTOMER: 'Only customer accounts can link.',
    BAD_REQUEST: 'linkId is required',
};

const fail = (res, status, code) =>
    res.status(status).json({ success: false, code, message: MESSAGES[code] });

const idOf = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * The token out of whatever the scanner read.
 *
 * The in-app scanner and the iPhone Camera app both hand over the whole
 * `valetnyc://link/<token>` string; a client that has already parsed it sends
 * the bare token. Both are accepted. Anything that is not a plausible token
 * comes back null and is answered INVALID without touching the database.
 */
function tokenFrom(raw) {
    if (typeof raw !== 'string') return null;
    let token = raw.trim();
    if (token.toLowerCase().startsWith(QR_PREFIX)) token = token.slice(QR_PREFIX.length);
    // A deep link can arrive with a trailing slash or a query string tacked
    // on by whatever opened it. Neither is part of the token.
    token = token.split(/[?#]/)[0].replace(/\/+$/, '');
    return /^[A-Za-z0-9_-]{32,128}$/.test(token) ? token : null;
}

/** When this link's current step runs out: the code's TTL, or the Authorize wait. */
function expiresAtOf(link) {
    if (!link) return null;
    if (link.status === 'open') return link.tokenExpiresAt || null;
    if (link.status === 'pending' && link.claimedAt) {
        return new Date(new Date(link.claimedAt).getTime() + PENDING_TTL_MS);
    }
    return null;
}

/**
 * The link as one of its two people sees it. The only shape a link leaves the
 * server in — the same in every response and every socket event, so a client
 * can hand any of them to the same renderer.
 */
function linkView(link, viewerId) {
    return {
        _id: String(link._id),
        status: link.status,
        role: idOf(link.inviter) === idOf(viewerId) ? 'inviter' : 'invitee',
        expiresAt: expiresAtOf(link),
        authorizedAt: link.authorizedAt || null,
    };
}

/** The other member of a claimed link. */
const otherMemberOf = (link, me) => {
    const ids = [idOf(link.inviter), idOf(link.invitee), ...(link.members || []).map(String)];
    return ids.find((id) => id && id !== idOf(me)) || null;
};

/**
 * Is this open or pending link past its time? If so it is marked `expired`
 * here — nothing else sweeps them — and the caller treats it as gone.
 *
 * The token hash is deliberately LEFT on a link that simply ran out of time,
 * so the person still holding that code is told "expired" (ask them to open
 * Link account again) rather than "we don't recognise that code", which would
 * send them hunting for a typo. The hash comes off everywhere a code stops
 * meaning anything: replaced, approved, declined, cancelled, unlinked.
 */
async function lapsed(link, now = new Date()) {
    if (!link || !['open', 'pending'].includes(link.status)) return false;
    const deadline = expiresAtOf(link);
    if (!deadline || deadline.getTime() > now.getTime()) return false;
    // Guarded on the status we read, so a link that was approved in the same
    // instant is never knocked back to expired.
    await AccountLink.updateOne(
        { _id: link._id, status: link.status },
        { $set: { status: 'expired' } }
    );
    return true;
}

/** Only ever a Socket.io emit. A failed emit must never fail the request. */
function emitTo(io, userId, event, payload) {
    if (!io || !userId) return;
    try {
        io.to(String(userId)).emit(event, payload);
    } catch (err) {
        console.error(`account link: ${event} emit failed —`, err.message);
    }
}

/**
 * Push one person about the link. Only the link flow itself pushes the other
 * party (brief §1) — park pushes are untouched by any of this.
 *
 * Never throws and never fails the request: every call site has already
 * written the link and answered the caller before it gets here.
 */
async function pushQuietly(user, title, body, linkStatus) {
    if (!user || !user.firebaseUid) return;
    try {
        await notifications.sendPushNotification(user.firebaseUid, title, body, {
            type: 'accountLink',
            linkStatus,
        });
    } catch (err) {
        console.error('account link: push failed —', err.message);
    }
}

/**
 * The code's owner as the person who scanned it sees them before Authorize:
 * a first name for "Waiting for [First name]", and nothing else. Whoever
 * scans a code may have photographed it off someone's screen, and until the
 * owner approves them they are nobody to this account. Same keys as a
 * partner summary, so a client parsing one parses this.
 */
const scannerView = (summary) =>
    summary ? { ...summary, lastName: '', profileImage: null, phoneMasked: '' } : null;

/**
 * Linking is for two customer accounts (brief §1). A valet linked to a
 * customer would pass the partner gates on that customer's parks — tip off
 * their card, extend on it, read the release codes. The Link account row only
 * exists on the customer Profile; this is the server saying the same.
 */
async function isCustomer(userId) {
    const u = await User.findById(userId).select('isValet isDoorman isDeleted').lean();
    return !!u && !u.isValet && !u.isDoorman && !u.isDeleted;
}

/**
 * The people on a link, by id, with just enough to describe them to each
 * other (SUMMARY_FIELDS) and to push them (firebaseUid). Callers turn these
 * into `partnerSummary` before anything leaves the server.
 */
async function peopleById(ids, extra = '') {
    const users = await User.find({ _id: { $in: ids.filter(Boolean) } })
        .select(`${SUMMARY_FIELDS} firebaseUid ${extra}`.trim())
        .lean();
    return new Map(users.map((u) => [String(u._id), u]));
}

// Does this account hold a live plan of its OWN? Not the household answer.
// A plan that is still theirs to cancel, which is what "One of you has to
// cancel theirs first" asks for — so past_due counts. getActiveSubscription
// reads a past_due plan as no plan (its entitlements are paused), and asking
// that would let someone whose card bounced link to a holder, get covered by
// the holder's plan, and still own a plan of their own that comes back to
// life the moment the card clears: two plans on one pair. The statuses are
// the ones the Subscription model's one-live-plan-per-user index calls live.
const holdsPlan = async (userId) =>
    !!(await Subscription.exists({ user: userId, status: { $in: ['active', 'past_due'] } }));

/**
 * The two-plans rule (brief §1): linking is refused while both hold a live
 * plan, because "a plan held by either covers both" has no answer for two.
 * Asked of each person's own plan — getHouseholdSubscription would answer
 * with a partner's plan, and neither of these two is anybody's partner yet.
 */
async function bothHavePlans(a, b) {
    const [x, y] = await Promise.all([holdsPlan(a), holdsPlan(b)]);
    return x && y;
}

/**
 * Take a request off the table and tell the person on the other end.
 *
 * `notifyUserId` is whoever is left waiting on it: the scanner when the code's
 * owner replaces it or cannot approve it any more, the code's owner when the
 * scanner moves on to another code. `accountLink:declined` is what sends a
 * waiting screen, or an Authorize card, back to the QR.
 */
async function retirePending(io, link, notifyUserId) {
    const retired = await AccountLink.findOneAndUpdate(
        { _id: link._id, status: 'pending' },
        { $set: { status: 'expired' }, $unset: { tokenHash: 1 } },
        { new: true }
    ).lean();
    if (retired && notifyUserId) {
        emitTo(io, notifyUserId, 'accountLink:declined', { link: linkView(retired, notifyUserId) });
    }
    return retired;
}

/**
 * Everything this account has out as the one who SHOWED a code, retired.
 *
 * Called on mint (a new code replaces the last one, brief §4) and on a
 * successful scan (someone who has just scanned is not also waiting to be
 * scanned). A pending request on one of those codes has a person on the other
 * end watching a spinner, so it is told.
 */
async function retireInvitesBy(io, inviterId, now = new Date()) {
    const outstanding = await AccountLink.find({
        inviter: inviterId,
        status: { $in: ['open', 'pending'] },
    }).lean();

    for (const link of outstanding) {
        // A code that simply ran out keeps its hash (see `lapsed`), so whoever
        // still holds it is told it expired rather than that it never existed.
        if (await lapsed(link, now)) continue;
        if (link.status === 'pending') {
            await retirePending(io, link, idOf(link.invitee));
        } else {
            await AccountLink.updateOne(
                { _id: link._id, status: 'open' },
                { $set: { status: 'expired' }, $unset: { tokenHash: 1 } }
            );
        }
    }
}

/**
 * The link this account is in right now, from its own point of view, or null.
 *
 * Active beats pending beats open. Two pending rows for one account should not
 * happen — a scan retires the scanner's own codes and earlier scans — but if a
 * race leaves two, the newest is the one on screen and the older lapses on its
 * own clock.
 */
async function currentLinkFor(me, now = new Date()) {
    const active = await activeLinkFor(me);
    if (active) return active;

    const pending = await AccountLink.find({ members: me, status: 'pending' })
        .sort({ claimedAt: -1 })
        .lean();
    for (const link of pending) {
        if (!(await lapsed(link, now))) return link;
    }

    const open = await AccountLink.find({ inviter: me, status: 'open' })
        .sort({ createdAt: -1 })
        .lean();
    for (const link of open) {
        if (!(await lapsed(link, now))) return link;
    }
    return null;
}

/** A car worth telling the app about, or null. The three strings and nothing else. */
function vehicleView(vehicle) {
    if (!vehicle) return null;
    const out = {
        color: vehicle.color || '',
        model: vehicle.model || '',
        licensePlate: vehicle.licensePlate || '',
    };
    return out.color || out.model || out.licensePlate ? out : null;
}

const hasPlate = (user) =>
    !!(user && user.vehicle && typeof user.vehicle.licensePlate === 'string' && user.vehicle.licensePlate.trim());

/**
 * Car details are copied once, never overwritten (brief §1).
 *
 * If exactly one of the two has a car saved under Profile → Your car, it is
 * copied into the other's empty slot; both or neither, nothing happens. "Has a
 * car" means a plate — the app will not save a car without one.
 *
 * The write is conditional on the receiving account STILL having no plate, so
 * a car saved on the other phone in the same second is never overwritten by
 * this copy. A plain profile copy on purpose: a plan will later carry its own
 * list of cars (brief §10), and that must not be built out of this.
 */
async function copyCarIfOneSided(a, b) {
    if (hasPlate(a) === hasPlate(b)) return;
    const [from, to] = hasPlate(a) ? [a, b] : [b, a];
    await User.updateOne(
        // `$in: [null, '']` matches a missing plate, a null one and an empty
        // one — every way a car can be "not saved".
        { _id: to._id, 'vehicle.licensePlate': { $in: [null, ''] } },
        {
            $set: {
                vehicle: {
                    color: from.vehicle.color || '',
                    model: from.vehicle.model || '',
                    licensePlate: from.vehicle.licensePlate,
                    // Copied from the partner's own entry (services/accountVehicle.js).
                    source: 'customer',
                    at: new Date(),
                },
            },
        }
    );
}

/* -------------------------------------------------------------------------- */

/**
 * POST /api/account-link/invite  { userId }
 *
 * Mints the code the phone shows. Retires every code this account already has
 * out (brief §4: a new QR expires the last one), including one somebody has
 * scanned and is waiting on — THE CLIENT MUST READ /status BEFORE MINTING, or
 * opening the panel would throw away a request that is sitting there waiting
 * to be authorized.
 *
 * An account already in a link cannot show a code: pairs only.
 */
exports.invite = async (req, res) => {
    const me = idOf(req.callerUserId || req.body?.userId);
    try {
        if (!(await isCustomer(me))) return fail(res, 403, 'NOT_A_CUSTOMER');
        if (await activeLinkFor(me)) return fail(res, 409, 'ALREADY_LINKED');

        const now = new Date();
        await retireInvitesBy(req.io, me, now);

        // 32 random bytes, as the doorman link: never sequential, never
        // derived from an id. Only the hash is kept.
        const token = crypto.randomBytes(32).toString('base64url');
        const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);
        await AccountLink.create({
            inviter: me,
            status: 'open',
            tokenHash: hashToken(token),
            tokenExpiresAt: expiresAt,
        });

        return res.status(200).json({ success: true, token, expiresAt });
    } catch (err) {
        console.error('account link invite failed:', err);
        return res.status(500).json({ success: false, message: 'Could not make a code. Try again.' });
    }
};

/**
 * POST /api/account-link/claim  { userId, token }
 *
 * The scanner. `token` is the bare token or the whole `valetnyc://link/<token>`.
 *
 * Refusals, in the order they are asked (brief §5):
 *   404 INVALID         — no such code, replaced, used, declined. One answer.
 *   410 EXPIRED         — the code ran out before anyone scanned it
 *   400 SELF_LINK       — the scanner is the one who showed it
 *   409 ALREADY_LINKED  — either of the two is already in a link
 *   409 BOTH_HAVE_PLANS — both hold a live plan of their own
 *
 * A scan that arrives twice — the same phone retrying after a dropped answer,
 * or a camera firing twice — gets the same success again rather than INVALID
 * for its own request.
 */
exports.claim = async (req, res) => {
    const me = idOf(req.callerUserId || req.body?.userId);
    try {
        const token = tokenFrom(req.body?.token);
        if (!token) return fail(res, 404, 'INVALID');
        if (!(await isCustomer(me))) return fail(res, 403, 'NOT_A_CUSTOMER');

        const now = new Date();
        // An exact index hit on a hash of a 256-bit secret — there is no
        // prefix for a guesser to walk, so this lookup is not a timing oracle.
        let link = await AccountLink.findOne({ tokenHash: hashToken(token) }).lean();

        const answer = async (settled) => {
            if (!settled) return fail(res, 404, 'INVALID');
            if (settled.status === 'expired') return fail(res, 410, 'EXPIRED');
            if (settled.status === 'pending' && idOf(settled.invitee) === me) {
                if (await lapsed(settled, now)) return fail(res, 410, 'EXPIRED');
                const people = await peopleById([idOf(settled.inviter)]);
                return res.status(200).json({
                    success: true,
                    link: linkView(settled, me),
                    waitingFor: scannerView(partnerSummary(people.get(idOf(settled.inviter)))),
                });
            }
            // Active, revoked, or somebody else's scan: not a code this
            // person can use, and nothing about why.
            return fail(res, 404, 'INVALID');
        };

        if (!link || link.status !== 'open') return answer(link);
        if (await lapsed(link, now)) return fail(res, 410, 'EXPIRED');

        const inviterId = idOf(link.inviter);
        if (inviterId === me) return fail(res, 400, 'SELF_LINK');

        const [mine, theirs] = await Promise.all([activeLinkFor(me), activeLinkFor(inviterId)]);
        if (mine || theirs) return fail(res, 409, 'ALREADY_LINKED');

        if (await bothHavePlans(me, inviterId)) return fail(res, 409, 'BOTH_HAVE_PLANS');

        const people = await peopleById([me, inviterId]);
        // A code whose owner has since been deleted, or is not a customer,
        // is a dead code.
        if (!people.get(inviterId) || !(await isCustomer(inviterId))) return fail(res, 404, 'INVALID');

        // The flip. Guarded on `open` and on the clock, so of two phones
        // scanning one code in the same second exactly one becomes the
        // request; the other re-reads and is answered from what it finds.
        const claimed = await AccountLink.findOneAndUpdate(
            { _id: link._id, status: 'open', tokenExpiresAt: { $gt: now } },
            {
                $set: {
                    invitee: me,
                    members: [inviterId, me],
                    status: 'pending',
                    claimedAt: now,
                },
            },
            { new: true }
        ).lean();
        if (!claimed) {
            link = await AccountLink.findById(link._id).lean();
            // Still open means the only guard left — the clock — is what
            // refused it: the code ran out between the check above and here.
            if (link && link.status === 'open') {
                await lapsed(link, new Date());
                return fail(res, 410, 'EXPIRED');
            }
            return answer(link);
        }

        // Someone who has just scanned is not also waiting to be scanned, nor
        // still waiting on an earlier scan. Each of those had somebody on the
        // other end, and each is told.
        await retireInvitesBy(req.io, me, now);
        const earlier = await AccountLink.find({
            invitee: me,
            status: 'pending',
            _id: { $ne: claimed._id },
        }).lean();
        for (const old of earlier) {
            await retirePending(req.io, old, idOf(old.inviter));
        }

        const scanner = partnerSummary(people.get(me));
        const inviter = people.get(inviterId);

        emitTo(req.io, inviterId, 'accountLink:requested', {
            link: linkView(claimed, inviterId),
            from: scanner,
        });

        res.status(200).json({
            success: true,
            link: linkView(claimed, me),
            waitingFor: scannerView(partnerSummary(inviter)),
        });

        // After the answer: the scan has worked whether or not the push lands.
        await pushQuietly(
            inviter,
            'Someone scanned your code',
            `${firstNameOf(scanner, 'Someone')} wants to link. Open Profile → Link account to approve.`,
            'pending'
        );
    } catch (err) {
        console.error('account link claim failed:', err);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Could not read that code. Try again.' });
        }
    }
};

/**
 * POST /api/account-link/authorize  { userId, linkId }
 *
 * The one verification step: the person who showed the code has seen the
 * scanner's name and taps Authorize. Only they can; the scanner authorizing
 * their own request would make the step mean nothing.
 *
 *   403 NOT_YOURS       — no such link, or not this caller's to approve
 *   409 NOT_PENDING     — declined, cancelled, replaced, or the wait ran out
 *   409 ALREADY_LINKED  — one of them got linked elsewhere in the meantime
 *   409 BOTH_HAVE_PLANS — re-asked, because a plan can be bought between the
 *                         scan and the tap
 */
exports.authorize = async (req, res) => {
    const me = idOf(req.callerUserId || req.body?.userId);
    const { linkId } = req.body || {};
    try {
        if (!linkId) return fail(res, 400, 'BAD_REQUEST');
        if (!mongoose.isValidObjectId(linkId)) return fail(res, 403, 'NOT_YOURS');

        const now = new Date();
        const link = await AccountLink.findById(linkId).lean();
        if (!link || idOf(link.inviter) !== me) return fail(res, 403, 'NOT_YOURS');
        if (link.status !== 'pending' || (await lapsed(link, now))) {
            return fail(res, 409, 'NOT_PENDING');
        }

        const inviteeId = idOf(link.invitee);

        // Pairs only. If either has been linked to somebody else since the
        // scan, this request can never succeed — take it off the table so the
        // scanner's waiting screen goes back to the QR instead of spinning
        // until the clock runs out.
        const [mine, theirs] = await Promise.all([activeLinkFor(me), activeLinkFor(inviteeId)]);
        // Unless the active link is THIS one: a second tap on the same
        // Authorize button that read the request while it was still pending,
        // landing just after the first tap made it active. That tap asked for
        // what is now true, so it is answered like any other late tap. Telling
        // the person who just linked "That account is already linked with
        // someone" would be about themselves.
        const isThis = (other) => !!other && String(other._id) === String(link._id);
        if (isThis(mine) || isThis(theirs)) return fail(res, 409, 'NOT_PENDING');
        if (mine || theirs) {
            await retirePending(req.io, link, inviteeId);
            return fail(res, 409, 'ALREADY_LINKED');
        }

        // Left pending on purpose: one of them can cancel a plan and tap again
        // inside the same ten minutes.
        if (await bothHavePlans(me, inviteeId)) return fail(res, 409, 'BOTH_HAVE_PLANS');

        // The flip. Guarded on `pending` and on the clock so a decline, a
        // cancel or a lapse that lands first wins; and the partial unique
        // indexes refuse a second active link for either account even if two
        // Authorize taps on two different requests get this far together.
        let active;
        try {
            active = await AccountLink.findOneAndUpdate(
                {
                    _id: link._id,
                    inviter: me,
                    status: 'pending',
                    claimedAt: { $gt: new Date(now.getTime() - PENDING_TTL_MS) },
                },
                { $set: { status: 'active', authorizedAt: now }, $unset: { tokenHash: 1 } },
                { new: true }
            ).lean();
        } catch (err) {
            if (err && err.code === 11000) {
                await retirePending(req.io, link, inviteeId);
                return fail(res, 409, 'ALREADY_LINKED');
            }
            throw err;
        }
        if (!active) return fail(res, 409, 'NOT_PENDING');

        // The link is made. The car copy is a courtesy on top of it, so a
        // failure there is logged and the link stands.
        try {
            const before = await peopleById([me, inviteeId], '+vehicle');
            await copyCarIfOneSided(before.get(me), before.get(inviteeId));
        } catch (err) {
            console.error('account link: car copy failed —', err.message);
        }

        // Read back after the copy so each side is told what is actually on
        // its own profile now, whichever way the copy went (or didn't).
        const people = await peopleById([me, inviteeId], '+vehicle');
        const inviter = people.get(me);
        const invitee = people.get(inviteeId);

        emitTo(req.io, me, 'accountLink:active', {
            link: linkView(active, me),
            partner: partnerSummary(invitee),
            vehicle: vehicleView(inviter && inviter.vehicle),
        });
        emitTo(req.io, inviteeId, 'accountLink:active', {
            link: linkView(active, inviteeId),
            partner: partnerSummary(inviter),
            vehicle: vehicleView(invitee && invitee.vehicle),
        });

        res.status(200).json({
            success: true,
            link: linkView(active, me),
            partner: partnerSummary(invitee),
            vehicle: vehicleView(inviter && inviter.vehicle),
        });

        await pushQuietly(
            invitee,
            "You're linked",
            `${firstNameOf(partnerSummary(inviter), 'They')} approved it. You both see the same parks now.`,
            'active'
        );
    } catch (err) {
        console.error('account link authorize failed:', err);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Could not link. Try again.' });
        }
    }
};

/**
 * POST /api/account-link/decline  { userId, linkId }
 *
 * "Not them." The person who showed the code turns the scan away. The scanner
 * is told over the socket so their waiting screen goes back to the start; no
 * push — they are looking at the screen that would have told them.
 */
exports.decline = async (req, res) => {
    const me = idOf(req.callerUserId || req.body?.userId);
    const { linkId } = req.body || {};
    try {
        if (!linkId) return fail(res, 400, 'BAD_REQUEST');
        if (!mongoose.isValidObjectId(linkId)) return fail(res, 403, 'NOT_YOURS');

        const now = new Date();
        const link = await AccountLink.findById(linkId).lean();
        if (!link || idOf(link.inviter) !== me) return fail(res, 403, 'NOT_YOURS');
        if (link.status !== 'pending' || (await lapsed(link, now))) {
            return fail(res, 409, 'NOT_PENDING');
        }

        const declined = await AccountLink.findOneAndUpdate(
            { _id: link._id, inviter: me, status: 'pending' },
            {
                $set: { status: 'revoked', revokedAt: now, revokedBy: me },
                $unset: { tokenHash: 1 },
            },
            { new: true }
        ).lean();
        if (!declined) return fail(res, 409, 'NOT_PENDING');

        const inviteeId = idOf(declined.invitee);
        emitTo(req.io, inviteeId, 'accountLink:declined', { link: linkView(declined, inviteeId) });

        return res.status(200).json({ success: true });
    } catch (err) {
        console.error('account link decline failed:', err);
        return res.status(500).json({ success: false, message: 'Something went wrong. Try again.' });
    }
};

/**
 * POST /api/account-link/unlink  { userId }
 *
 * Either of the pair, any time (brief §1). Coverage for whoever does not hold
 * the plan ends with this write: nothing here touches an order or a plan —
 * the next getHouseholdSubscription simply stops finding the partner, and a
 * park already in progress finishes on the terms it was booked on.
 *
 * With no active link, this is also the scanner's "Cancel" on the waiting
 * screen: it withdraws their pending request and the person who showed the
 * code is told, so the Authorize card they are looking at goes back to the QR.
 * A request that ran out a moment before the tap is withdrawn the same way —
 * the person asked for there to be no request, and there is none.
 *
 *   404 NOT_LINKED — no link and no request to withdraw
 */
exports.unlink = async (req, res) => {
    const me = idOf(req.callerUserId || req.body?.userId);
    try {
        const now = new Date();
        const active = await activeLinkFor(me);

        if (active) {
            const revoked = await AccountLink.findOneAndUpdate(
                { _id: active._id, status: 'active' },
                {
                    $set: { status: 'revoked', revokedAt: now, revokedBy: me },
                    $unset: { tokenHash: 1 },
                },
                { new: true }
            ).lean();
            // The other side unlinked in the same instant. What this caller
            // asked for is already true, and that request did the telling.
            if (!revoked) return res.status(200).json({ success: true });

            const otherId = otherMemberOf(revoked, me);
            const people = await peopleById([me, otherId]);

            emitTo(req.io, me, 'accountLink:revoked', { link: linkView(revoked, me) });
            emitTo(req.io, otherId, 'accountLink:revoked', { link: linkView(revoked, otherId) });

            res.status(200).json({ success: true });

            await pushQuietly(
                people.get(otherId),
                'Account unlinked',
                `${firstNameOf(partnerSummary(people.get(me)), 'They')} unlinked from you. You no longer see each other's parks.`,
                'revoked'
            );
            return;
        }

        const waiting = await AccountLink.find({ invitee: me, status: 'pending' }).lean();
        if (!waiting.length) return fail(res, 404, 'NOT_LINKED');

        for (const link of waiting) {
            const ranOut = (expiresAtOf(link) || now).getTime() <= now.getTime();
            const withdrawn = await AccountLink.findOneAndUpdate(
                { _id: link._id, status: 'pending' },
                ranOut
                    ? { $set: { status: 'expired' } }
                    : {
                          $set: { status: 'revoked', revokedAt: now, revokedBy: me },
                          $unset: { tokenHash: 1 },
                      },
                { new: true }
            ).lean();
            if (withdrawn) {
                const inviterId = idOf(withdrawn.inviter);
                emitTo(req.io, inviterId, 'accountLink:declined', { link: linkView(withdrawn, inviterId) });
            }
        }
        return res.status(200).json({ success: true });
    } catch (err) {
        console.error('account link unlink failed:', err);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Something went wrong. Try again.' });
        }
    }
};

/**
 * GET /api/account-link/status?userId=
 *
 * The panel's one read, and its fallback when the socket is down — polled
 * every 3 s while the panel is open. Everything is from the caller's point of
 * view:
 *
 *   none     — nothing out. An open code or a request past its time reads as
 *              none (and is marked expired on the way).
 *   open     — this caller's code is on screen, unscanned
 *   pending  — `pendingFrom` when somebody scanned THIS caller's code (show
 *              Authorize); `waitingFor` when this caller scanned somebody's
 *              (show the spinner)
 *   active   — `partner`
 *
 * `plan` is the household's plan and whose it is — 'self', 'partner' or null —
 * so the panel can say "Your plan covers you both" or "[Name]'s plan covers
 * you both" without a second call. Its tier and display name only; the plan
 * itself is read, as ever, from /api/subscription/status.
 */
exports.status = async (req, res) => {
    const me = idOf(req.callerUserId || req.query?.userId);
    try {
        const now = new Date();
        const [link, household] = await Promise.all([
            currentLinkFor(me, now),
            getHouseholdSubscription(me, now),
        ]);

        const sub = household && household.sub;
        const plan = {
            heldBy: sub ? (household.heldBy === 'self' ? 'self' : 'partner') : null,
            tier: sub ? sub.tier : null,
            name: sub ? (getPlan(sub.tier) || {}).name || null : null,
        };

        const answer = {
            success: true,
            status: 'none',
            link: null,
            partner: null,
            pendingFrom: null,
            waitingFor: null,
            plan,
        };
        if (!link) return res.status(200).json(answer);

        answer.status = link.status;
        answer.link = linkView(link, me);

        const otherId = otherMemberOf(link, me);
        if (otherId && (link.status === 'active' || link.status === 'pending')) {
            const people = await peopleById([otherId]);
            const other = partnerSummary(people.get(otherId));
            if (link.status === 'active') answer.partner = other;
            else if (answer.link.role === 'inviter') answer.pendingFrom = other;
            else answer.waitingFor = scannerView(other);
        }

        return res.status(200).json(answer);
    } catch (err) {
        console.error('account link status failed:', err);
        return res.status(500).json({ success: false, message: 'Something went wrong. Try again.' });
    }
};

/**
 * Deleting an account revokes its link (brief §1). Called by
 * authController.deleteAccount BEFORE the user document goes, so the partner
 * is never left linked to an account that no longer exists — which would
 * leave them unable to link with anyone else, and, if the deleted account
 * held the plan, still covered by it.
 *
 *   active  → revoked; both rooms get accountLink:revoked and the partner the
 *             same push an unlink sends
 *   pending → revoked; whoever is on the other end gets accountLink:declined,
 *             so their Authorize card or waiting screen goes back to the start
 *   open    → revoked; nobody else is involved
 *
 * Each link is its own guarded write, so one that fails does not stop the
 * rest. The caller wraps the whole thing: this must never fail the delete.
 */
exports.revokeLinksForDeletedAccount = async (io, user) => {
    const me = idOf(user);
    if (!me) return;
    const now = new Date();

    const links = await AccountLink.find({
        $or: [{ inviter: me }, { invitee: me }],
        status: { $in: ['open', 'pending', 'active'] },
    }).lean();

    const leaving = partnerSummary(user);
    for (const link of links) {
        try {
            const revoked = await AccountLink.findOneAndUpdate(
                { _id: link._id, status: link.status },
                {
                    $set: { status: 'revoked', revokedAt: now, revokedBy: me },
                    $unset: { tokenHash: 1 },
                },
                { new: true }
            ).lean();
            if (!revoked || link.status === 'open') continue;

            const otherId = otherMemberOf(revoked, me);
            if (link.status === 'active') {
                emitTo(io, me, 'accountLink:revoked', { link: linkView(revoked, me) });
                emitTo(io, otherId, 'accountLink:revoked', { link: linkView(revoked, otherId) });
                const other = otherId
                    ? await User.findById(otherId).select('firebaseUid').lean()
                    : null;
                await pushQuietly(
                    other,
                    'Account unlinked',
                    `${firstNameOf(leaving, 'They')} unlinked from you. You no longer see each other's parks.`,
                    'revoked'
                );
            } else {
                emitTo(io, otherId, 'accountLink:declined', { link: linkView(revoked, otherId) });
            }
        } catch (err) {
            console.error('account link: revoke on account deletion failed —', err.message);
        }
    }
};

// For the tests: the TTLs and the parser, so a case can be written against
// the real numbers rather than copies of them.
exports.TOKEN_TTL_MS = TOKEN_TTL_MS;
exports.PENDING_TTL_MS = PENDING_TTL_MS;
exports.tokenFrom = tokenFrom;
