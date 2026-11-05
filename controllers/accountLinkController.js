/**
 * accountLinkController — two customer accounts becoming a pair.
 *
 * A customer texted Rishi: "How can Peter and I share an account?" The answer
 * is a link. Both keep their own login, profile, card and history; each sees
 * the other's parks; a plan held by either covers both, one park at a time.
 * Every rule that READS a pair lives in services/accountLinks.js. This file is
 * only the handshake that makes one and the ways it ends.
 *
 * THE HANDSHAKE (Nov 4: by phone number; the Sep 23 QR code is gone).
 *
 *   POST /request    type their number, send a request            → pending
 *   POST /authorize  the person asked taps Accept                  → active
 *   POST /decline    …or Decline                                   → revoked
 *   POST /unlink     either side, any time; also the sender's
 *                    "Cancel request" while it waits               → revoked
 *   GET  /status     the panel's one read, polled every 3 s
 *
 * Accept is the one verification step, and it sits with the person asked:
 * anyone can type a number, so sending proves nothing. The person asked sees
 * the sender's name AND their full phone number (a name is whatever someone
 * typed into their profile; the number is the one they signed in with) and
 * says yes.
 *
 * NOTHING LEAKS TO A SENDER. Every request is answered the same way whatever
 * is behind the number: an account, no account, a valet, someone already
 * linked. The sender sees the number they typed and nothing else until the
 * person asked accepts — never a name. A number with no account keeps the
 * request (`inviter` unset) until someone signs up with it and reads their
 * status, which attaches it.
 *
 * Nothing sweeps expired rows; every read that finds a request past its time
 * marks it `expired` there and then (`lapsed`), so the answer is right
 * whoever asks first.
 *
 * WHAT LEAVES THE SERVER about the other person is `partnerSummary` (first and
 * last name, photo, last four digits of the phone) — plus, to the person asked
 * and only while they decide, the sender's full number. Their firebaseUid is
 * read here to push them, and never returned.
 *
 * NO TRANSACTIONS. There are none anywhere in this codebase and the tests run
 * on a standalone mongodb-memory-server that cannot hold one. Every state
 * change below is a single conditional write guarded on the status it expects
 * to find, and the partial unique indexes on models/AccountLink.js are the
 * last word on "one active link per account": a race that gets past every
 * check here still cannot write a second active link, and its E11000 is
 * answered as ALREADY_LINKED.
 */

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

// How long a request waits for Accept. Long enough for someone who is not
// looking at their phone, or has to download the app first.
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Error copy. The clients map `code` to their own copy and fall back to
// "Something went wrong. Try again."; `message` is here so an API reader, or
// an older client, still gets a sentence a person can act on.
const MESSAGES = {
    BAD_PHONE: 'Enter their full phone number.',
    SELF_LINK: "That's your own number.",
    ALREADY_LINKED: 'That account is already linked with someone.',
    BOTH_HAVE_PLANS: 'You both have a plan. One of you has to cancel theirs first.',
    NOT_PENDING: 'That request is no longer waiting.',
    NOT_LINKED: "You're not linked with anyone.",
    NOT_YOURS: 'That request is not yours.',
    NOT_A_CUSTOMER: 'Only customer accounts can link.',
    BAD_REQUEST: 'linkId is required',
};

const fail = (res, status, code) =>
    res.status(status).json({ success: false, code, message: MESSAGES[code] });

const idOf = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);

/**
 * A phone number as accounts store it (E.164), or null. US numbers may come
 * as typed — "(718) 555-0142", "718-555-0142", "17185550142"; anything with a
 * leading + is taken as already international.
 */
function normalizePhone(raw) {
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    const text = String(raw).trim();
    const digits = text.replace(/\D/g, '');
    if (text.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return null;
}

/** When a request runs out: PENDING_TTL_MS after it was sent. */
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
 * Is this request past its time? If so it is marked `expired` here — nothing
 * else sweeps them — and the caller treats it as gone.
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
 * The sender as the person asked sees them while deciding: the summary, plus
 * their full phone number. A name is whatever someone typed into a profile;
 * the number is the one they sign in with, and the person asked knows their
 * partner's number. Same keys as a partner summary, plus `phone`.
 */
const requesterView = (user) => {
    const summary = partnerSummary(user);
    if (!summary) return null;
    return { ...summary, phone: normalizePhone(user && user.phone) || '' };
};

/**
 * Linking is for two customer accounts (brief §1). A valet linked to a
 * customer would pass the partner gates on that customer's parks — tip off
 * their card, extend on it, read the release codes. The Link account row only
 * exists on the customer Profile; this is the server saying the same. A
 * request to a valet's number goes nowhere, and its sender is not told so.
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
/**
 * The customer account a number belongs to, or null. Accounts store E.164,
 * but older ones may lack the + or the country code, so all three spellings
 * of a US number are tried.
 */
async function customerByPhone(phone) {
    if (!phone) return null;
    const spellings = [phone];
    if (phone.startsWith('+1') && phone.length === 12) spellings.push(phone.slice(1), phone.slice(2));
    return User.findOne({
        phone: { $in: spellings },
        isValet: { $ne: true },
        isDoorman: { $ne: true },
        isDeleted: { $ne: true },
    })
        .select(`${SUMMARY_FIELDS} firebaseUid`)
        .lean();
}

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
 * `notifyUserId` is whoever is left looking at it: the sender, whose waiting
 * screen goes back to the number field, or the person asked, whose Accept
 * screen goes away. `accountLink:declined` is what does both.
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
 * Every request this account is in, either way round, retired. A new request
 * replaces the last one sent, and someone sending one is not also deciding on
 * one sent to them (the panel shows the one sent to them first, so this only
 * happens in a race). Each had a person on the other end, who is told.
 */
async function retireRequestsOf(io, me, now = new Date()) {
    const outstanding = await AccountLink.find({
        $or: [{ inviter: me }, { invitee: me }],
        status: 'pending',
    }).lean();
    for (const link of outstanding) {
        if (await lapsed(link, now)) continue;
        const other = idOf(link.inviter) === me ? idOf(link.invitee) : idOf(link.inviter);
        await retirePending(io, link, other);
    }
}

/**
 * Requests sent to this account's number before it existed (or while its
 * number had no account) become requests TO it: the first status read after
 * sign-up attaches them. Guarded on `inviter` still being unset, so two reads
 * in the same instant attach each request once.
 */
async function attachRequestsByPhone(me, now = new Date()) {
    const self = await User.findById(me).select('phone isValet isDoorman isDeleted').lean();
    if (!self || self.isValet || self.isDoorman || self.isDeleted) return;
    const phone = normalizePhone(self.phone);
    if (!phone) return;
    const waiting = await AccountLink.find({
        requestedPhone: phone,
        status: 'pending',
        inviter: { $exists: false },
    }).lean();
    for (const link of waiting) {
        if (await lapsed(link, now)) continue;
        const senderId = idOf(link.invitee);
        if (!senderId || senderId === me) continue;
        await AccountLink.updateOne(
            { _id: link._id, status: 'pending', inviter: { $exists: false } },
            { $set: { inviter: me, members: [me, senderId] } }
        );
    }
}

/**
 * The link this account is in right now, from its own point of view, or null.
 *
 * Active beats pending. Two people can each have sent this account a request:
 * the newest is the one on screen, and the other shows once that one is
 * answered (or lapses on its own clock).
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

const { carsOf } = require('../services/accountVehicle');
const hasPlate = (user) => carsOf(user).length > 0;

/**
 * Car details are copied once, never overwritten (brief §1).
 *
 * If exactly one of the two has cars saved under Profile → Your cars, they
 * are copied into the other's empty list (Rishi, Nov 4 2026: "linked accounts
 * initially default to whatever car is already in the your car section"); both
 * or neither, nothing happens. "Has a car" means a plate — the app will not
 * save a car without one. A car either of them parks later reaches the other
 * once the park ends on that car (services/accountVehicle.js shareConfirmedCar).
 *
 * The write is conditional on the receiving account STILL having no plate, so
 * a car saved on the other phone in the same second is never overwritten by
 * this copy. A plain profile copy on purpose: a plan will later carry its own
 * list of cars (brief §10), and that must not be built out of this.
 */
async function copyCarIfOneSided(a, b) {
    if (hasPlate(a) === hasPlate(b)) return;
    const [from, to] = hasPlate(a) ? [a, b] : [b, a];
    // Copied from the partner's own entries (services/accountVehicle.js).
    const list = carsOf(from).map((v) => ({
        color: v.color || '',
        model: v.model || '',
        licensePlate: v.licensePlate,
        source: 'customer',
        at: new Date(),
    }));
    await User.updateOne(
        // `$in: [null, '']` matches a missing plate, a null one and an empty
        // one — every way a car can be "not saved"; and no list either.
        { _id: to._id, 'vehicle.licensePlate': { $in: [null, ''] }, 'vehicles.0': { $exists: false } },
        { $set: { vehicles: list, vehicle: list[0] } }
    );
}

/* -------------------------------------------------------------------------- */

/**
 * POST /api/account-link/request  { userId, phone }
 *
 * "Link with someone": the number is the other person's. Refusals are only
 * ever about the sender, never about the number's owner:
 *
 *   403 NOT_A_CUSTOMER — the sender is a valet or a doorman
 *   400 BAD_PHONE      — not a phone number
 *   400 SELF_LINK      — their own number
 *   409 ALREADY_LINKED — the SENDER is already in a link
 *
 * Everything else is the same 200, `{ link, askedPhone }`, whatever is behind
 * the number — an account, none, a valet, someone already linked — so typing
 * numbers tells nobody anything. Both-have-plans is asked at Accept for the
 * same reason. A new request replaces the last one this account sent.
 */
exports.request = async (req, res) => {
    const me = idOf(req.callerUserId || req.body?.userId);
    try {
        if (!(await isCustomer(me))) return fail(res, 403, 'NOT_A_CUSTOMER');
        const phone = normalizePhone(req.body?.phone);
        if (!phone) return fail(res, 400, 'BAD_PHONE');
        const self = await User.findById(me).select('phone').lean();
        if (self && normalizePhone(self.phone) === phone) return fail(res, 400, 'SELF_LINK');
        if (await activeLinkFor(me)) return fail(res, 409, 'ALREADY_LINKED');

        const now = new Date();
        await retireRequestsOf(req.io, me, now);

        const target = await customerByPhone(phone);
        const targetId = target && idOf(target) !== me ? idOf(target) : null;
        const created = await AccountLink.create({
            ...(targetId ? { inviter: targetId } : {}),
            invitee: me,
            members: targetId ? [targetId, me] : [me],
            status: 'pending',
            claimedAt: now,
            requestedPhone: phone,
        });
        const link = created.toObject();

        // Told only when there is someone to tell. Someone already linked
        // keeps the request (it is theirs to answer if they unlink while it
        // waits) but is not pushed about a link they cannot make.
        const tell = targetId && !(await activeLinkFor(targetId));
        let from = null;
        if (tell) {
            const people = await peopleById([me]);
            from = requesterView(people.get(me));
            emitTo(req.io, targetId, 'accountLink:requested', { link: linkView(link, targetId), from });
        }

        res.status(200).json({ success: true, link: linkView(link, me), askedPhone: phone });

        // After the answer: the request has been made whether or not the push
        // lands.
        if (tell) {
            await pushQuietly(
                target,
                'Link request',
                `${firstNameOf(from, 'Someone')} wants to link accounts. Open Profile → Link account to answer.`,
                'pending'
            );
        }
    } catch (err) {
        console.error('account link request failed:', err);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Could not send that. Try again.' });
        }
    }
};

/**
 * POST /api/account-link/authorize  { userId, linkId }
 *
 * Accept — the one verification step: the person asked has seen the sender's
 * name and number and says yes. Only they can; the sender accepting their own
 * request would make the step mean nothing.
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
        // request, it can never succeed — take it off the table so the
        // sender's waiting screen goes back to the number field instead of
        // waiting until the clock runs out.
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

        // Left pending on purpose: one of them can cancel a plan and tap
        // Accept again while the request is still waiting.
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
            const before = await peopleById([me, inviteeId], '+vehicle +vehicles');
            await copyCarIfOneSided(before.get(me), before.get(inviteeId));
        } catch (err) {
            console.error('account link: car copy failed —', err.message);
        }

        // Read back after the copy so each side is told what is actually on
        // its own profile now, whichever way the copy went (or didn't).
        const people = await peopleById([me, inviteeId], '+vehicle +vehicles');
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
            `${firstNameOf(partnerSummary(inviter), 'They')} accepted. You both see the same parks now.`,
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
 * Decline. The sender is told over the socket so their waiting screen goes
 * back to the number field; no push.
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

        // The sender's "Cancel request" — including one to a number with no
        // account yet, which has nobody else to tell.
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
 *   none     — nothing out. A request past its time reads as none (and is
 *              marked expired on the way).
 *   pending  — `pendingFrom` (with their full number) when somebody asked THIS
 *              caller (show Accept / Decline); `askedPhone` when this caller
 *              asked somebody (show "Request sent")
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
        // A request sent to this number before the account existed is this
        // account's to answer now.
        await attachRequestsByPhone(me, now);
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
            askedPhone: null,
            plan,
        };
        if (!link) return res.status(200).json(answer);

        answer.status = link.status;
        answer.link = linkView(link, me);
        // The sender sees the number they typed, and never the name behind
        // it before an Accept.
        if (link.status === 'pending' && answer.link.role === 'invitee') {
            answer.askedPhone = link.requestedPhone || null;
        }

        const otherId = otherMemberOf(link, me);
        if (otherId && (link.status === 'active' || link.status === 'pending')) {
            const people = await peopleById([otherId]);
            const other = partnerSummary(people.get(otherId));
            // `waitingFor` stays null: see askedPhone.
            if (link.status === 'active') answer.partner = other;
            else if (answer.link.role === 'inviter') answer.pendingFrom = requesterView(people.get(otherId));
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

// For the tests: the wait and the number parser, so a case can be written
// against the real ones rather than copies of them.
exports.PENDING_TTL_MS = PENDING_TTL_MS;
exports.normalizePhone = normalizePhone;
