const mongoose = require('mongoose');

// What Permanent valet costs, by neighborhood (Rishi, 2026-10-09).
//
// One document, key 'default', so prices change without an app update: the
// rep portal's admin section (or PUT /api/admin/sales/pricing) edits it, and
// every client reads the price from the server. It is seeded from
// config/neighborhoodPrices.json the first time anything reads it; after
// that the file is only the seed and the document is the truth.
//
// The borough outlines are not in here. They are geography, not prices, and
// they stay in config/nycBoroughs.json, as do the Brooklyn and Queens
// neighborhood centres (config/nycNeighborhoods.json), which share one price.
// The Manhattan centroids ARE here, because they decide which row an address
// lands in and so which price it pays.
//
// All amounts are integer cents a MONTH. Weekly billing is derived
// (services/neighborhoodPricing.js weeklyFromMonthly).
const ManhattanRowSchema = new mongoose.Schema(
    {
        // The row's key. The admin can change prices but not the set of
        // names, so a subscription's stored neighborhood always means a row.
        neighborhood: { type: String, required: true },
        monthlyCents: { type: Number, required: true },
        commissionCents: { type: Number, required: true },
        // The sheet's "Average garage monthly" — shown beside the price on
        // valetnetwork.co/pricing, never charged.
        garageCents: { type: Number },
        // [[lat, lng], ...]. An address belongs to the row with the nearest one.
        centroids: { type: [[Number]], default: [] },
    },
    { _id: false }
);

const NeighborhoodPricingSchema = new mongoose.Schema(
    {
        key: { type: String, default: 'default', unique: true },
        brooklynQueens: {
            monthlyCents: { type: Number, required: true },
            commissionCents: { type: Number, required: true },
            garageLowCents: { type: Number },
            garageHighCents: { type: Number },
        },
        manhattan: { type: [ManhattanRowSchema], default: [] },
        weeklyShare: { type: Number, default: 0.3 },
        weeklyRoundCents: { type: Number, default: 500 },
        // "Questions? Contact sales" in the purchase flow. Served from here so
        // the number, the address and the prefilled message can change
        // without an app build. `message` carries a {name} the client fills.
        contactSales: {
            prompt: { type: String, default: 'Questions?' },
            label: { type: String, default: 'Contact sales' },
            phone: { type: String },
            email: { type: String },
            subject: { type: String },
            message: { type: String },
        },
        // Who last saved it: a rep's name from the portal, or 'admin-key'.
        updatedBy: { type: String },
    },
    { timestamps: true }
);

// The live document, created from the seed file on first read. An upsert
// with $setOnInsert so two processes booting together cannot both insert.
NeighborhoodPricingSchema.statics.getSingleton = async function () {
    const existing = await this.findOne({ key: 'default' }).lean();
    if (existing) return existing;
    const seed = require('../config/neighborhoodPrices.json');
    try {
        await this.updateOne(
            { key: 'default' },
            {
                $setOnInsert: {
                    key: 'default',
                    brooklynQueens: seed.brooklynQueens,
                    manhattan: seed.manhattan,
                    weeklyShare: seed.weeklyShare,
                    weeklyRoundCents: seed.weeklyRoundCents,
                    contactSales: seed.contactSales,
                    updatedBy: 'seed',
                },
            },
            { upsert: true }
        );
    } catch (err) {
        // The other process won the insert; its document is the same seed.
        if (!err || err.code !== 11000) throw err;
    }
    return this.findOne({ key: 'default' }).lean();
};

module.exports = mongoose.model('NeighborhoodPricing', NeighborhoodPricingSchema);
