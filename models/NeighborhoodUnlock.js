const mongoose = require('mongoose');

// A neighborhood's unlock state (spec v2, 2026-10-09).
//
// The list of neighborhoods is config and the price table
// (neighborhoodPricing.allNeighborhoods); this is only what happens to one.
// A row is written the first time anything happens in the neighborhood, so
// most of the 113 have none, and no row reads as "locked, nobody yet".
//
// `unlockedAt` is set exactly once, by a conditional update, when the 10th
// card is saved. That update is the guarantee that the start date, the
// operator alert and the members' pushes happen once however many cards land
// at the same moment.
const NeighborhoodUnlockSchema = new mongoose.Schema(
    {
        key: { type: String, required: true, unique: true },
        borough: { type: String },
        name: { type: String },
        unlockedAt: { type: Date },
        // 8 AM ET, three days after the unlock. Cards are charged then.
        startsAt: { type: Date },
        // The operator alert to station a valet went out.
        alertedAt: { type: Date },
        // The start job has charged everyone it was going to.
        startedAt: { type: Date },
        // Shown in red in the portal when it has been quiet for 14 days.
        lastNewSubscriberAt: { type: Date },
        // "Notes from Valet Network": every rep reads it, only admin writes it.
        noteToReps: { type: String },
        noteUpdatedAt: { type: Date },
    },
    { timestamps: true }
);

module.exports = mongoose.model('NeighborhoodUnlock', NeighborhoodUnlockSchema);
