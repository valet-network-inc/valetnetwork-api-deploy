/**
 * The rep portal at valetnetwork.co/rep and Rishi's admin inside it
 * (spec v2, 16-19). Every handler here runs behind middleware/requireRep.js,
 * so req.rep is the signed-in rep. A rep sees only their own customers;
 * admin (role 'admin') sees everyone's.
 */
const mongoose = require('mongoose');
const Rep = require('../models/Rep');
const UnlockMember = require('../models/UnlockMember');
const Subscription = require('../models/Subscription');
const NeighborhoodUnlock = require('../models/NeighborhoodUnlock');
const SalesPayout = require('../models/SalesPayout');
const PromoCode = require('../models/PromoCode');
const repAgreement = require('../services/repAgreement');
const ledger = require('../services/salesLedger');
const unlocks = require('../services/neighborhoodUnlocks');
const { phoneCode, phoneVariants, formatPhone } = require('../services/phoneCodes');
const { getTable, saveTable, garagePriceAt, allNeighborhoods, NOT_OFFERED_MESSAGE } = require('../services/neighborhoodPricing');
const { createCode, updateCode, listCodes } = require('../services/subscriptionPromos');

const wrap = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (err) {
        console.error(`rep ${req.method} ${req.originalUrl} failed:`, err);
        res.status(500).json({ success: false, message: 'Something went wrong. Try again.' });
    }
};

const isAdmin = (req) => req.rep && req.rep.role === 'admin';
/** Admin sees every rep's numbers; a rep sees their own. */
const scope = (req) => (isAdmin(req) ? null : req.rep._id);

function repView(rep) {
    return {
        _id: String(rep._id),
        name: rep.name,
        phone: formatPhone(rep.phone),
        email: rep.email || undefined,
        code: formatPhone(rep.phone),
        role: rep.role,
        active: rep.active !== false,
    };
}

// GET /api/rep/me
exports.me = wrap(async (req, res) => {
    res.json({ success: true, rep: repView(req.rep), agreement: await repAgreement.statusFor(req.rep) });
});

// GET /api/rep/agreement
exports.agreement = wrap(async (req, res) => {
    res.json({ success: true, agreement: await repAgreement.viewFor(req.rep) });
});

// POST /api/rep/agreement/sign  { version, fullName }
exports.sign = wrap(async (req, res) => {
    const b = req.body || {};
    const result = await repAgreement.sign(req.rep, {
        fullName: b.fullName,
        version: b.version,
        ip: req.ip,
        userAgent: req.get('user-agent'),
    });
    if (result.error) return res.status(result.status || 400).json({ success: false, message: result.error });
    res.json({ success: true, ...result });
});

// GET /api/rep/agreement/pdf
exports.agreementPdf = wrap(async (req, res) => {
    // Before signing it is the text to read; after, the copy as signed.
    const pdf = await repAgreement.pdfFor(req.rep);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(repAgreement.pdfFilename(req.rep))}`
    );
    res.send(pdf);
});

// GET /api/rep/home
exports.home = wrap(async (req, res) => {
    res.json({ success: true, ...(await ledger.home(scope(req))) });
});

// GET /api/rep/unlocks
exports.unlocks = wrap(async (req, res) => {
    res.json({ success: true, ...(await ledger.unlockTree({ repId: req.rep._id, admin: isAdmin(req) })) });
});

// GET /api/rep/customers
exports.customers = wrap(async (req, res) => {
    res.json({ success: true, customers: await ledger.customers(scope(req)) });
});

/** Permanent valet at an address, with its neighborhood's count. */
async function quoteFor(address) {
    if (!address || typeof address.lat !== 'number' || typeof address.lng !== 'number') {
        return { available: false, message: 'Pick the address from the list.', amountCents: 0, area: null };
    }
    const table = await getTable();
    const price = garagePriceAt(table, address, 'month');
    if (!price) return { available: false, message: NOT_OFFERED_MESSAGE, amountCents: 0, area: null };
    const state = await unlocks.stateFor(price.key, table);
    return {
        available: true,
        amountCents: price.amountCents,
        interval: 'month',
        area: { key: price.key, borough: price.borough, neighborhood: price.neighborhood || price.label, label: price.label },
        unlock: state
            ? { name: state.name, total: state.count, needed: state.needed, unlocked: state.unlocked, startsAt: state.startsAt }
            : null,
    };
}

// POST /api/rep/price  { address }
exports.price = wrap(async (req, res) => {
    res.json({ success: true, ...(await quoteFor((req.body || {}).address)) });
});

// POST /api/rep/customers  { phone, homeAddress, firstName?, lastName?, email?, vehicle?: {description, plate}, notes? }
exports.addCustomer = wrap(async (req, res) => {
    const b = req.body || {};
    const phone = phoneCode(b.phone);
    if (!phone) return res.status(400).json({ success: false, message: 'Enter a 10-digit US phone number.' });
    const name = [b.firstName, b.lastName].map((x) => String(x || '').trim()).filter(Boolean).join(' ');

    const live = await UnlockMember.findOne({
        'contact.phone': { $in: phoneVariants(phone) },
        status: { $in: UnlockMember.LIVE_STATUSES },
    }).lean();
    if (live) {
        return res.status(409).json({
            success: false,
            message: `${formatPhone(phone)} is already in ${live.neighborhoodName}.`,
        });
    }
    const vehicle =
        b.vehicle && (b.vehicle.description || b.vehicle.plate)
            ? {
                  model: String(b.vehicle.description || '').trim() || undefined,
                  licensePlate: String(b.vehicle.plate || '').trim() || undefined,
              }
            : undefined;
    const made = await unlocks.createRepInvite({
        rep: req.rep._id,
        phone,
        homeAddress: b.homeAddress,
        name: name || undefined,
        email: b.email ? String(b.email).trim() : undefined,
        vehicle,
        notes: b.notes ? String(b.notes).trim() : undefined,
    });
    if (made.error) return res.status(400).json({ success: false, message: made.error });
    const m = made.member;
    const url = ledger.inviteUrl(m.inviteToken);
    const shown = url.replace(/^https?:\/\//, '');
    const first = name.split(' ')[0];
    const repFirst = String(req.rep.name || '').split(' ')[0];
    const smsBody = `Hi${first ? ` ${first}` : ''}, it’s ${repFirst} from Valet Network. Here’s your Permanent valet invite for ${unlocks.shortStreet(m.homeAddress)}: ${shown}`;
    const customer = ledger.customerRow(m.toObject(), null, null, new Date());
    res.status(201).json({ success: true, customer, inviteUrl: url, smsBody });
});

// GET /api/rep/earnings
exports.earnings = wrap(async (req, res) => {
    res.json({ success: true, ...(await ledger.earnings(scope(req))) });
});

// ---------------------------------------------------------------------------
// Admin (role 'admin' only)
// ---------------------------------------------------------------------------

// GET /api/rep/admin/pricing
exports.getPricing = wrap(async (req, res) => {
    const table = await getTable();
    res.json({ success: true, pricing: table, neighborhoods: allNeighborhoods(table) });
});

// PUT /api/rep/admin/pricing
exports.putPricing = wrap(async (req, res) => {
    const result = await saveTable(req.body || {}, req.rep.name);
    if (result.error) return res.status(400).json({ success: false, message: result.error });
    res.json({ success: true, pricing: result.table });
});

function codeView(doc, repNames, uses) {
    const rep = doc.rep ? { _id: String(doc.rep), name: repNames.get(String(doc.rep)) || 'Rep' } : null;
    return {
        _id: doc._id ? String(doc._id) : doc.code,
        code: doc.code,
        kind: doc.kind,
        percentOff: doc.percentOff ?? null,
        amountOffCents: doc.amountOffCents ?? null,
        duration: doc.duration || null,
        durationInMonths: doc.durationInMonths ?? null,
        trialDays: doc.trialDays ?? null,
        appliesTo: doc.appliesTo || null,
        maxRedemptions: doc.maxRedemptions ?? null,
        redemptions: uses !== undefined ? uses : doc.redemptions || 0,
        expiresAt: doc.expiresAt || null,
        active: doc.active !== false,
        rep,
        builtIn: !!doc.builtIn,
        phone: !!doc.phone,
        createdAt: doc.createdAt || null,
    };
}

// GET /api/rep/admin/codes — admin codes, the built-in ones, and every rep's phone.
exports.listCodes = wrap(async (req, res) => {
    const { codes, builtIn } = await listCodes();
    const reps = await Rep.find({}).lean();
    const repNames = new Map(reps.map((r) => [String(r._id), r.name]));
    const repUses = await Subscription.aggregate([
        { $match: { rep: { $exists: true, $ne: null }, activatedAt: { $exists: true } } },
        { $group: { _id: '$rep', c: { $sum: 1 } } },
    ]);
    const used = new Map(repUses.map((x) => [String(x._id), x.c]));
    const builtInUses = await Subscription.aggregate([
        { $match: { promoCode: { $in: builtIn.map((b) => b.code) }, activatedAt: { $exists: true } } },
        { $group: { _id: '$promoCode', c: { $sum: 1 } } },
    ]);
    const bUsed = new Map(builtInUses.map((x) => [x._id, x.c]));
    res.json({
        success: true,
        codes: [
            ...codes.map((c) => codeView(c, repNames)),
            ...builtIn.map((c) => codeView({ ...c, builtIn: true, active: true }, repNames, bUsed.get(c.code) || 0)),
            ...reps
                .filter((r) => r.active !== false)
                .map((r) =>
                    codeView(
                        { _id: `rep-${r._id}`, code: formatPhone(r.phone), kind: 'rep', rep: r._id, phone: true, active: true },
                        repNames,
                        used.get(String(r._id)) || 0
                    )
                ),
        ],
    });
});

// POST /api/rep/admin/codes
exports.createCode = wrap(async (req, res) => {
    const result = await createCode(req.body || {}, req.rep.name);
    if (result.error) return res.status(400).json({ success: false, message: result.error });
    const reps = await Rep.find({}).select('name').lean();
    res.status(201).json({ success: true, code: codeView(result.code, new Map(reps.map((r) => [String(r._id), r.name]))) });
});

// PATCH /api/rep/admin/codes/:id  { active }
exports.patchCode = wrap(async (req, res) => {
    let code = req.params.id;
    if (mongoose.isValidObjectId(code)) {
        const doc = await PromoCode.findById(code).select('code').lean();
        if (!doc) return res.status(404).json({ success: false, message: 'No such code.' });
        code = doc.code;
    }
    const result = await updateCode(code, req.body || {});
    if (result.error) return res.status(400).json({ success: false, message: result.error });
    res.json({ success: true, code: codeView(result.code, new Map()) });
});

// GET /api/rep/admin/reps
exports.listReps = wrap(async (req, res) => {
    const reps = await Rep.find({}).sort({ createdAt: 1 });
    const nowKey = ledger.monthKey(new Date());
    const out = [];
    for (const r of reps) {
        const [money, members, payouts] = await Promise.all([
            ledger.earnings(r._id),
            UnlockMember.find({ rep: r._id }).select('status').lean(),
            SalesPayout.find({ kind: 'rep', rep: r._id }).lean(),
        ]);
        const month = money.months.find((m) => m.month === nowKey) || { totalCents: 0, paidCents: 0 };
        out.push({
            ...repView(r),
            agreementSignedAt: (await repAgreement.isSignedNow(r)) ? r.agreement.signedAt : null,
            customers: members.filter((m) => m.status === 'active').length,
            waitlists: members.filter((m) => ['waiting', 'scheduled', 'starting'].includes(m.status)).length,
            owedCents: Math.max(0, month.totalCents - month.paidCents),
            paidToDateCents: payouts.reduce((a, p) => a + p.amountCents, 0),
        });
    }
    res.json({ success: true, reps: out });
});

// POST /api/rep/admin/reps  { name, phone, email? }
exports.createRep = wrap(async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').replace(/\s+/g, ' ').trim();
    const phone = phoneCode(b.phone);
    if (!name) return res.status(400).json({ success: false, message: 'Full name is required.' });
    if (!phone) return res.status(400).json({ success: false, message: 'Enter a 10-digit US phone number.' });
    if (await Rep.exists({ phone })) return res.status(409).json({ success: false, message: 'That number is already a rep.' });
    const rep = await Rep.create({
        name,
        phone,
        code: phone,
        email: b.email ? String(b.email).trim() : undefined,
        createdBy: req.rep.name,
    });
    res.status(201).json({ success: true, rep: { ...repView(rep), agreementSignedAt: null, customers: 0, waitlists: 0, owedCents: 0, paidToDateCents: 0 } });
});

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// POST /api/rep/admin/payouts  { repId, month: 'YYYY-MM', amountCents, method }
exports.createPayout = wrap(async (req, res) => {
    const b = req.body || {};
    if (!mongoose.isValidObjectId(b.repId) || !(await Rep.exists({ _id: b.repId }))) {
        return res.status(400).json({ success: false, message: 'Pick a rep.' });
    }
    if (!MONTH.test(String(b.month || ''))) return res.status(400).json({ success: false, message: 'Pick a month.' });
    const cents = Math.round(Number(b.amountCents));
    if (!Number.isFinite(cents) || cents <= 0) return res.status(400).json({ success: false, message: 'Enter an amount.' });
    const payout = await SalesPayout.create({
        kind: 'rep',
        rep: b.repId,
        month: b.month,
        amountCents: cents,
        method: b.method || undefined,
        recordedBy: req.rep.name,
    });
    res.status(201).json({ success: true, payout });
});

// GET /api/rep/admin/unlocks
exports.adminUnlocks = wrap(async (req, res) => {
    res.json({ success: true, ...(await ledger.unlockTree({ repId: req.rep._id, admin: true })) });
});

// PUT /api/rep/admin/unlocks/:key/note  { note }
exports.saveNote = wrap(async (req, res) => {
    const key = String(req.params.key || '');
    const table = await getTable();
    if (!allNeighborhoods(table).some((n) => n.key === key)) {
        return res.status(404).json({ success: false, message: 'No such neighborhood.' });
    }
    const note = String((req.body || {}).note || '').trim().slice(0, 280);
    await NeighborhoodUnlock.updateOne(
        { key },
        { $set: { noteToReps: note, noteUpdatedAt: new Date() }, $setOnInsert: { key } },
        { upsert: true }
    );
    res.json({ success: true, key, note });
});

// GET /api/rep/admin/referral-payouts?month=YYYY-MM
exports.referralPayouts = wrap(async (req, res) => {
    const month = MONTH.test(String(req.query.month || '')) ? req.query.month : ledger.monthKey(new Date());
    res.json({ success: true, month, rows: await ledger.referralPayouts(month) });
});

// POST /api/rep/admin/referral-payouts  { userId, month, amountCents }
exports.recordReferralPayout = wrap(async (req, res) => {
    const b = req.body || {};
    if (!mongoose.isValidObjectId(b.userId)) return res.status(400).json({ success: false, message: 'Pick a customer.' });
    if (!MONTH.test(String(b.month || ''))) return res.status(400).json({ success: false, message: 'Pick a month.' });
    const cents = Math.round(Number(b.amountCents));
    if (!Number.isFinite(cents) || cents <= 0) return res.status(400).json({ success: false, message: 'Enter an amount.' });
    const User = require('../models/User');
    const user = await User.findById(b.userId).select('referral').lean();
    if (!user) return res.status(404).json({ success: false, message: 'No such customer.' });
    const payout = await SalesPayout.create({
        kind: 'referral',
        user: b.userId,
        month: b.month,
        amountCents: cents,
        method: (user.referral && user.referral.method) || undefined,
        recordedBy: req.rep.name,
    });
    res.status(201).json({ success: true, payout });
});
