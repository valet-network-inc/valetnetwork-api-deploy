/**
 * shareController
 *
 * A standing handoff link the customer gives to whoever is actually standing
 * at the curb — almost always their doorman.
 *
 * Why it exists: Randi, a weekly street-cleaning subscriber, leaves her key at
 * the front desk for her 8:30am move and is in a meeting when the valet
 * arrives. She asked for the code the night before. She cannot have it — at
 * that beat the code is the VALET'S, read out loud on arrival, and the person
 * with the keys types it back. So what the doorman needs is not a number in
 * advance, it is a screen to type into. This serves that screen.
 *
 * The token hangs on the CUSTOMER, not on one order: she texts the front desk
 * one URL, once, and it has to still work next Thursday. It resolves to
 * whatever order she has live at the moment it is opened — the same query her
 * own phone's home screen runs — and between jobs it shows the next sweep
 * instead of going blank.
 *
 * It also carries the doorman's half of the chat, because the whole job is a
 * conversation — "I'm at the front desk, come to the lobby" — and he has no
 * app to say it in. That is proxied here rather than done from his browser;
 * see the section at the foot of this file for why.
 *
 * What it is NOT: a login. The token is a bearer credential that ends in a car
 * being released, so it is deliberately thin —
 *   - it answers with a redacted view of one order and nothing else. No phone,
 *     no email, no home address, no ids, no payment;
 *   - it shows a code, or an entry box, ONLY inside a real handoff window.
 *     "A code exists" is not "a handoff is happening", and the August 31
 *     failure was exactly that confusion;
 *   - the window is re-derived server-side on verify, so a page that was
 *     served a box cannot spend it once the window has shut;
 *   - a leaked link gets a fixed, non-renewing budget of wrong guesses;
 *   - the customer can revoke it, and that is the only off switch.
 *
 * Making one and switching one off are the two ends that belong to the
 * customer, and both ask for her Firebase ID token — see `callerFirebaseUid`.
 * They used to take a bare `userId`, which is not a secret: the pending-order
 * feed publishes customer ObjectIds to anybody. Revoking also still answers to
 * the token itself, because the phone that shared the link is holding one and
 * that is the everyday way to stop.
 */

const crypto = require('crypto');

const Order = require('../models/Order');
const User = require('../models/User');
const {
    applyOtpVerification,
    customerActiveOrderQuery,
    liveKeyReturnLeg,
    retrievalHasCustody,
} = require('./orderController');
const { sendPushNotification } = require('./notificationController');
// Two identical copies of this function exist. Taken from the service rather
// than from notificationController because that file is carrying a held badge
// fix: if it ships at HEAD the import is undefined and this whole page 500s on
// its first ETA.
const { haversineMeters } = require('../services/subscriptionService');
const { nextNyOccurrence } = require('../services/nyTime');

// Where the doorman's screen lives. Same env-with-a-default shape the rest of
// the codebase uses for absolute URLs (see PAYMENT_SUCCESS_URL).
const SHARE_BASE_URL = process.env.PUBLIC_SITE_URL || 'https://valetnetwork.co';

// A finished order has no handoff left to run.
const CLOSED_STATUSES = ['completed', 'cancelled'];

// The pace both mobile and /park fall back to when Google can't be reached.
// A valet crossing Carroll Gardens on foot is the only case this covers.
const WALK_METERS_PER_SECOND = 1.4;

/**
 * Wrong codes one link may type at one beat, ever.
 *
 * The rolling limiter in middleware/rateLimit.js is burst control: its window
 * reopens, so a leaked link guessing patiently all night walks six digits at
 * its own pace and gets there. This one never resets. Ten wrong guesses at a
 * million codes is a one-in-a-hundred-thousand shot, and no doorman has ever
 * needed an eleventh.
 */
const MAX_TYPE_BEAT_ATTEMPTS = 10;

/**
 * Which handoff, if any, is open on this order right now.
 *
 * The single source of truth for the whole feature: GET renders from it,
 * verify re-runs it before touching anything, and the tests read it directly.
 * Two beats exist and they are not symmetrical —
 *
 *   TYPE — the valet reads a number aloud and whoever holds the keys types it.
 *          The link holder is the typist, so the code must NEVER appear here;
 *          printing it would let the link alone take a car.
 *   SAY  — the number is the customer's to speak and the VALET types it. The
 *          link holder is the speaker, so the code is shown and the endpoint
 *          refuses to verify it.
 *
 * A live `otp.code` is not a window. The August 31 failure was reading it as
 * one: a booking nobody has taken, an ASP park whose valet is keeping the keys
 * through the sweep, and a finished park sitting on a `return_key` code staged
 * for a return trip nobody has asked for yet all carry a live code and none of
 * them is a handoff.
 *
 * The two beats need different gates, and only one of them needs a gate about
 * where anybody is standing:
 *
 *   TYPE. The code is the valet's, spoken aloud, and the doorman types it
 *   back. Nothing secret is ever on his screen, and a keypad without the
 *   valet's number does nothing at all — so a valet on the job and a live
 *   type-beat code is the whole test HERE. When the box is actually drawn is a
 *   separate question, and a softer one: see `valetHasReadTheCodeOut` below,
 *   which holds the screen on "on his way" until the valet's own app says he
 *   read the number out, and fails open. It is not a lock, and this is why —
 *   verify goes on accepting a correct code whatever that check believes.
 *
 *   SAY. This one IS the number, so it still needs a gate — but tied to a
 *   recorded event rather than a guess. On a retrieval the event is custody:
 *   beat 1 verified, which is the same write that mints this code. That is
 *   exactly what the customer's own phone shows her, so her app, the valet's
 *   and the link agree by construction. On a park it is the short walk between
 *   leaving the car in a spot and closing the job out.
 *
 * What used to be here was a proximity test on `order.valetLocation`, and it
 * was wrong in both directions. It failed CLOSED on the mornings it mattered:
 * that field is written only for the ONE order a valet has open
 * (`startLocationTracking(true, activeOrder._id)`), and valets have carried
 * several jobs at once since 2026-08-15, so on a busy Thursday it is routinely
 * absent and every doorman got a blank screen instead of a keypad. And it was
 * forgeable — `POST /api/order/updateValetLocation` takes anybody's word for
 * where a valet is — so it was never the lock it read as.
 *
 * Reads the stored document, not `toJSON()`: the old-dialect translation
 * rewrites `status`, and every gate here wants the field it was written from.
 */
const handoffWindow = async (order) => {
    const shut = (reason) => ({ beat: null, code: null, reason });

    if (!order) return shut('no_live_order');
    if (CLOSED_STATUSES.includes(order.status)) return shut('order_closed');

    const otp = order.otp;
    if (!otp?.code || otp.verified) return shut('no_live_code');

    const isRetrieval = order.orderType === 'retrieval';
    // The backend's own custody helper, never `aspMode` on its own. A sweep
    // leg minted before `aspMode` was stamped on legs looks untouched by
    // every cheap test, and calling it "keys not handed over yet" is what put
    // an entry box under a valet who had been holding the keys since 8am.
    const custody = await retrievalHasCustody(order);

    // Beat 1. A park announces it with `order_creation`; a retrieval is on
    // beat 1 for exactly as long as the valet has not taken the keys, whichever
    // of the two OTP types it was born with.
    if (otp.type === 'order_creation' || (isRetrieval && !custody)) {
        if (!order.valet) return shut('nobody_has_taken_this_job');
        return { beat: 'type', code: null, reason: 'valet_on_the_job' };
    }

    if (otp.type !== 'return_key') return shut('not_a_handoff_code');

    // Somebody has to be on the job before a number goes on screen.
    //
    // The type beat has always asked this. The say beat did not, and it is the
    // beat that PRINTS the code — it opened on `custody`, which reads `aspMode`
    // as "the valet has the keys" because a sweep leg is born that way. A flag
    // is not a person standing at the curb: `valetCancelOrder` stands a leg
    // down by clearing `order.valet` and putting it back on the board, the flag
    // survives that untouched, and the doorman was left reading digits out to
    // an empty lobby while his messages reached nobody.
    if (!order.valet) return shut('nobody_has_taken_this_job');

    if (isRetrieval) {
        // Beat 2, and `custody` is true or the branch above would have taken
        // this — the valet is holding the keys, whether he took them at beat 1
        // or has had them since the sweep started. This code was minted by the
        // write that recorded that, so its existence and the custody stamp are
        // the same fact seen twice.
        return { beat: 'say', code: otp.code, reason: 'valet_has_the_keys' };
    }

    // A park. The window is the short walk between leaving the car in a spot
    // and closing the job out, which is when the keys come back.
    if (order.status !== 'parked') return shut('car_not_parked_yet');
    if (order.parkClosedAt) return shut('park_closed_out');
    // Randi's morning. On a sweep the valet keeps the keys straight through —
    // there is no key return while the car sits parked, and the code staged on
    // this order belongs to the return leg the sweep will mint later.
    if (order.aspMode) return shut('valet_keeps_the_keys_through_the_sweep');
    // The same fact on the flat plans, for the whole life of the park rather
    // than just a sweep. `updateCarLocation` mints a return-key code at EVERY
    // park, so between the valet saving the spot and swiping the job closed
    // this window would print a number for a key handoff nobody is walking to.
    if (order.keysStayWithValet) return shut('valet_keeps_the_keys');

    return { beat: 'say', code: otp.code, reason: 'keys_coming_back' };
};

exports.handoffWindow = handoffWindow;

/* ---------------------------------------------------------------------------
 * Has the valet actually turned up?
 *
 * `handoffWindow` opens the type beat the moment somebody accepts the job,
 * which is right about who may type and wrong about when. Accepting happens
 * from wherever the valet is standing when the job appears — twenty minutes
 * and a subway ride from the building on a normal morning — so the doorman was
 * handed a keypad long before there was anybody to read him a number, and the
 * "Marco is on his way" screen, which is the honest one for that stretch, never
 * rendered at all.
 *
 * The signal is the valet's own app. It posts the code into the Firestore
 * thread at the exact moment he reads it aloud — `sendParkHoldCollectOTP`,
 * tagged `otp_collect_keys`, fired from hooks/useConversation.js when he taps
 * arrival — so that message existing IS the arrival, recorded by the party who
 * performed it rather than claimed by anybody. Unlike `valetLocation` it is not
 * forgeable by a stranger with an order id: writing it needs the thread, and
 * the thread is not on the wire.
 *
 * Matched on THIS order's live code, not on a timestamp. One ASP conversation
 * carries both legs of the morning and both announce themselves this way; the
 * code is what separates them, and ordering by time beside an equality filter
 * would need a Firestore composite index on a path this page polls.
 *
 * It FAILS OPEN. If Firestore is unreachable, or the read throws, the keypad
 * goes up. Nothing secret is on that screen — the number is the valet's, spoken
 * out loud, and an empty box gives away nothing — so a doorman who can't type
 * costs more than a doorman who can type early. Availability beats precision
 * here.
 * -------------------------------------------------------------------------*/

// The page polls every four seconds; this is not a per-poll Firestore read.
// Once the beat has opened it never asks again, and before that it asks at
// most this often — so the whole morning's wait costs a few dozen reads.
const ARRIVAL_RECHECK_MS = 15 * 1000;

// The thread is one job long and these are tagged, so anything past this is a
// conversation that has already answered the question several times over.
const ARRIVAL_SCAN_LIMIT = 20;

// `${orderId}:${code}` -> { announced, answer, checkedAt }. Per-process, like
// the rate limiter beside it: losing it costs one extra read.
const arrivalChecks = new Map();
const ARRIVAL_CACHE_MAX = 1000;

const rememberArrival = (key, entry) => {
    if (arrivalChecks.size >= ARRIVAL_CACHE_MAX) {
        const stale = Date.now() - 6 * 60 * 60 * 1000;
        for (const [k, v] of arrivalChecks) {
            if (v.checkedAt < stale) arrivalChecks.delete(k);
        }
        // Still full: every entry is recent, which means a morning busier than
        // this cache was sized for. Start it over rather than grow forever.
        if (arrivalChecks.size >= ARRIVAL_CACHE_MAX) arrivalChecks.clear();
    }
    arrivalChecks.set(key, entry);
};

const valetHasReadTheCodeOut = async (order, conversationId) => {
    const code = order?.otp?.code;
    // Nothing to match against, and nowhere to look. Both are the fail-open
    // case rather than a reason to hold the keypad back.
    if (!code || !conversationId) return true;

    const key = `${order._id}:${code}`;
    const held = arrivalChecks.get(key);
    if (held?.announced) return true;
    if (held && Date.now() - held.checkedAt < ARRIVAL_RECHECK_MS) return held.answer;

    try {
        const admin = require('firebase-admin');
        const snapshot = await admin
            .firestore()
            .collection('conversations')
            .doc(String(conversationId))
            .collection('messages')
            // One equality filter and no ordering, so this rides the automatic
            // single-field index and needs nothing deployed alongside it.
            .where('messageType', '==', 'otp_collect_keys')
            .limit(ARRIVAL_SCAN_LIMIT)
            .get();

        const announced = snapshot.docs.some((doc) =>
            String(doc.data()?.text || '').includes(code)
        );
        rememberArrival(key, { announced, answer: announced, checkedAt: Date.now() });
        return announced;
    } catch (err) {
        console.error('Arrival check failed, showing the keypad anyway:', err.message);
        rememberArrival(key, { announced: false, answer: true, checkedAt: Date.now() });
        return true;
    }
};

/**
 * The one word the doorman's screen renders itself from.
 *
 * Derived from the window rather than beside it, so `stage` and `needsEntry`
 * cannot contradict each other — a screen that says "waiting for a valet" over
 * a keypad is how a doorman types a correct code into a page that was never
 * going to accept it.
 */
const handoffStage = (order, window, valetHasKeys) => {
    if (order.status === 'cancelled') return 'cancelled';
    if (order.status === 'completed') return 'done';
    if (window.beat === 'type') return 'type_code';
    if (window.beat === 'say') return 'say_code';
    if (order.status === 'pending' || !order.valet) return 'waiting';
    if (order.status === 'parked') return 'parked';
    // The keys changed hands and the car is not parked yet. Falling back to
    // 'valet_on_way' here drew an ETA for a valet who was already sitting in
    // the car — the screen counting down to an arrival that had happened.
    if (valetHasKeys) return 'keys_handed';
    return 'valet_on_way';
};

/**
 * Minutes until the valet reaches the curb, or null.
 *
 * Straight-line over the same 1.4 m/s walk both clients fall back to. Null
 * whenever there is nothing honest to say — no valet, no fix on them, or they
 * are past the walk and into the car.
 *
 * Drawn on the code beat as well as the walk, because the two screens run into
 * each other: the box appears when the valet reads his number out, and until
 * then this line is the whole of what the doorman knows about how long he is
 * standing there. Null when there is no fix on the valet, which on a morning
 * with several jobs running is most of the time.
 */
const ETA_STAGES = ['valet_on_way', 'type_code'];

const walkEtaMinutes = (order, stage) => {
    if (!ETA_STAGES.includes(stage)) return null;
    const from = order.valetLocation;
    const to = order.customerLocation;
    if (!from?.lat || !to?.lat) return null;
    const seconds = haversineMeters(from, to) / WALK_METERS_PER_SECOND;
    return Math.max(1, Math.round(seconds / 60));
};

/**
 * When this customer's car next has to move, so a link with no live order can
 * say "Next move: Thursday 8:30am" instead of nothing at all.
 *
 * Read off `User.cleaningSchedule`, which owns the sweep days for a person
 * with or without a plan. A pause is honoured the way the field defines it:
 * `pausedUntil` in the future pushes the search past it, and a pause with no
 * end date has no next move to name.
 *
 * Returns null when the customer has no schedule — the page then says nothing
 * rather than guessing.
 */
const nextCleaningMove = (user) => {
    const schedule = user?.cleaningSchedule;
    const days = (schedule?.days || []).filter((d) => Number.isInteger(d?.weekday));
    if (!days.length) return null;

    const streetAddress = schedule.address?.streetAddress || null;

    let from = new Date();
    if (schedule.status === 'paused') {
        if (!schedule.pausedUntil) return { nextAt: null, streetAddress };
        if (schedule.pausedUntil > from) from = schedule.pausedUntil;
    }

    const next = days
        .map((d) =>
            nextNyOccurrence(
                { weekday: d.weekday, hour: d.hour || 0, minute: d.minute || 0 },
                from
            )
        )
        .filter(Boolean)
        .sort((a, b) => a - b)[0];

    return { nextAt: next ? next.toISOString() : null, streetAddress };
};

/**
 * Who is actually asking, or null.
 *
 * Minting and revoking are the owner-only ends of the link, and until now the
 * owner was named by a bare `userId` in the body. That is not a credential:
 * customer ObjectIds are published unauthenticated by
 * `GET /api/order/getPendingOrders`, so a stranger who read that feed could
 * mint a standing doorman link for a customer who never asked for one — and,
 * once revoke was bound to possession of the token, the real customer could
 * not turn off the link she had never been given.
 *
 * `firebaseUid` was the obvious thing to ask for instead, and it is not a
 * secret either. Three unauthenticated endpoints hand it out:
 * `GET /api/auth/getUserById/:userId` answers with the whole user document,
 * `GET /api/auth/getUsers` selects it by name, and
 * `POST /api/auth/checkUserType` returns it for any phone number. The first of
 * those cannot be changed tonight — valet 2.2.0 reads `user.firebaseUid` off
 * it to address every push it sends (NotificationService.js:107) — so anyone
 * who has the id has the uid, and a mint gated on the pair is gated on one
 * fact spelled twice.
 *
 * So this asks for the one thing only the signed-in device can produce: the
 * Firebase ID token. The app already mints one on every request to this API —
 * `utils/apiAuth.js` has attached `Authorization: Bearer <token>` since 2.2.0
 * — and it is signed by Google, short-lived, and not derivable from anything
 * published here. Verified against the same firebase-admin app the rest of
 * this file uses for Firestore.
 *
 * Returns null for anything that does not verify, and the caller turns that
 * into a 401. Deliberately NOT fail-open, unlike `valetHasReadTheCodeOut`
 * below: that check decides whether to draw an empty keypad, this one decides
 * who may mint a credential for somebody's car.
 */
const callerFirebaseUid = async (req) => {
    const header = req.headers?.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
    if (!match) return null;

    try {
        const admin = require('firebase-admin');
        const decoded = await admin.auth().verifyIdToken(match[1]);
        return decoded?.uid || null;
    } catch (err) {
        // A bad token is the ordinary case here — an expired one, or somebody
        // trying it on. Logged at warn so a genuine misconfiguration (a server
        // that cannot reach Google at all) is still visible in the logs.
        console.warn('Doorman link: caller token did not verify —', err.message);
        return null;
    }
};

/**
 * Is the caller the customer this request names?
 *
 * The token proves a Firebase account; `firebaseUid` on the User is what ties
 * that account to this customer record. An account with no uid on file can
 * never match — `null === undefined` would otherwise let an unverifiable
 * caller through on an unfinished account.
 */
const callerOwnsAccount = async (req, user) => {
    const uid = await callerFirebaseUid(req);
    return !!uid && !!user?.firebaseUid && uid === user.firebaseUid;
};

const tokensMatch = (stored, provided) => {
    if (!stored) return false;
    const a = Buffer.from(String(stored));
    const b = Buffer.from(String(provided));
    // timingSafeEqual throws on a length mismatch, which is itself the answer.
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
};

const isLiveLink = (doormanLink) => !!doormanLink?.token && !doormanLink.revokedAt;

/**
 * The customer a token points at, or the reason it points at nobody.
 *
 * Returns `{ user }` or `{ code }`. Every refusal is a 404 with a code: the
 * holder of a dead link needs to be told it is dead — telling them "wrong
 * code" instead would have a doorman retyping a correct number at a valet who
 * is standing there.
 */
const resolveDoormanToken = async (token) => {
    if (!token || typeof token !== 'string') return { code: 'INVALID' };

    // `+doormanLink.token` because the field is `select: false` on the schema
    // — see models/User.js. The filter still matches without it; what it buys
    // is the stored string to compare against below.
    const user = await User.findOne({ 'doormanLink.token': token }).select(
        '+doormanLink.token'
    );
    // Mongo matched this on an exact index hit, so the compare below cannot
    // currently be a timing oracle. It is here so that stays true if the
    // lookup ever changes shape — this is the compare that decides.
    if (!user || !tokensMatch(user.doormanLink?.token, token)) {
        return { code: 'INVALID' };
    }
    if (user.doormanLink.revokedAt) return { code: 'REVOKED' };

    return { user };
};

/**
 * The order this customer has in flight, followed to whichever leg owns the
 * live handoff.
 *
 * Two steps, and both matter. `customerActiveOrderQuery` is the query her own
 * home screen runs, so the link can never be looking at a different job than
 * she is. `liveKeyReturnLeg` then follows an ASP park across to the sweep's
 * return leg, which is where the valet is actually standing.
 *
 * An enterprise park is flipped to `completed` the moment its retrieval
 * starts; the query skips it and lands on the live retrieval instead, which is
 * why a link is never told a handoff is finished while its car is still out.
 *
 * Two documents come back. The beat belongs to `order`; `details` is whichever
 * one describes the car. A sweep leg is minted with no vehicle and no spot of
 * its own — both live on the park it came from — and a doorman shown a blank
 * car cannot tell the valet he is the right one. Followed from the leg's own
 * link rather than from whichever of the pair `findOne` happened to return.
 */
/**
 * How long a booking whose card has not landed yet still counts as live here.
 *
 * `customerActiveOrderQuery` requires `paymentStatus: 'paid'`, which is right
 * for the customer's own app — it will not show a ticket for a car nobody has
 * been paid to move. It is wrong for the FRONT DESK, who just booked and is
 * standing at the screen: between createOrder and the payment confirming, this
 * page told them "nothing booked". That silence is most of why they said codes
 * take forever to appear. An abandoned checkout leaves a pending order behind
 * forever, so the window is short — long enough to cover a card confirming,
 * not long enough to haunt the desk with last Tuesday's abandoned booking.
 */
const PENDING_PAYMENT_GRACE_MS = 10 * 60 * 1000;

const currentHandoff = async (userId) => {
    let booked = await Order.findOne(customerActiveOrderQuery(userId));
    if (!booked) {
        booked = await Order.findOne({
            customer: userId,
            status: { $in: ['pending', 'accepted', 'in_progress', 'parked'] },
            paymentStatus: 'pending',
            createdAt: { $gte: new Date(Date.now() - PENDING_PAYMENT_GRACE_MS) },
        }).sort({ createdAt: -1 });
    }
    if (!booked) return null;

    const order = (await liveKeyReturnLeg(booked)) || booked;
    const details =
        !order.vehicle?.licensePlate && order.linkedOrderId
            ? (await Order.findById(order.linkedOrderId)) || order
            : order;

    return { order, details };
};

/**
 * POST /api/share/link
 *
 * Mints a link for the customer who is asking for it, and hands the token back
 * ONLY on the call that made it.
 *
 * WHO MAY ASK. The account holder, proved by the Firebase ID token on the
 * request — see `callerFirebaseUid`. It used to be anybody who could name a
 * `userId`, and customer ObjectIds are published unauthenticated by
 * `GET /api/order/getPendingOrders`, so this endpoint was a dispenser: read an
 * id off that feed, post it here, and be handed a working standing link to a
 * stranger's car. Withholding the token from a caller that did not create it
 * (below) narrowed that, but a customer with no link yet was still one request
 * away from having one minted for her by somebody else — and she would never
 * know, because the token went to them.
 *
 * A bare `userId` with no token on the request therefore gets nothing at all,
 * not even the existence of a link. That is a 401 and not a 404: the account
 * may well exist, and saying which accounts exist is not this endpoint's job.
 *
 * WHAT THE OWNER GETS BACK. Minting stays idempotent — a second call never
 * kills the link already sitting in the doorman's texts — and it still never
 * reveals a token to a caller that is not already holding it. That is not
 * about who is asking any more; it is about the fact that the answer travels.
 * A confirmation says "the thing you already have is current", which tells an
 * interceptor nothing it did not have.
 *
 * `alreadyLinked` on its own was not enough for the app that DID create it.
 * The customer's phone holds the url and nothing else, and it treated that
 * answer as "what you are holding is fine" — so a link revoked and re-minted
 * from another device left the first phone happily texting a dead url to a
 * doorman. So a caller may send back the token it holds and be told whether it
 * is the live one. A phone that has lost its copy is not stuck: it revokes by
 * `userId` (same proof as here) and mints again.
 *
 * `expiresAt` is answered as null and always will be — the shape is kept so a
 * client reading it doesn't have to care that the clock is gone.
 */
exports.createShareLink = async (req, res) => {
    const { userId, token } = req.body;

    try {
        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'userId is required',
            });
        }

        // `+doormanLink.token` — the field is hidden by default (models/User.js)
        // and both branches below need the stored string: one to compare a
        // caller's copy against, the other to know a live link is already here.
        const user = await User.findById(userId).select('+doormanLink.token');
        // One answer for "no such customer" and for "not your customer". An
        // endpoint that 404s on the first and 401s on the second is a way to
        // enumerate accounts.
        if (!user || !(await callerOwnsAccount(req, user))) {
            return res.status(401).json({
                success: false,
                message: 'Sign in as this customer to make a doorman link.',
            });
        }

        if (isLiveLink(user.doormanLink)) {
            const answer = { success: true, alreadyLinked: true };
            // Only answered when the caller asked — a client that sends no
            // token is making no claim, and a bare `false` would read to it
            // as "your link is dead" rather than "you didn't ask".
            if (typeof token === 'string' && token) {
                answer.tokenIsCurrent = tokensMatch(user.doormanLink.token, token);
            }
            return res.status(200).json(answer);
        }

        user.doormanLink = {
            // 32 random bytes. Never sequential, never derived from an id:
            // anyone who can guess a token can stand at a curb.
            token: crypto.randomBytes(32).toString('base64url'),
            createdAt: new Date(),
            revokedAt: undefined,
        };
        await user.save();

        res.status(200).json({
            success: true,
            token: user.doormanLink.token,
            url: `${SHARE_BASE_URL}/h/${user.doormanLink.token}`,
            expiresAt: null,
        });
    } catch (err) {
        console.error('Failed to create doorman link:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to create share link',
        });
    }
};

/**
 * POST /api/share/link/revoke
 *
 * The customer changed their mind, or the link went somewhere it shouldn't.
 *
 * TWO ways in, and the feature needs both.
 *
 *   {token}  — possession. The customer's own app is holding the url it was
 *              given (hooks/useDoormanLink.js) and so is the doorman, and this
 *              is the path that gets used on a normal Tuesday. It used to take
 *              a bare `userId` and check nothing, which made it an off switch
 *              anybody could throw at a doorman standing there with keys.
 *
 *   {userId} — the account holder, proved the same way minting is proved (see
 *              `callerFirebaseUid`). Possession alone was not enough, and the
 *              gap was the whole point: mint was open, so a stranger could
 *              have a link minted for a customer and keep the only copy of the
 *              token. She was then the one person who could not switch off the
 *              link to her own car. Ownership is the path back — revoke, then
 *              mint again — and it is also how a phone that simply lost its
 *              copy recovers.
 *
 * Idempotent — revoking a link that is already dead is a success, because the
 * thing the customer wanted is already true. A token nobody ever minted is a
 * 404 rather than a success: saying "done" to it would tell a guesser which of
 * their guesses was a real token. An unproved `userId` is a 401 and says
 * nothing about whether that customer has a link, for the same reason.
 */
exports.revokeShareLink = async (req, res) => {
    const { token, userId } = req.body;

    try {
        if (!token && !userId) {
            return res.status(400).json({
                success: false,
                message: 'token or userId is required',
            });
        }

        let user;
        if (token) {
            if (typeof token !== 'string') {
                return res.status(400).json({
                    success: false,
                    message: 'token is required',
                });
            }
            // `+doormanLink.token`: hidden by default, and `tokensMatch` needs
            // the stored string. See models/User.js.
            user = await User.findOne({ 'doormanLink.token': token }).select(
                '+doormanLink.token'
            );
            if (!user || !tokensMatch(user.doormanLink?.token, token)) {
                return res.status(404).json({ success: false, code: 'INVALID' });
            }
        } else {
            user = await User.findById(userId);
            if (!user || !(await callerOwnsAccount(req, user))) {
                return res.status(401).json({
                    success: false,
                    message: 'Sign in as this customer to stop the link.',
                });
            }
            // Nothing to switch off. Success, not a 404 — the customer asked
            // for there to be no live link and there is none.
            if (!user.doormanLink?.createdAt) {
                return res.status(200).json({ success: true });
            }
        }

        if (!user.doormanLink.revokedAt) {
            user.doormanLink.revokedAt = new Date();
            await user.save();
        }

        res.status(200).json({ success: true });
    } catch (err) {
        console.error('Failed to revoke doorman link:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to revoke share link',
        });
    }
};

/**
 * GET /api/share/:token
 *
 * Everything the doorman's screen is allowed to know. Built field by field
 * rather than by deleting from the order document — a redaction that works by
 * subtraction leaks the next field somebody adds to the schema.
 */
exports.getSharedOrder = async (req, res) => {
    try {
        const { user, code } = await resolveDoormanToken(req.params.token);
        if (!user) {
            return res.status(404).json({ success: false, code });
        }

        const schedule = nextCleaningMove(user);
        const live = await currentHandoff(user._id);

        // Between jobs. The link is standing, so there is nothing wrong here —
        // say when the car next has to move and leave the screen quiet.
        if (!live) {
            return res.status(200).json({
                success: true,
                handoff: {
                    customerFirstName: user.firstName || null,
                    vehicle: { make: null, model: null, color: null, licensePlate: null },
                    valet: { firstName: null, etaMinutes: null },
                    status: null,
                    orderType: null,
                    serviceType: null,
                    aspMode: false,
                    stage: 'idle',
                    codeToSay: null,
                    needsEntry: false,
                    parkingAddress: null,
                    schedule,
                },
            });
        }

        const { order, details } = live;

        // Names only. Both of these documents carry the phone number and email
        // this screen must never see, so the projection is the redaction.
        const valet = order.valet
            ? await User.findById(order.valet).select('firstName')
            : null;

        // The window says who may type. The arrival check says whether there
        // is yet anybody to type FOR — and only the type beat has that gap,
        // because the say beat already waits on a recorded handoff. Held shut,
        // the screen falls through `handoffStage` to "on the way", which is
        // the true thing to be showing while he walks.
        //
        // Deliberately not folded into `handoffWindow`: verify re-derives its
        // window from that function, and a doorman whose keypad is up must
        // still be able to spend a correct code even if this check has gone
        // dark since. This is what the screen draws, not what the server will
        // accept.
        const open = await handoffWindow(order);
        const window =
            open.beat === 'type' &&
            !(await valetHasReadTheCodeOut(
                order,
                order.conversationId || details.conversationId
            ))
                ? { beat: null, code: null, reason: 'valet_has_not_read_it_out_yet' }
                : open;

        const valetHasKeys =
            !!order.otpVerifiedTimes?.orderCreation ||
            !!order.otpVerifiedTimes?.returnKey ||
            (await retrievalHasCustody(order));
        const stage = handoffStage(order, window, valetHasKeys);
        const vehicle = details.vehicle;

        res.status(200).json({
            success: true,
            handoff: {
                customerFirstName: user.firstName || null,
                vehicle: {
                    // Order.vehicle has no `make` — the model field carries the
                    // whole "Honda Civic". Kept in the shape so the screen does
                    // not have to know that.
                    make: null,
                    model: vehicle?.model || null,
                    color: vehicle?.color || null,
                    licensePlate: vehicle?.licensePlate || null,
                },
                valet: {
                    firstName: valet?.firstName || null,
                    etaMinutes: walkEtaMinutes(order, stage),
                },
                status: order.status,
                orderType: order.orderType,
                serviceType: order.serviceType,
                aspMode: !!order.aspMode,
                stage,
                // Both read off the one window, so "there is a box" and "there
                // is a number" can never both be true, and neither can be true
                // while the screen says nobody has arrived.
                codeToSay: window.beat === 'say' ? window.code : null,
                needsEntry: window.beat === 'type',
                parkingAddress:
                    order.parkingLocation?.streetAddress ||
                    details.parkingLocation?.streetAddress ||
                    null,
                schedule,
            },
        });
    } catch (err) {
        console.error('Failed to read shared order:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to load this handoff',
        });
    }
};

/**
 * POST /api/share/:token/verify
 *
 * The doorman types the valet's code. Runs the identical path the app's own
 * POST /api/order/verifyOTP runs — same leg follow, same retrieval beat-1
 * code swap, same sockets — because a handoff the doorman completes has to
 * leave the order in exactly the state a handoff the customer completed does.
 *
 * The window is re-derived here from the stored document rather than trusted
 * from whatever GET last painted. A page left open on a phone in a coat pocket
 * is a page whose keypad outlives its window.
 */
exports.verifySharedOtp = async (req, res) => {
    const { otp } = req.body;

    try {
        if (!otp) {
            return res.status(400).json({
                success: false,
                message: 'otp is required',
            });
        }

        const { user, code } = await resolveDoormanToken(req.params.token);
        if (!user) {
            return res.status(404).json({ success: false, code });
        }

        const live = await currentHandoff(user._id);
        const order = live?.order || null;
        const window = await handoffWindow(order);

        // Only ever accept a code on the beat where the link holder is the one
        // meant to type. On the say beat the code is theirs to READ OUT and the
        // valet types it — accepting it here would let the link on its own
        // close out a key return with no valet anywhere near the car.
        if (window.beat !== 'type') {
            return res.status(400).json({
                success: false,
                message: 'There is no code to enter right now',
            });
        }

        // Claim a try BEFORE grading, not after. Reading the count and then
        // writing it is a race with a wide mouth: two hundred guesses fired at
        // once all read zero, all get graded, and a six-digit code stops being
        // six digits. `$inc` is atomic in Mongo, so each concurrent guess is
        // handed its own number and only the first MAX_TYPE_BEAT_ATTEMPTS of
        // them ever reach the comparison. The field counts claims rather than
        // gradings — it keeps climbing once the beat is locked, which costs
        // nothing and keeps the write a single unconditional operation.
        const claimed = await Order.findByIdAndUpdate(
            order._id,
            { $inc: { 'shareVerifyAttempts.typeBeat': 1 } },
            { new: true, projection: { shareVerifyAttempts: 1 } }
        );
        const spent = claimed?.shareVerifyAttempts?.typeBeat || 0;
        if (spent > MAX_TYPE_BEAT_ATTEMPTS) {
            // No Retry-After: this one does not reopen. The handoff still has
            // a path — the customer finishes it in the app.
            return res.status(429).json({
                success: false,
                locked: true,
                message:
                    'This link has used up its tries. Ask the customer to finish the handoff in the app.',
            });
        }

        // Past here the code is compared, so whatever comes back is a verdict
        // on a guess. The burst limiter charges nothing without this flag —
        // see routes/share.js for the doorman it used to lock out for typing
        // into a window that had not opened yet.
        res.locals.otpGraded = true;
        const { status, body } = await applyOtpVerification(order, otp, req.io);

        // Only wrong guesses cost anything, so a right answer hands its claim
        // back. A doorman who gets it right first time has spent nothing, and
        // the count stays a record of somebody failing.
        if (body.success) {
            await Order.findByIdAndUpdate(order._id, {
                $inc: { 'shareVerifyAttempts.typeBeat': -1 },
            });
        }

        res.status(status).json(body);
    } catch (err) {
        console.error('Failed to verify shared handoff code:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to verify OTP',
        });
    }
};

/* ---------------------------------------------------------------------------
 * The doorman's half of the conversation
 *
 * A handoff is a conversation before it is a code — "I'm at the front desk,
 * come to the lobby", "two minutes" — and the doorman has no app to hold it in.
 * So the thread the valet already has open is proxied through here.
 *
 * Proxied, and never spoken to from his browser, even though the customer's own
 * web app reads and writes these exact documents client-side (vnweb
 * src/lib/park/chat.ts). Two reasons, and either alone would settle it: this
 * project's Firestore rules allow anonymous read AND write to every collection,
 * so a Firestore client in the hands of a bearer-link holder is a client in the
 * hands of whoever the link gets forwarded to, pointed at the whole database;
 * and that client would need the conversationId, which is the address of the
 * thread and has no business on the wire. He gets bubbles. Not credentials, not
 * the id, not a path.
 * -------------------------------------------------------------------------*/

// One screen's worth of scrollback. The doorman is catching up on a handoff in
// progress, not auditing a relationship, and this is polled.
const MAX_MESSAGES = 50;

// Long enough for "I'm at the front desk with the keys, come to the lobby",
// short enough that the link cannot paste a wall of text at a working valet.
const MAX_MESSAGE_CHARS = 400;

/**
 * The system messages that carry a live handoff code in their text, and which
 * beat's code each one is.
 *
 * This is the sharp edge of the whole endpoint. OTPs are DELIVERED as chat
 * messages — `sendParkHoldCollectOTP` and `sendOTPToGuest` in the mobile
 * chatService write the number straight into the thread — so a transcript
 * handed over without thought is a side channel that reads out the very code
 * `handoffWindow` is deliberately withholding. The August 31 rules would be
 * decoration: the screen would refuse to show a number and the chat under it
 * would print it.
 *
 * Keyed off `messageType` rather than a pattern over free text, because the
 * apps tag these on the way in, and a regex hunting six digits would both miss
 * a rephrasing and eat a licence plate.
 *
 * The rule: a code message is shown only when it is THIS beat's code and the
 * window is revealing that code anyway. On the type beat `window.code` is null
 * by construction — the number belongs to the valet, who reads it aloud — so
 * `otp_collect_keys` never renders, which is the case that matters. On the say
 * beat the number is already on the doorman's screen as `codeToSay`, so echoing
 * the message it arrived in leaks nothing he was not just handed.
 *
 * The `text.includes` check is not the filter — the type is. It only confirms
 * the message is the CURRENT one: the ASP sweep mints its return leg on the
 * parent's thread, so one conversation carries both the morning's codes and the
 * evening's, and the older message would otherwise ride out on the newer
 * window. Matching the live code separates them without a timestamp filter,
 * which would need a Firestore composite index on a path polled every second.
 */
const CODE_MESSAGE_BEATS = {
    otp_collect_keys: 'type',
    otp_verification: 'say',
};

/**
 * How the valet is told he is reading the doorman and not the customer.
 *
 * He is on 2.2.0 and will not have a new build before Randi's 8:30. That build
 * labels a bubble from `senderId` and from nothing else: its own id is "You",
 * `system` (or `isSystemMessage`) is an italic "System", anything else is
 * "Customer" — screens/ActiveConversationScreen.js. There is no field to set
 * that today's app would draw as a third person, so the only channel that
 * reaches the valet's eyes is the text itself. Hence a prefix.
 *
 * And the customer's own id as the sender, not `system`. A system bubble reads
 * as the app talking rather than a person waiting, and several screens filter
 * system messages out of "somebody is owed a reply" — the doorman is a man
 * standing at a desk expecting one. He speaks for the customer, so the
 * customer's lane is the honest place for him, with the prefix naming who is
 * actually holding the phone.
 */
const DOORMAN_PREFIX = 'Front desk: ';

/**
 * Milliseconds for a bubble, normalised the way the customer's web app does it.
 *
 * Messages carry both a client `createdAt` Timestamp and a `serverCreatedAt`
 * sentinel. Prefer the server's — a phone with a wrong clock is what the
 * sentinel exists for — and fall back rather than render an undated bubble.
 */
const messageMillis = (raw) => {
    for (const value of [raw.serverCreatedAt, raw.createdAt]) {
        if (!value) continue;
        if (typeof value === 'number') return value;
        if (typeof value.toMillis === 'function') return value.toMillis();
        if (typeof value.seconds === 'number') return value.seconds * 1000;
    }
    return 0;
};

/**
 * Every handoff code live on this thread right now.
 *
 * Classifying by `messageType` covers the messages the apps TAG, and that was
 * the whole filter. It is not enough: a valet typing "code is 481902" with his
 * thumbs writes an ordinary bubble, and an ordinary bubble went out verbatim —
 * at any beat, including with the window shut. So the codes themselves are
 * blanked out of the text, and the tag is only what decides whether a whole
 * message is a person talking.
 *
 * Both legs, because one ASP conversation carries both halves of the morning:
 * the sweep mints its return leg on the parent's thread, so the parent's
 * number and the leg's are sitting in the same transcript and either one opens
 * a car.
 *
 * Spent codes are collected too. A verified one is worth nothing to anybody,
 * and asking "is this one still live" is a judgement this does not need to
 * make correctly to be safe.
 */
const liveCodesOnThread = async (order) => {
    const codes = new Set();
    const take = (doc) => {
        const code = doc?.otp?.code;
        if (typeof code === 'string' && code) codes.add(code);
    };

    take(order);
    if (order?.linkedOrderId) {
        try {
            const linked = await Order.findById(order.linkedOrderId).select('otp');
            take(linked);
        } catch (err) {
            console.error('Linked-leg code lookup failed:', err.message);
        }
    }
    return [...codes];
};

// Six bullets rather than a deletion: a doorman reading "the code is ••••••"
// knows a number was said and that he is not the one who gets to see it.
const CODE_MASK = '••••••';

/** Split/join rather than a regex — nothing here has to be escaped first. */
const redactCodes = (text, codes) =>
    codes.reduce((out, code) => out.split(code).join(CODE_MASK), text);

/**
 * One message, as much of it as the doorman may have — or null.
 *
 * Deny by default, and by shape rather than by subtraction. Everything that is
 * not a person typing a sentence is dropped: every tagged message (payment
 * links, photo posts carrying a signed storage URL, the OTP traffic above),
 * every system message, and anything advertising a link. New message types get
 * added to this codebase regularly, and none of them should reach a bearer link
 * because nobody remembered to exclude it.
 *
 * PRESENCE of a tag, not a truthy one. The old test read `messageType` only
 * when it was a string and then dropped on `if (type)`, so `messageType: ''`
 * and `messageType: 7` were both untagged as far as this was concerned and
 * sailed through — a tagged OTP message with an empty tag reached the doorman.
 * Firestore omits a field rather than storing undefined, and neither app writes
 * this key on ordinary talk, so "the key is there at all" is exactly the line.
 *
 * What survives is talk with every live code blanked out of it, and the only
 * identity on it is which of the three people said it.
 */
const toDoormanBubble = (doc, { window, order, valetFirebaseUid, liveCodes = [] }) => {
    const raw = doc.data() || {};
    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (!text) return null;

    // The one number that may survive is the one already printed on his
    // screen as `codeToSay`; blanking that would be blanking his own beat.
    const withheld = liveCodes.filter((code) => code !== window.code);
    const safeText = redactCodes(text, withheld);

    const tagged = Object.prototype.hasOwnProperty.call(raw, 'messageType');
    const type = typeof raw.messageType === 'string' ? raw.messageType : null;
    const codeBeat = type ? CODE_MESSAGE_BEATS[type] : undefined;

    if (codeBeat) {
        if (codeBeat !== window.beat) return null;
        if (!window.code || !text.includes(window.code)) return null;
        return { id: doc.id, from: 'system', text: safeText, at: messageMillis(raw) };
    }

    if (tagged) return null;
    if (raw.isSystemMessage || raw.senderId === 'system' || raw.senderId === 'bot') return null;
    if (raw.containsLink || raw.link || raw.photoUrl) return null;

    const senderId = String(raw.senderId || '');
    const isValet =
        !!senderId &&
        (senderId === String(order.valet || '') || senderId === String(valetFirebaseUid || ''));

    return {
        id: doc.id,
        // A role, never the sender's id. The screen needs to know which side of
        // the thread to draw a bubble on, and nothing else about anybody.
        from: raw.senderRole === 'doorman' ? 'doorman' : isValet ? 'valet' : 'customer',
        text: safeText,
        at: messageMillis(raw),
    };
};

/**
 * The thread a token may talk in right now, or the refusal.
 *
 * Both message endpoints start here and both must refuse the same three ways.
 * The third is the one that is easy to miss: the link is standing, so it
 * outlives the job it was last used on. Between jobs there is nothing to read —
 * a doorman who opens the link on Sunday must not be handed Thursday's
 * transcript — and nothing to send, because there is nobody on the other end.
 */
const liveThread = async (token) => {
    const { user, code } = await resolveDoormanToken(token);
    if (!user) return { error: { status: 404, body: { success: false, code } } };

    const live = await currentHandoff(user._id);
    if (!live) {
        return { error: { status: 404, body: { success: false, code: 'NO_LIVE_ORDER' } } };
    }

    // The sweep's return leg is minted on its parent's conversation, so either
    // document answers with the same thread — which is the point: the doorman
    // and the valet stay in one place across both legs of the morning.
    const conversationId = live.order.conversationId || live.details.conversationId || null;

    return { user, order: live.order, conversationId };
};

/**
 * GET /api/share/:token/messages
 *
 * The recent talk on the live job, redacted to a line of text and a role.
 */
exports.getSharedMessages = async (req, res) => {
    try {
        const thread = await liveThread(req.params.token);
        if (thread.error) {
            return res.status(thread.error.status).json(thread.error.body);
        }

        const { order, conversationId } = thread;

        // A thread is minted in `acceptOrder`, so a booking nobody has taken
        // yet has none. The link is fine, there is simply no one to talk to —
        // say that rather than 404, which the page would read as a dead link.
        if (!conversationId) {
            return res.status(200).json({ success: true, canSend: false, messages: [] });
        }

        const window = await handoffWindow(order);
        const liveCodes = await liveCodesOnThread(order);
        const valet = order.valet
            ? await User.findById(order.valet).select('firebaseUid')
            : null;

        const admin = require('firebase-admin');
        const snapshot = await admin
            .firestore()
            .collection('conversations')
            .doc(String(conversationId))
            .collection('messages')
            // Newest first, so the cap keeps the end of the conversation rather
            // than its beginning. Flipped back below for the screen.
            .orderBy('createdAt', 'desc')
            .limit(MAX_MESSAGES)
            .get();

        const messages = snapshot.docs
            .map((doc) =>
                toDoormanBubble(doc, {
                    window,
                    order,
                    valetFirebaseUid: valet?.firebaseUid,
                    liveCodes,
                })
            )
            .filter(Boolean)
            .reverse();

        res.status(200).json({ success: true, canSend: true, messages });
    } catch (err) {
        console.error('Failed to read shared conversation:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to load this conversation',
        });
    }
};

/**
 * What the doorman actually typed, or an empty string.
 *
 * Control characters go first — they are how a message is made to render as
 * something it is not, and a chat bubble has no use for any of them, newline
 * included. Whitespace then collapses, so a screenful of blank lines is an
 * empty message and gets refused as one.
 */
const cleanMessageText = (value) => {
    if (typeof value !== 'string') return '';
    return value
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
};

/**
 * POST /api/share/:token/messages
 *
 * Into the same thread the valet already has open, in the customer's lane,
 * under a prefix that says who is really typing.
 */
exports.sendSharedMessage = async (req, res) => {
    try {
        const thread = await liveThread(req.params.token);
        if (thread.error) {
            return res.status(thread.error.status).json(thread.error.body);
        }

        const { user, order, conversationId } = thread;
        if (!conversationId) {
            return res.status(409).json({
                success: false,
                code: 'NO_THREAD_YET',
                message: 'No valet has picked this up yet.',
            });
        }

        const text = cleanMessageText(req.body?.text);
        if (!text) {
            return res.status(400).json({
                success: false,
                message: 'Type a message first',
            });
        }
        // Refused rather than quietly trimmed: a message that reaches the valet
        // with its second half missing is worse than one that never left.
        if (text.length > MAX_MESSAGE_CHARS) {
            return res.status(400).json({
                success: false,
                message: `Keep it under ${MAX_MESSAGE_CHARS} characters`,
            });
        }

        const admin = require('firebase-admin');
        // Both timestamps, because that is what `chatService.addConvoMessage`
        // writes and what the valet's list orders and renders off. A message
        // missing either sorts to the wrong end of the thread or is dropped.
        await admin
            .firestore()
            .collection('conversations')
            .doc(String(conversationId))
            .collection('messages')
            .add({
                createdAt: admin.firestore.Timestamp.now(),
                serverCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
                text: `${DOORMAN_PREFIX}${text}`,
                senderId: String(user._id),
                // Ignored by every renderer shipped today; here so the next
                // build can draw him as himself without a migration.
                senderRole: 'doorman',
            });

        // The apps ring each other from the CLIENT that sent the message
        // (NotificationService.sendMessageNotification), so a write made here
        // lands silently — the doorman would be talking into a thread nobody is
        // looking at. Best-effort by design: the message is already in the
        // conversation, and a push that fails must not tell him it isn't.
        if (order.valet) {
            try {
                const valet = await User.findById(order.valet).select('firebaseUid');
                if (valet?.firebaseUid) {
                    await sendPushNotification(
                        valet.firebaseUid,
                        `New message from ${user.firstName || 'the front desk'}`,
                        `${DOORMAN_PREFIX}${text}`,
                        { orderId: String(order._id) }
                    );
                }
            } catch (err) {
                console.error('Doorman message push failed:', err.message);
            }
        }

        res.status(200).json({ success: true });
    } catch (err) {
        console.error('Failed to post doorman message:', err);
        res.status(500).json({
            success: false,
            message: 'Failed to send this message',
        });
    }
};
