/**
 * accountLinks — every rule that reads a linked pair.
 *
 * Two accounts linked through models/AccountLink.js share their parks and a
 * plan. Nothing else in the codebase should query AccountLink directly for
 * those questions; it comes through here, so "who counts as this customer's
 * household" is answered in exactly one place:
 *
 *   householdIds             — whose parks this customer sees
 *   partnerOf / isLinkedPair — who they are linked with
 *   getHouseholdSubscription — which plan covers them, and whose it is
 *   householdCoveredParkLive — the one-park-at-a-time rule (coveredParkLiveBy:
 *                              the same rule, answering whose park it is)
 *
 * The other party is only ever described by `partnerSummary`: first and last
 * name, photo, and the last four digits of the phone. Never a user document —
 * GET /api/auth/getUserById already hands out whole records and this must not
 * become a second way to reach them.
 */

const AccountLink = require('../models/AccountLink');
const User = require('../models/User');
const Order = require('../models/Order');
const CurbCustody = require('../models/CurbCustody');
const subscriptionService = require('./subscriptionService');

const idOf = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);

// Exactly the fields the other party may see. Nothing else, ever.
const SUMMARY_FIELDS = 'firstName lastName profileImage phone';

/** The other party as the other party may see them. */
function partnerSummary(user) {
    if (!user) return null;
    const digits = String(user.phone || '').replace(/\D/g, '');
    return {
        _id: String(user._id),
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        profileImage: user.profileImage || null,
        phoneMasked: digits.slice(-4),
    };
}

/** "[First name]" for copy, with a plain fallback for an account that has none. */
function firstNameOf(summary, fallback = 'them') {
    const name = summary && typeof summary.firstName === 'string' ? summary.firstName.trim() : '';
    return name || fallback;
}

/** The active link this account is in, or null. */
async function activeLinkFor(userId) {
    const id = idOf(userId);
    if (!id) return null;
    return AccountLink.findOne({ members: id, status: 'active' }).lean();
}

/** The id of the account this one is linked with, or null. */
async function partnerIdOf(userId) {
    const id = idOf(userId);
    const link = await activeLinkFor(id);
    if (!link) return null;
    const other = (link.members || []).map(String).find((m) => m !== id);
    return other || null;
}

/**
 * Whose parks this customer sees: their own id first, then their partner's.
 * Strings, so they drop straight into `{ customer: { $in: ... } }`.
 */
async function householdIds(userId) {
    const id = idOf(userId);
    if (!id) return [];
    const partner = await partnerIdOf(id);
    return partner ? [id, partner] : [id];
}

/** The partner summary for this account, or null when it is not linked. */
async function partnerOf(userId) {
    const partner = await partnerIdOf(userId);
    if (!partner) return null;
    const user = await User.findById(partner).select(SUMMARY_FIELDS).lean();
    return partnerSummary(user);
}

/** True when `a` and `b` are two different accounts in one active link. */
async function isLinkedPair(a, b) {
    const x = idOf(a);
    const y = idOf(b);
    if (!x || !y || x === y) return false;
    const link = await AccountLink.exists({
        status: 'active',
        members: { $all: [x, y] },
    });
    return !!link;
}

/**
 * The plan that covers this customer: their own live plan if they hold one,
 * otherwise their partner's, otherwise none.
 *
 *   { sub, heldBy: 'self' }           — their own
 *   { sub, heldBy: partnerSummary }   — their partner's
 *   { sub: null, heldBy: null }       — nobody's
 *
 * Linking is refused while both hold a plan, so at most one of the two
 * lookups can answer. If both ever did (a plan bought in the same second as
 * an Authorize tap), their own wins: it is the one they can see and cancel.
 */
async function getHouseholdSubscription(userId, now = new Date()) {
    const id = idOf(userId);
    if (!id) return { sub: null, heldBy: null };

    const own = await subscriptionService.getActiveSubscription(id, now);
    if (own) return { sub: own, heldBy: 'self' };

    const partner = await partnerIdOf(id);
    if (!partner) return { sub: null, heldBy: null };

    const theirs = await subscriptionService.getActiveSubscription(partner, now);
    if (!theirs) return { sub: null, heldBy: null };

    const user = await User.findById(partner).select(SUMMARY_FIELDS).lean();
    return { sub: theirs, heldBy: partnerSummary(user) };
}

// Everything short of finished. Deliberately NOT customerActiveOrderQuery:
// that one drops a park the valet has closed out (`parkClosedAt`), and on the
// managed plans that is stamped at the end of every park while the car stays
// ours for weeks. A park is live until the car is back.
const LIVE_STATUSES = ['pending', 'accepted', 'in-progress', 'in_progress', 'parked', 'keys-returning'];


/**
 * The one-park-at-a-time rule: is some OTHER car already riding this plan?
 *
 * True when anyone other than `excludingUserId` (the person booking now) has
 *   - an order stamped with this plan that has not finished, or
 *   - a car we are still holding under this plan (an open CurbCustody row —
 *     on the managed plans the order behind a held car can complete while the
 *     car stays on the street, so the order alone would miss it), or
 *   - a paid park the plan will hold with no end time (`indefinite`) that it
 *     did not pay for — the second park of a day, or a Car Watch park, on the
 *     managed plans. Those carry no plan stamp, and their custody row only
 *     opens once the valet has parked, so between booking and parking they
 *     were invisible to the two checks above while still being a car the
 *     plan is about to look after. Only the plan holder's household is asked
 *     about these, since nothing on the order names the plan.
 *
 * WHEN, not just whether. `park` is the booking being asked about — when it
 * starts, how long it is, and whether the plan would hold it with no end
 * (`indefinite`) — and another car only blocks it if the two overlap in time.
 * Asking "is anything on the plan right now" gets it wrong both ways:
 *   - a covered move of hers next Tuesday would charge him list price for a
 *     move today, though the two never meet; and
 *   - his covered park booked for tomorrow on the $250 plan would NOT stop
 *     her covered park today, and tomorrow the plan would be holding two cars.
 *     A held park never ends, so it overlaps every park after it starts.
 * A park already under way (or overdue) counts as live at least until now,
 * whatever its booked end, because it is not over until the car is back. A
 * car we hold (open custody) has no end either. With no `park` given, the
 * question is "right now".
 *
 * Keyed on the plan, not the household, so a park an ex-partner booked before
 * unlinking still holds the plan until it ends — it finishes on the terms it
 * was booked on, and the plan is still carrying it.
 *
 * The booker's own parks never block them: createOrder already allows one
 * order in flight per account, and a retrieval of their own covered park must
 * stay covered.
 *
 * One function on purpose. A plan with an extra car on it (Nov 4 2026,
 * Subscription.extraCars, $150/mo each) covers that many parks at once: the
 * plan is busy only once the household's other parks fill every car on it.
 *
 * Answers WHOSE park it is — that account's id as a string — or null. The
 * quote has to name them ("Sam's park is using the plan"), and it may only do
 * so when that account is the booker's partner today: after an unlink the
 * park riding the plan can be an ex's, and their name is not the new
 * partner's business. `householdCoveredParkLive` below is the yes/no every
 * other caller asks; it is this, and nothing else.
 */
async function coveredParkLiveBy(sub, excludingUserId = null, park = {}) {
    if (!sub || !sub._id) return null;
    const exclude = idOf(excludingUserId);
    const notBooker = exclude ? { $ne: exclude } : { $exists: true };
    const nowMs = Date.now();
    const asked = parkWindow(park, nowMs);

    const { carsOnPlan } = require('./subscriptionService');
    const cars = carsOnPlan(sub);

    // Held with no end: overlaps any park from now on.
    const held = await CurbCustody.find({
        subscription: sub._id,
        customer: notBooker,
        closedAt: { $exists: false },
    })
        .select('customer')
        .lean();
    const busy = held.map((h) => idOf(h.customer));
    if (busy.length >= cars) return busy[0];

    const others = (await householdIds(sub.user)).filter((m) => m !== exclude);
    const riding = await Order.find({
        status: { $in: LIVE_STATUSES },
        $or: [
            { coveredBySubscription: sub._id, customer: notBooker },
            ...(others.length
                ? [
                      {
                          customer: { $in: others },
                          orderType: 'parking',
                          indefinite: true,
                          coveredBySubscription: null, // missing or null: the plan did not pay
                          // An abandoned checkout is not a car on the plan.
                          paymentStatus: 'paid',
                      },
                  ]
                : []),
        ],
    })
        .select('customer status pickUpTime duration indefinite')
        .lean();

    for (const o of riding) {
        const w = orderWindow(o, nowMs);
        if (w.start < asked.end && w.end > asked.start) busy.push(idOf(o.customer));
    }
    return busy.length >= cars ? busy[0] : null;
}

const MINUTE_MS = 60 * 1000;

/** When the booking being asked about would be on the plan. */
function parkWindow({ at, durationMinutes, indefinite } = {}, nowMs) {
    const t = at ? new Date(at).getTime() : NaN;
    const start = Number.isFinite(t) ? t : nowMs;
    const minutes = Math.max(1, Number(durationMinutes) || 0);
    return { start, end: indefinite ? Infinity : start + minutes * MINUTE_MS };
}

/** When an existing order is (or will be) on the plan. */
function orderWindow(order, nowMs) {
    const t = order.pickUpTime ? new Date(order.pickUpTime).getTime() : NaN;
    const start = Number.isFinite(t) ? t : nowMs;
    let end = order.indefinite ? Infinity : start + (Number(order.duration) || 0) * MINUTE_MS;
    // Started or overdue: not over until the car is back, so live through now.
    if (start <= nowMs) end = Math.max(end, nowMs + MINUTE_MS);
    return { start, end };
}

/** The one-park-at-a-time rule as a yes/no. See `coveredParkLiveBy`. */
async function householdCoveredParkLive(sub, excludingUserId = null, park = {}) {
    return !!(await coveredParkLiveBy(sub, excludingUserId, park));
}

/**
 * Send an order event to the customer's socket room, and to their partner's.
 *
 * Both of them see every park either one booked, so a park's live updates —
 * valet accepted, parked, on the way back, cancelled — have to reach both home
 * screens, not just the booker's. Every customer-room order emit goes through
 * here instead of `io.to(customer)` so there is one place that knows who else
 * is watching. Valet rooms are not households and never come through here.
 *
 * The booker's emit goes out first and synchronously, before anything is
 * looked up, so an unlinked customer is served exactly as they always were and
 * a failed lookup can only ever cost the partner their copy. One AccountLink
 * read per call (indexed on members + status), which is why even the valet's
 * location pings can afford it.
 *
 * Sockets, not pushes. Park pushes still go to whoever booked, and only them.
 *
 * The partner's copy goes through `orderForPartner`: a few emits carry the
 * order with its customer populated (email, phone, the lot), and the booker's
 * details must reach the partner as a partner summary or not at all.
 *
 * Never throws: an emit is a courtesy on top of a write that already landed.
 */
async function emitToHousehold(io, customerId, event, payload) {
    const id = idOf(customerId);
    if (!io || !id) return;
    try {
        io.to(id).emit(event, payload);
    } catch (err) {
        console.error('emitToHousehold: emit to', id, 'failed:', err.message);
    }
    try {
        const partner = await partnerIdOf(id);
        if (partner) io.to(partner).emit(event, partnerPayload(payload));
    } catch (err) {
        console.error('emitToHousehold: partner emit for', id, 'failed:', err.message);
    }
}

/**
 * An order as the booker's partner may receive it.
 *
 * Everything about the park stays — status, where it is, the live code (either
 * of them may be the one at the curb when the car comes back). Two things
 * about the BOOKER do not:
 *   - a populated `customer` (some reads populate email and phone onto it)
 *     becomes that customer's partner summary, the only shape of the other
 *     party that leaves the server;
 *   - the booker's payments: every Stripe id (the park's PaymentIntent, the
 *     charge, each extension's and away charge's intent, the secret of the
 *     charge itself), the hosted receipt link, and the card's brand and last
 *     four. The brief's rule is that no Stripe id of one reaches the other
 *     and no card is ever shared. Amounts stay — what a park cost is part of
 *     the park — and so does paymentStatus. No client reads any of the
 *     removed fields off an existing order; the web's "Visa ···· 4242" line
 *     is drawn only when they are there, so on a partner's park it is not.
 *
 * Returns a plain object; the booker's own copy is never touched.
 */
function orderForPartner(order) {
    if (!order || typeof order !== 'object') return order;
    const plain = typeof order.toJSON === 'function' ? order.toJSON() : { ...order };
    const c = plain.customer;
    if (c && typeof c === 'object' && !c._bsontype && c._id) {
        plain.customer = partnerSummary(c);
    }
    delete plain.paymentIntentId;
    if (plain.paymentDetails && typeof plain.paymentDetails === 'object') {
        const { clientSecret, chargeId, receiptUrl, paymentMethodDetails, ...rest } = plain.paymentDetails;
        plain.paymentDetails = rest;
    }
    if (Array.isArray(plain.extensions)) {
        plain.extensions = plain.extensions.map(({ paymentIntentId, ...e }) => e);
    }
    if (Array.isArray(plain.awayCharges)) {
        plain.awayCharges = plain.awayCharges.map(({ paymentIntentId, ...e }) => e);
    }
    if (plain.retrievalRefund && typeof plain.retrievalRefund === 'object') {
        const { refundId, ...rest } = plain.retrievalRefund;
        plain.retrievalRefund = rest;
    }
    if (plain.checkout && typeof plain.checkout === 'object') {
        // A decline reason is about the booker's card.
        const { failureCode, failureMessage, ...rest } = plain.checkout;
        plain.checkout = rest;
    }
    return plain;
}

// Order events come in three shapes — the order itself, the order spread with
// a `type`, and `{ type, order }` — and all three are cleaned the same way.
function partnerPayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    if (payload.order && typeof payload.order === 'object' && !payload.orderType) {
        return { ...payload, order: orderForPartner(payload.order) };
    }
    return orderForPartner(payload);
}

module.exports = {
    emitToHousehold,
    orderForPartner,
    partnerSummary,
    firstNameOf,
    activeLinkFor,
    partnerIdOf,
    householdIds,
    partnerOf,
    isLinkedPair,
    getHouseholdSubscription,
    householdCoveredParkLive,
    coveredParkLiveBy,
    LIVE_STATUSES,
    SUMMARY_FIELDS,
};
