/**
 * The customer's side of neighborhood unlocks (spec v2, 9-12): a rep's invite
 * (/join/<token> and the app), the card that joins a waitlist, the waitlist a
 * self-signup is on, and the share link. Copy comes from
 * neighborhoodUnlocks.memberView, so the app and the web print the same words.
 *
 * Also Refer a friend (spec v2, 13): the payout method, the code (their phone
 * number) and their referrals.
 */
const mongoose = require('mongoose');
const UnlockMember = require('../models/UnlockMember');
const User = require('../models/User');
const unlocks = require('../services/neighborhoodUnlocks');
const ledger = require('../services/salesLedger');
const { phoneCode, phoneVariants, formatPhone } = require('../services/phoneCodes');
const { getTable, neighborhoodByKey } = require('../services/neighborhoodPricing');

const ENDED = ['declined', 'left', 'cancelled'];
const OPEN = ['invited', 'pending_card', 'waiting', 'scheduled', 'starting', 'failed'];

const wrap = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (err) {
        console.error(`waitlist ${req.method} ${req.originalUrl} failed:`, err);
        res.status(500).json({ success: false, message: 'Something went wrong. Try again.' });
    }
};

function webBase() {
    return (process.env.PUBLIC_WEB_URL || 'https://valetnetwork.co').replace(/\/$/, '');
}

function shareFor(member, user) {
    // The sharer's number is a code (and pays them) only once they have told
    // us where to send the money (Refer a friend). Before that the link
    // carries no code: one that isn't valid would greet the friend as an
    // error at checkout.
    const code = user && user.referral && user.referral.method ? phoneCode(user.phone) : null;
    const url = `${webBase()}/join/share?${code ? `ref=${code}&` : ''}n=${encodeURIComponent(member.neighborhoodName)}`;
    return {
        url,
        text: `Join the ${member.neighborhoodName} waitlist for Valet Network. It goes live at 10 subscribers: ${url}`,
    };
}

async function fullView(member, user) {
    const view = await unlocks.memberView(member);
    return {
        ...view,
        inviteToken: member.inviteToken || undefined,
        savedCard: member.cardLast4 ? { brand: member.cardBrand || 'card', last4: member.cardLast4 } : null,
        ...(['waiting', 'scheduled'].includes(member.status)
            ? (() => {
                  const share = shareFor(member, user);
                  return { share, shareUrl: share.url, shareMessage: share.text };
              })()
            : {}),
    };
}

/** The member, if it is this caller's. */
async function ownMember(req, res) {
    const id = req.params.memberId;
    if (!mongoose.isValidObjectId(id)) {
        res.status(404).json({ success: false, message: 'Not found.' });
        return null;
    }
    const member = await UnlockMember.findById(id);
    if (!member || String(member.user) !== String(req.callerUserId)) {
        res.status(404).json({ success: false, message: 'Not found.' });
        return null;
    }
    return member;
}

/** Attach a rep's invite to the account it was made out to. */
async function claim(member, user, now = new Date()) {
    if (member.user && String(member.user) !== String(user._id)) return { error: 'This invite belongs to another account.', status: 409 };
    if (member.user) return { member };
    const live = await unlocks.liveMemberFor(user._id);
    if (live && String(live._id) !== String(member._id)) {
        if (live.status === 'active') return { error: 'You already have Permanent valet.', status: 409 };
        // A self-signup they never finished gives way to the invite.
        if (['pending_card', 'invited'].includes(live.status)) await unlocks.endMember(live, 'left', now);
        else return { error: `You’re already on the ${live.neighborhoodName} waitlist.`, status: 409 };
    }
    const set = { user: user._id, liveUser: user._id, claimedAt: now };
    if (!member.inviteOpenedAt) set.inviteOpenedAt = now;
    const claimed = await UnlockMember.findOneAndUpdate(
        { _id: member._id, user: { $exists: false } },
        { $set: set },
        { new: true }
    );
    return { member: claimed || (await UnlockMember.findById(member._id)) };
}

// GET /api/waitlist/invite/:token — public: the link is the invitation.
exports.preview = wrap(async (req, res) => {
    const member = await UnlockMember.findOne({ inviteToken: String(req.params.token || '') });
    if (!member || ENDED.includes(member.status)) {
        return res.status(404).json({ success: false, message: 'This invite is no longer open.' });
    }
    if (!member.inviteOpenedAt) {
        await UnlockMember.updateOne({ _id: member._id, inviteOpenedAt: { $exists: false } }, { $set: { inviteOpenedAt: new Date() } });
    }
    const view = await unlocks.memberView(member);
    const phone = phoneCode(member.contact && member.contact.phone);
    res.json({
        success: true,
        invite: { ...view, claimed: !!member.user, phoneLast4: phone ? phone.slice(-4) : null, firstName: ((member.contact && member.contact.name) || '').split(' ')[0] || null },
    });
});

// GET /api/waitlist/mine/:userId — the caller's open memberships; claims any
// rep invite made out to their phone number.
exports.mine = wrap(async (req, res) => {
    const user = await User.findById(req.callerUserId);
    const ten = phoneCode(user && user.phone);
    if (ten) {
        const unclaimed = await UnlockMember.find({
            'contact.phone': { $in: phoneVariants(ten) },
            user: { $exists: false },
            status: { $in: ['invited', 'pending_card'] },
        });
        for (const m of unclaimed) await claim(m, user);
    }
    const members = await UnlockMember.find({ user: user._id, status: { $in: OPEN } }).sort({ createdAt: -1 });
    const out = [];
    for (const m of members) out.push(await fullView(m, user));
    res.json({ success: true, members: out, invites: out });
});

// POST /api/waitlist/invite/:token/claim  { userId }
exports.claimInvite = wrap(async (req, res) => {
    const member = await UnlockMember.findOne({ inviteToken: String(req.params.token || '') });
    if (!member || ENDED.includes(member.status)) {
        return res.status(404).json({ success: false, message: 'This invite is no longer open.' });
    }
    const user = await User.findById(req.callerUserId);
    const result = await claim(member, user);
    if (result.error) return res.status(result.status || 400).json({ success: false, message: result.error });
    res.json({ success: true, member: await fullView(result.member, user) });
});

// POST /api/waitlist/members/:memberId/setup-intent  { userId }
exports.setupIntent = wrap(async (req, res) => {
    const member = await ownMember(req, res);
    if (!member) return;
    if (!['invited', 'pending_card'].includes(member.status)) {
        return res.status(400).json({ success: false, message: 'Your card is already saved.' });
    }
    const user = await User.findById(req.callerUserId);
    const sheet = await unlocks.setupIntentFor(member, user);
    if (member.status === 'invited') await UnlockMember.updateOne({ _id: member._id }, { $set: { status: 'pending_card' } });
    res.json({ success: true, setupIntentId: member.setupIntentId, ...sheet });
});

// POST /api/waitlist/members/:memberId/confirm  { userId }
exports.confirm = wrap(async (req, res) => {
    const member = await ownMember(req, res);
    if (!member) return;
    const after = await unlocks.confirmCard(member);
    const user = await User.findById(req.callerUserId);
    res.json({ success: true, member: await fullView(after, user) });
});

// PATCH /api/waitlist/members/:memberId  { userId, homeAddress?, vehicle? }
exports.edit = wrap(async (req, res) => {
    const member = await ownMember(req, res);
    if (!member) return;
    const b = req.body || {};
    const v = b.vehicle;
    const vehicle = v
        ? {
              ...(v.color !== undefined ? { color: v.color } : {}),
              ...(v.model !== undefined || v.description !== undefined || v.make !== undefined
                  ? { model: [v.make, v.model ?? v.description].filter(Boolean).join(' ') }
                  : {}),
              ...(v.licensePlate !== undefined || v.plate !== undefined ? { licensePlate: v.licensePlate ?? v.plate } : {}),
          }
        : undefined;
    const result = await unlocks.editMember(member, { homeAddress: b.homeAddress, vehicle });
    if (result.error) return res.status(400).json({ success: false, code: result.code, message: result.error });
    const user = await User.findById(req.callerUserId);
    res.json({ success: true, member: await fullView(result.member, user) });
});

// POST /api/waitlist/members/:memberId/leave  { userId } — "Not for me" or
// "Cancel before it starts".
exports.leave = wrap(async (req, res) => {
    const member = await ownMember(req, res);
    if (!member) return;
    if (['active', 'starting'].includes(member.status)) {
        return res.status(400).json({ success: false, message: 'Your plan has started. Cancel it from your subscription.' });
    }
    await unlocks.endMember(member, member.status === 'invited' ? 'declined' : 'left');
    res.json({ success: true });
});

// POST /api/waitlist/members/:memberId/share  { userId } — the share link.
exports.share = wrap(async (req, res) => {
    const member = await ownMember(req, res);
    if (!member) return;
    const user = await User.findById(req.callerUserId).select('phone referral').lean();
    const share = shareFor(member, user);
    res.json({ success: true, url: share.url, message: share.text, shareUrl: share.url, shareMessage: share.text });
});

// GET /api/waitlist/neighborhood/:key — public: the share link's landing.
exports.neighborhood = wrap(async (req, res) => {
    const table = await getTable();
    const row = neighborhoodByKey(table, String(req.params.key || ''));
    if (!row || !row.offered) return res.status(404).json({ success: false, message: 'Not found.' });
    const state = await unlocks.stateFor(row.key, table);
    res.json({
        success: true,
        neighborhood: {
            key: row.key,
            name: row.name,
            borough: row.borough,
            count: state.count,
            needed: state.needed,
            unlocked: state.unlocked,
            startsAt: state.startsAt,
            monthlyCents: row.monthlyCents,
        },
    });
});

// ---------------------------------------------------------------------------
// Refer a friend
// ---------------------------------------------------------------------------

const METHODS = { zelle: 'Zelle', venmo: 'Venmo', bank: 'Bank deposit' };

/** What the customer sees of their payout: a bank account only by its last four. */
function shownHandle(r) {
    if (r.method !== 'bank') return r.handle || '';
    const m = /account (\d+)/.exec(r.handle || '');
    return m ? `ending ${m[1].slice(-4)}` : '';
}

function referralPayload(user, summary) {
    const ten = phoneCode(user.phone);
    const r = user.referral && user.referral.method ? user.referral : null;
    return {
        payout: r ? { method: r.method, label: METHODS[r.method], handle: shownHandle(r) } : null,
        code: r && ten ? formatPhone(ten) : null,
        codeDigits: r && ten ? ten : null,
        shareText:
            r && ten
                ? `Use my code ${formatPhone(ten)} when you subscribe to Valet Network: ${webBase()}/park?code=${ten}`
                : null,
        rewardCents: ledger.REFERRAL_CENTS,
        ...summary,
        // The app's names for the same things.
        shareMessage: r && ten ? `Use my code ${formatPhone(ten)} when you subscribe to Valet Network: ${webBase()}/park?code=${ten}` : null,
        earnCents: summary.earningCents,
        referrals: (summary.referrals || []).map((x) => ({ ...x, detail: x.line, amountCents: x.rewardCents })),
    };
}

// GET /api/referral/:userId
exports.referral = wrap(async (req, res) => {
    const user = await User.findById(req.callerUserId).select('phone referral').lean();
    res.json({ success: true, ...referralPayload(user, await ledger.referralSummary(user._id)) });
});

// PUT /api/referral/:userId/payout  { method: zelle|venmo|bank, handle }
exports.savePayout = wrap(async (req, res) => {
    const b = req.body || {};
    if (!METHODS[b.method]) return res.status(400).json({ success: false, message: 'Pick Zelle, Venmo or Bank deposit.' });
    // The app sends a bank deposit as its three fields; Rishi pays it by hand.
    const bank = b.method === 'bank' && b.bank && typeof b.bank === 'object' ? b.bank : null;
    const handle = bank
        ? [bank.name, bank.routingNumber && `routing ${bank.routingNumber}`, bank.accountNumber && `account ${bank.accountNumber}`]
              .map((x) => String(x || '').trim())
              .filter(Boolean)
              .join(' · ')
        : String(b.handle || '').trim();
    if (handle.length < 3) {
        const what = { zelle: 'your Zelle email or phone', venmo: 'your Venmo username', bank: 'your bank deposit details' }[b.method];
        return res.status(400).json({ success: false, message: `Enter ${what}.` });
    }
    const user = await User.findByIdAndUpdate(
        req.callerUserId,
        { $set: { referral: { method: b.method, handle: handle.slice(0, 300), savedAt: new Date() } } },
        { new: true }
    )
        .select('phone referral')
        .lean();
    res.json({ success: true, ...referralPayload(user, await ledger.referralSummary(user._id)) });
});

// GET /api/referral/share/:code — public: the share link's landing. Who shared
// it (first name only) and how far their neighborhood is from 10.
exports.shareInfo = wrap(async (req, res) => {
    const ten = phoneCode(req.params.code);
    const user = ten ? await User.findOne({ phone: { $in: phoneVariants(ten) } }).select('firstName name').lean() : null;
    if (!user) return res.status(404).json({ success: false, message: 'Not found.' });
    const member = await UnlockMember.findOne({ user: user._id, status: { $in: ['waiting', 'scheduled'] } }).lean();
    const state = member ? await unlocks.stateFor(member.neighborhood) : null;
    res.json({
        success: true,
        firstName: (user.firstName || (user.name || '').split(' ')[0] || '').trim() || null,
        unlock: state ? { label: state.name, count: state.count, needed: state.needed, unlocked: state.unlocked, startsAt: state.startsAt } : null,
    });
});
