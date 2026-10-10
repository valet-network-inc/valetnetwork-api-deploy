/**
 * The rep portal, admin, rep invites, Refer a friend and phone-number codes
 * (spec v2, 7a, 9-19).
 *
 * Run: npx jest repPortal
 *
 * Firebase is mocked: "rep:<10 digits>" is a rep's phone sign-in and
 * "uid:<uid>" is a customer's. Stripe is never reached on these paths.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
delete process.env.SMTP_HOST;

jest.mock('firebase-admin', () => ({
    auth: () => ({
        verifyIdToken: async (token) => {
            const rep = /^rep:(\d{10})$/.exec(String(token));
            if (rep) return { uid: `fb-${rep[1]}`, phone_number: `+1${rep[1]}` };
            const m = /^uid:(.+)$/.exec(String(token));
            if (!m) throw new Error('Decoding Firebase ID token failed');
            return { uid: m[1] };
        },
    }),
    messaging: () => ({
        send: async () => 'mock',
        sendEachForMulticast: async () => ({ responses: [], successCount: 0, failureCount: 0 }),
    }),
}));

const request = require('supertest');
const express = require('express');
const Rep = require('../models/Rep');
const User = require('../models/User');
const UnlockMember = require('../models/UnlockMember');
const Subscription = require('../models/Subscription');
const { findPromo } = require('../services/subscriptionPromos');
const ledger = require('../services/salesLedger');
const repAgreement = require('../services/repAgreement');

const app = express();
app.use(express.json());
app.use('/api/rep', require('../routes/rep'));
app.use('/api/waitlist', require('../routes/waitlist'));
app.use('/api/referral', require('../routes/referral'));

const ALEX = '6465550198';
const DANA = '9175550107';
const RISHI = '9796616772';
const CHELSEA = { streetAddress: '200 W 20th St, New York, NY 10011', lat: 40.7425, lng: -73.997 };
const as = (phone) => ({ Authorization: `Bearer rep:${phone}` });

let mongo;
beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
});
beforeEach(async () => {
    await mongoose.connection.db.dropDatabase();
    repAgreement.invalidate();
    await Rep.create({ name: 'Rishi Ganesh', phone: RISHI, code: RISHI, role: 'admin', email: 'rishi@valetnetwork.co' });
    await Rep.create({ name: 'Alex Rivera', phone: ALEX, code: ALEX, email: 'alexrivera@email.com' });
});

async function signAs(phone, name) {
    const a = await request(app).get('/api/rep/agreement').set(as(phone));
    return request(app).post('/api/rep/agreement/sign').set(as(phone)).send({ version: a.body.agreement.version, fullName: name });
}

describe('sign-in and the agreement gate', () => {
    test('a number Rishi has not added is turned away', async () => {
        const res = await request(app).get('/api/rep/me').set(as('2125550100'));
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('NOT_A_REP');
    });

    test('nothing but /me and the agreement works until it is signed', async () => {
        const me = await request(app).get('/api/rep/me').set(as(ALEX));
        expect(me.body.agreement.signed).toBe(false);
        const home = await request(app).get('/api/rep/home').set(as(ALEX));
        expect(home.status).toBe(403);
        expect(home.body.code).toBe('AGREEMENT_REQUIRED');

        const a = await request(app).get('/api/rep/agreement').set(as(ALEX));
        expect(a.body.agreement.title).toBe('Commission agreement');
        expect(a.body.agreement.draft).toMatch(/DRAFT/);
        expect(a.body.agreement.intro).toMatch(/and Alex Rivera \("the Rep"\)/);
        expect(a.body.agreement.sections).toHaveLength(10);
        expect(JSON.stringify(a.body)).not.toMatch(/REP ADDRESS|\{REP_NAME\}/);

        const stale = await request(app).post('/api/rep/agreement/sign').set(as(ALEX)).send({ version: 99, fullName: 'Alex Rivera' });
        expect(stale.status).toBe(409);
        const blank = await request(app).post('/api/rep/agreement/sign').set(as(ALEX)).send({ version: a.body.agreement.version, fullName: ' ' });
        expect(blank.status).toBe(400);

        const signed = await signAs(ALEX, 'Alex Rivera');
        expect(signed.status).toBe(200);
        expect(signed.body.signedName).toBe('Alex Rivera');
        // No SMTP settings here: signing still works, and says the email did not go.
        expect(signed.body.emailStatus).toBe('not_configured');
        expect((await request(app).get('/api/rep/home').set(as(ALEX))).status).toBe(200);

        const pdf = await request(app).get('/api/rep/agreement/pdf').set(as(ALEX)).buffer(true).parse((res, cb) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
        expect(pdf.status).toBe(200);
        expect(pdf.headers['content-type']).toMatch(/pdf/);
        expect(pdf.body.slice(0, 4).toString()).toBe('%PDF');
    });

    test('admin routes are Rishi’s only', async () => {
        await signAs(ALEX, 'Alex Rivera');
        await signAs(RISHI, 'Rishi Ganesh');
        expect((await request(app).get('/api/rep/admin/reps').set(as(ALEX))).status).toBe(403);
        const made = await request(app).post('/api/rep/admin/reps').set(as(RISHI)).send({ name: 'Dana Brooks', phone: '(917) 555-0107', email: 'danabrooks@email.com' });
        expect(made.status).toBe(201);
        expect(made.body.rep.code).toBe('(917) 555-0107');
        const dup = await request(app).post('/api/rep/admin/reps').set(as(RISHI)).send({ name: 'Dana', phone: DANA });
        expect(dup.status).toBe(409);
        const list = await request(app).get('/api/rep/admin/reps').set(as(RISHI));
        expect(list.body.reps.map((r) => r.name)).toEqual(['Rishi Ganesh', 'Alex Rivera', 'Dana Brooks']);
        expect(list.body.reps[2].agreementSignedAt).toBeNull();
    });
});

describe('customers and invites', () => {
    beforeEach(async () => {
        await signAs(ALEX, 'Alex Rivera');
        await Rep.create({ name: 'Dana Brooks', phone: DANA, code: DANA });
        await signAs(DANA, 'Dana Brooks');
        await signAs(RISHI, 'Rishi Ganesh');
    });

    test('a new subscriber gets an invite, and only their rep sees them', async () => {
        const quote = await request(app).post('/api/rep/price').set(as(ALEX)).send({ address: CHELSEA });
        expect(quote.body.available).toBe(true);
        expect(quote.body.area.label).toBe('Chelsea');
        expect(quote.body.unlock).toMatchObject({ total: 0, needed: 10, unlocked: false });

        const res = await request(app)
            .post('/api/rep/customers')
            .set(as(ALEX))
            .send({ phone: '(646) 555-0151', homeAddress: CHELSEA, firstName: 'Ana', lastName: 'Silva', vehicle: { description: 'White Toyota RAV4', plate: 'LMN 2231' } });
        expect(res.status).toBe(201);
        expect(res.body.inviteUrl).toMatch(/^https:\/\/valetnetwork\.co\/join\//);
        expect(res.body.smsBody).toBe(
            `Hi Ana, it’s Alex from Valet Network. Here’s your Permanent valet invite for 200 W 20th St: ${res.body.inviteUrl.replace('https://', '')}`
        );
        expect(res.body.customer.status).toBe('not_joined');

        const again = await request(app).post('/api/rep/customers').set(as(DANA)).send({ phone: '6465550151', homeAddress: CHELSEA });
        expect(again.status).toBe(409);

        expect((await request(app).get('/api/rep/customers').set(as(ALEX))).body.customers).toHaveLength(1);
        expect((await request(app).get('/api/rep/customers').set(as(DANA))).body.customers).toHaveLength(0);
        expect((await request(app).get('/api/rep/customers').set(as(RISHI))).body.customers).toHaveLength(1);
    });

    test('the customer finds the invite under their number, and can say not for me', async () => {
        const made = await request(app).post('/api/rep/customers').set(as(ALEX)).send({ phone: '6465550151', homeAddress: CHELSEA, firstName: 'Ana' });
        const token = made.body.inviteUrl.split('/join/')[1];

        const pub = await request(app).get(`/api/waitlist/invite/${token}`);
        expect(pub.body.invite.variant).toBe('invite');
        expect(pub.body.invite.copy.fine).toBe('Your card is charged $525/mo after Chelsea unlocks.');
        expect((await UnlockMember.findOne({ inviteToken: token })).inviteOpenedAt).toBeTruthy();

        const user = await User.create({ verified: true, phone: '+16465550151', firebaseUid: 'ana' });
        const mine = await request(app).get(`/api/waitlist/mine/${user._id}`).set('Authorization', 'Bearer uid:ana');
        expect(mine.status).toBe(200);
        expect(mine.body.members).toHaveLength(1);
        expect(mine.body.members[0].home.title).toBe('Permanent valet at 200 W 20th St');

        const other = await User.create({ verified: true, phone: '+12125550199', firebaseUid: 'eve' });
        const steal = await request(app)
            .post(`/api/waitlist/members/${mine.body.members[0].id}/leave`)
            .set('Authorization', 'Bearer uid:eve')
            .send({ userId: String(other._id) });
        expect(steal.status).toBe(404);

        const leave = await request(app)
            .post(`/api/waitlist/members/${mine.body.members[0].id}/leave`)
            .set('Authorization', 'Bearer uid:ana')
            .send({ userId: String(user._id) });
        expect(leave.status).toBe(200);
        expect((await UnlockMember.findOne({ inviteToken: token })).status).toBe('declined');
    });

    test('admin notes show on every rep’s unlock tree', async () => {
        const tree = await request(app).get('/api/rep/unlocks').set(as(ALEX));
        expect(tree.body.boroughs.map((b) => b.label)).toEqual(['Manhattan', 'Brooklyn', 'Queens', 'Staten Island', 'The Bronx']);
        expect(tree.body.boroughs[0].neighborhoods).toHaveLength(18);
        expect(tree.body.boroughs[1].neighborhoods).toHaveLength(47);
        expect(tree.body.boroughs[2].neighborhoods).toHaveLength(46);
        expect(tree.body.boroughs[3].summary).toBe('Not offered yet');
        const chelsea = tree.body.boroughs[0].neighborhoods.find((n) => n.name === 'Chelsea');
        expect((await request(app).put(`/api/rep/admin/unlocks/${chelsea.key}/note`).set(as(ALEX)).send({ note: 'x' })).status).toBe(403);
        await request(app).put(`/api/rep/admin/unlocks/${chelsea.key}/note`).set(as(RISHI)).send({ note: 'Growing fast: 3 this week' });
        const after = await request(app).get('/api/rep/unlocks').set(as(DANA));
        expect(after.body.boroughs[0].neighborhoods.find((n) => n.name === 'Chelsea').note).toBe('Growing fast: 3 this week');
    });
});

describe('earnings', () => {
    test('commission each paid month, $100 after the first full paid month, nothing for a free trial', async () => {
        const rep = await Rep.findOne({ phone: ALEX });
        const user = await User.create({ verified: true, phone: '+17185550126' });
        const now = new Date('2026-10-10T16:00:00Z');
        await Subscription.collection.insertOne({
            user: user._id,
            tier: 'home_garage',
            interval: 'month',
            status: 'active',
            amountCents: 30000,
            activatedAt: new Date('2026-08-01T16:00:00Z'),
            trialEndsAt: new Date('2026-08-28T16:00:00Z'),
            rep: rep._id,
            repCommissionCents: 5000,
            pricing: { neighborhood: 'Cobble Hill', neighborhoodKey: 'brooklyn-cobble-hill', commissionCents: 5000 },
        });
        const e = await ledger.earnings(rep._id, now);
        expect(e.monthlyCents).toBe(5000);
        const by = Object.fromEntries(e.months.map((m) => [m.month, m]));
        expect(by['2026-08'].commissionCents).toBe(5000);
        expect(by['2026-09'].bonusCents).toBe(10000);
        expect(by['2026-10'].totalCents).toBe(5000);
        expect(by['2026-07']).toBeUndefined();
    });
});

describe('phone-number codes and Refer a friend', () => {
    test('a rep’s phone credits the rep; a customer’s is a code once they set a payout', async () => {
        const rep = await Rep.findOne({ phone: ALEX });
        const repCode = await findPromo('(646) 555-0198');
        expect(repCode.kind).toBe('rep');
        expect(String(repCode.rep)).toBe(String(rep._id));

        const sam = await User.create({ verified: true, phone: '+19175550134', firebaseUid: 'sam' });
        expect(await findPromo('917-555-0134')).toBeNull();

        const bad = await request(app).put(`/api/referral/${sam._id}/payout`).set('Authorization', 'Bearer uid:sam').send({ method: 'paypal', handle: 'x' });
        expect(bad.status).toBe(400);
        const saved = await request(app)
            .put(`/api/referral/${sam._id}/payout`)
            .set('Authorization', 'Bearer uid:sam')
            .send({ method: 'zelle', handle: 'sam.lee@email.com' });
        expect(saved.status).toBe(200);
        expect(saved.body.code).toBe('(917) 555-0134');
        expect(saved.body.payout).toMatchObject({ method: 'zelle', label: 'Zelle', handle: 'sam.lee@email.com' });

        const ref = await findPromo('+1 917 555 0134');
        expect(ref.kind).toBe('referral');
        expect(String(ref.referrer)).toBe(String(sam._id));
        // Words are still admin codes.
        expect(await findPromo('NOPE')).toBeNull();
    });

    test('a referral pays $50 a month for up to 12 months', async () => {
        const sam = await User.create({ verified: true, phone: '+19175550134', referral: { method: 'zelle', handle: 'sam@x.com' } });
        const priya = await User.create({ verified: true, phone: '+19175550111', firstName: 'Priya', lastName: 'Shah' });
        await Subscription.collection.insertOne({
            user: priya._id,
            tier: 'home_garage',
            interval: 'month',
            status: 'active',
            amountCents: 52500,
            activatedAt: new Date('2026-09-02T16:00:00Z'),
            referredBy: sam._id,
            referralCode: '9175550134',
        });
        const now = new Date('2026-10-10T16:00:00Z');
        const s = await ledger.referralSummary(sam._id, now);
        expect(s.earningCents).toBe(5000);
        expect(s.referrals[0]).toMatchObject({ name: 'Priya Shah', line: 'Active since Sep 2 · 11 months left', rewardCents: 5000 });
        const rows = await ledger.referralPayouts('2026-10', now);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ owedCents: 5000, method: 'zelle', handle: 'sam@x.com' });
        expect(await ledger.referralPayouts('2027-09', new Date('2027-09-15T16:00:00Z'))).toHaveLength(0);
    });
});
