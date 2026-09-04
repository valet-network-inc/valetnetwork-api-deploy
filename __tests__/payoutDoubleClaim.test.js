/**
 * The same earnings can only be claimed once.
 *
 * Run: npx jest payoutDoubleClaim
 *
 * requestPayout used to read the valet's balance, create the ValetPayout row,
 * and only then zero the account — a whole DB round-trip between the read and
 * the write. Two requests landing inside that window (two phones on the same
 * valet account, a replayed POST — the endpoint takes a bare userId in the
 * body) both saw the same non-zero balance and each wrote a full-amount
 * 'requested' row. Rishi pays these by hand off the dashboard's Payouts tab,
 * so two identical rows for one valet meant paying the same earnings twice.
 *
 * The balance is now claimed atomically before the row is written, so the sum
 * of what lands on the Payouts tab can never exceed what the valet was owed.
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const User = require('../models/User');
const ValetPayout = require('../models/ValetPayout');
const payoutController = require('../controllers/payoutController');

let mongod;

const mockRes = () => {
    const res = {};
    res.statusCode = 200;
    res.body = null;
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    return res;
};

const request = (userId) => {
    const res = mockRes();
    return payoutController
        .requestPayout({ body: { userId: String(userId) } }, res)
        .then(() => res);
};

const seedValet = async (currentBalance, currentTipsBalance) => User.create({
    phone: '+15557770001',
    firebaseUid: 'fb_payout_race',
    verified: false,
    isValet: true,
    firstName: 'Marcus',
    lastName: 'Vale',
    payoutMethod: 'zelle',
    zelleHandle: 'marcus@example.com',
    currentBalance,
    currentTipsBalance,
});

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

afterEach(async () => {
    await Promise.all([User.deleteMany({}), ValetPayout.deleteMany({})]);
});

describe('requestPayout claims the balance atomically', () => {
    test('two overlapping requests produce ONE payout row, not two of the same money', async () => {
        const valet = await seedValet(4200, 800); // $50 owed: $42 earnings + $8 tips

        const [a, b] = await Promise.all([
            request(valet._id),
            request(valet._id),
        ]);

        const rows = await ValetPayout.find({ valet: valet._id });
        const totalRequested = rows.reduce((sum, r) => sum + r.amount, 0);

        // The Payouts tab must never show more money than the valet was owed.
        expect(totalRequested).toBe(5000);
        expect(rows).toHaveLength(1);
        expect(rows[0].earningsAmount).toBe(4200);
        expect(rows[0].tipsAmount).toBe(800);

        // Exactly one caller is told the payout is on its way; the other is
        // refused the same way a valet with nothing owed already is.
        const oks = [a, b].filter((r) => r.body && r.body.success === true);
        const refused = [a, b].filter((r) => r.statusCode === 400);
        expect(oks).toHaveLength(1);
        expect(refused).toHaveLength(1);
        expect(refused[0].body.message).toBe('No balance available to pay out.');

        const after = await User.findById(valet._id);
        expect(after.currentBalance).toBe(0);
        expect(after.currentTipsBalance).toBe(0);
    });

    test('a lone request still succeeds and answers in the shape the valet app reads', async () => {
        const valet = await seedValet(1500, 0);

        const res = await request(valet._id);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.payout).toEqual(
            expect.objectContaining({
                amount: 1500,
                method: 'zelle',
                handle: 'marcus@example.com',
            })
        );
        expect(res.body.payout.id).toBeDefined();
        expect(res.body.payout.requestedAt).toBeDefined();

        const after = await User.findById(valet._id);
        expect(after.currentBalance).toBe(0);
    });

    test('nothing owed is still refused without writing a row', async () => {
        const valet = await seedValet(0, 0);

        const res = await request(valet._id);

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe('No balance available to pay out.');
        expect(await ValetPayout.countDocuments({ valet: valet._id })).toBe(0);
    });
});
