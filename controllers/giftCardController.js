const crypto = require('crypto');
const GiftCard = require('../models/GiftCard');
const User = require('../models/User');
const stripeClient = require('../services/stripeClient');
const { ensureStripeCustomer } = require('./subscriptionController');
const giftBalance = require('../services/giftBalance');

const stripe = () => stripeClient.get();

// No 0/O or 1/I, so a code read off a card is never ambiguous.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const normalize = (raw) =>
    String(raw || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 32);
const newCode = () => Array.from({ length: 12 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
const linkFor = (code) => `https://valetnetwork.co/park?gift=${code}`;

// GET /api/gift/:code — what the redeem page shows before anyone signs in.
exports.getGift = async (req, res) => {
    try {
        const card = await GiftCard.findOne({ code: normalize(req.params.code), active: true }).lean();
        if (!card) return res.status(404).json({ success: false, message: "That gift card isn't valid." });
        res.json({
            success: true,
            gift: {
                amountCents: card.amountCents,
                recipientName: card.recipientName || null,
                message: card.message || null,
                redeemed: !!card.redeemedBy,
            },
        });
    } catch (err) {
        console.error('getGift error:', err);
        res.status(500).json({ success: false, message: 'Could not load the gift card.' });
    }
};

// GET /api/gift/balance?userId= — behind requireSelf: what they have left to spend.
exports.getBalance = async (req, res) => {
    try {
        const gift = await giftBalance.giftFor(req.callerUserId);
        res.json({ success: true, cents: gift.cents });
    } catch (err) {
        console.error('getBalance error:', err);
        res.status(500).json({ success: false, message: 'Could not load your gift balance.' });
    }
};

// POST /api/gift/redeem { code, userId } — behind requireSelf, so the money
// lands on the signed-in customer's own account.
exports.redeemGift = async (req, res) => {
    try {
        const code = normalize(req.body && req.body.code);
        const user = await User.findById(req.callerUserId);
        if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });

        const card = await GiftCard.findOneAndUpdate(
            { code, active: true, redeemedBy: null },
            { $set: { redeemedBy: user._id, redeemedAt: new Date() } },
            { new: true }
        );
        if (!card) {
            const existing = await GiftCard.findOne({ code, active: true }).lean();
            if (!existing) return res.status(404).json({ success: false, message: "That gift card isn't valid." });
            if (String(existing.redeemedBy) === String(user._id)) {
                return res.json({ success: true, alreadyRedeemed: true, amountCents: existing.amountCents });
            }
            return res.status(409).json({ success: false, message: 'This gift card has already been used.' });
        }

        let customerId;
        let txn;
        try {
            customerId = await ensureStripeCustomer(user);
            txn = await stripe().customers.createBalanceTransaction(
                customerId,
                {
                    amount: -card.amountCents,
                    currency: 'usd',
                    description: `Gift card ${card.code}`,
                    metadata: { giftCardId: String(card._id), userId: String(user._id) },
                },
                { idempotencyKey: `gift-card-${card._id}` }
            );
        } catch (err) {
            // Nothing reached their account, so the card goes back to unused.
            await GiftCard.updateOne({ _id: card._id }, { $set: { redeemedBy: null, redeemedAt: null } });
            throw err;
        }
        await GiftCard.updateOne(
            { _id: card._id },
            { $set: { stripeCustomerId: customerId, stripeBalanceTransactionId: txn.id } }
        );
        res.json({ success: true, amountCents: card.amountCents, balanceCents: -txn.ending_balance });
    } catch (err) {
        console.error('redeemGift error:', err);
        res.status(500).json({ success: false, message: 'Could not redeem the gift card. Try again.' });
    }
};

// POST /api/admin/gift-cards { amountCents, recipientName?, message? }
exports.adminCreateGift = async (req, res) => {
    try {
        const body = req.body || {};
        const amountCents = Number(body.amountCents);
        if (!Number.isInteger(amountCents) || amountCents < 100 || amountCents > 100000) {
            return res.status(400).json({ success: false, message: 'amountCents is a whole number from 100 to 100000.' });
        }
        const doc = { amountCents, createdBy: req.get('x-admin-actor') || 'admin-key' };
        for (const field of ['recipientName', 'message']) {
            if (body[field]) doc[field] = String(body[field]).trim().slice(0, 120);
        }
        let card = null;
        for (let i = 0; !card && i < 5; i++) {
            try {
                card = await GiftCard.create({ ...doc, code: newCode() });
            } catch (err) {
                if (!err || err.code !== 11000) throw err;
            }
        }
        if (!card) return res.status(500).json({ success: false, message: 'Could not make a unique code.' });
        res.status(201).json({ success: true, giftCard: card.toObject(), url: linkFor(card.code) });
    } catch (err) {
        console.error('adminCreateGift error:', err);
        res.status(500).json({ success: false, message: 'Could not create the gift card.' });
    }
};

// GET /api/admin/gift-cards — newest first, with each card's link.
exports.adminListGifts = async (req, res) => {
    try {
        const cards = await GiftCard.find({}).sort({ createdAt: -1 }).limit(200).lean();
        res.json({ success: true, giftCards: cards.map((c) => ({ ...c, url: linkFor(c.code) })) });
    } catch (err) {
        console.error('adminListGifts error:', err);
        res.status(500).json({ success: false, message: 'Could not list gift cards.' });
    }
};

// PATCH /api/admin/gift-cards/:code { active } — switch an unused card off.
exports.adminUpdateGift = async (req, res) => {
    try {
        const card = await GiftCard.findOneAndUpdate(
            { code: normalize(req.params.code) },
            { $set: { active: !!(req.body && req.body.active) } },
            { new: true }
        ).lean();
        if (!card) return res.status(404).json({ success: false, message: 'No gift card with that code.' });
        res.json({ success: true, giftCard: card });
    } catch (err) {
        console.error('adminUpdateGift error:', err);
        res.status(500).json({ success: false, message: 'Could not update the gift card.' });
    }
};
