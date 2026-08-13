/**
 * Pin-based street parking + free-spot pins — the redesign rules.
 * Run: npx jest pinParking
 *
 * What is being pinned down:
 *
 *  1. A parking mark can now be a dropped pin (no Overpass, no street
 *     geometry). Pins on the same street + ~1-block tile share identity,
 *     so the existing consensus/verified math keeps working.
 *
 *  2. Free-spot pins no longer need the Manhattan-only ML segment id,
 *     list for 30 minutes (was 15), stop leaking the marking valet's
 *     name/phone/photo, and can only be removed by their owner.
 *
 *  3. Backward compat: the legacy path/endpoints creation flow still
 *     works for phones on the old build.
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const StreetParkingMark = require('../models/StreetParkingMark');
const StreetSegmentReport = require('../models/StreetSegmentReport');
const FreeSpace = require('../models/FreeSpace');
const streetParkingController = require('../controllers/streetParkingController');
const locationController = require('../controllers/locationController');

let mongo;

/** Minimal express-ish double: captures status + json body. */
const mockRes = () => {
    const res = {};
    res.statusCode = 200;
    res.body = null;
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (payload) => {
        res.body = payload;
        return res;
    };
    return res;
};

const oid = () => new mongoose.Types.ObjectId();

// Carroll Gardens — the neighborhood the old design could never mark.
const CG = { lat: 40.6795, lng: -73.9991 };

const createMark = async (body) => {
    const res = mockRes();
    await streetParkingController.create({ body }, res);
    return res;
};

const listBbox = async () => {
    const res = mockRes();
    await streetParkingController.listInBbox(
        {
            query: {
                minLat: '40.67',
                maxLat: '40.69',
                minLng: '-74.01',
                maxLng: '-73.98',
            },
        },
        res
    );
    return res;
};

beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
});

afterEach(async () => {
    await StreetParkingMark.deleteMany({});
    await StreetSegmentReport.deleteMany({});
    await FreeSpace.deleteMany({});
});

describe('pin marks', () => {
    test('a pin creates a mark with no street geometry and no street name', async () => {
        const res = await createMark({
            valetId: String(oid()),
            pin: CG,
            level: 'easy',
        });
        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.geometrySource).toBe('pin');
        expect(res.body.mark.origin).toBe('pin');
        expect(res.body.mark.tileKey).toBe('40680:-73999');
        expect(res.body.mark.midpoint).toMatchObject(CG);
    });

    test('two pins on the same street + block aggregate into one segment', async () => {
        const base = {
            street: 'Court Street',
            level: 'easy',
        };
        await createMark({ ...base, valetId: String(oid()), pin: CG });
        await createMark({
            ...base,
            valetId: String(oid()),
            // ~30m away — same 0.001° tile
            pin: { lat: CG.lat + 0.0002, lng: CG.lng + 0.0002 },
        });

        const res = await listBbox();
        expect(res.body.success).toBe(true);
        expect(res.body.segments).toHaveLength(1);
        expect(res.body.segments[0].totalMarks).toBe(2);
        expect(res.body.segments[0].level).toBe('easy');
        expect(res.body.segments[0].origin).toBe('pin');
        expect(res.body.segments[0].midpoint).toBeTruthy();
    });

    test('pins on different blocks stay separate segments', async () => {
        await createMark({
            valetId: String(oid()),
            street: 'Court Street',
            pin: CG,
            level: 'easy',
        });
        await createMark({
            valetId: String(oid()),
            street: 'Court Street',
            // ~500m north — different tile
            pin: { lat: CG.lat + 0.0045, lng: CG.lng },
            level: 'hard',
        });

        const res = await listBbox();
        expect(res.body.segments).toHaveLength(2);
    });

    test('report by segmentKey counts toward un-verifying', async () => {
        await createMark({
            valetId: String(oid()),
            street: 'Court Street',
            pin: CG,
            level: 'easy',
        });
        const { segments } = (await listBbox()).body;
        const key = segments[0].segmentKey;

        const r1 = mockRes();
        await streetParkingController.reportSegment(
            { body: { valetId: String(oid()), segmentKey: key } },
            r1
        );
        expect(r1.body.success).toBe(true);
        expect(r1.body.wouldUnverify).toBe(false);

        const r2 = mockRes();
        await streetParkingController.reportSegment(
            { body: { valetId: String(oid()), segmentKey: key } },
            r2
        );
        expect(r2.body.totalReports).toBe(2);
        expect(r2.body.wouldUnverify).toBe(true);
    });

    test('update accepts no_parking (was silently dropped before)', async () => {
        const owner = oid();
        const created = await createMark({
            valetId: String(owner),
            pin: CG,
            level: 'easy',
        });
        const res = mockRes();
        await streetParkingController.update(
            {
                params: { id: String(created.body.mark.id) },
                query: {},
                body: { level: 'no_parking', valetId: String(owner) },
            },
            res
        );
        expect(res.body.success).toBe(true);
        expect(res.body.mark.level).toBe('no_parking');
    });

    test('updating a mark requires the owning valet', async () => {
        const owner = oid();
        const created = await createMark({
            valetId: String(owner),
            pin: CG,
            level: 'easy',
        });
        const id = String(created.body.mark.id);

        const stranger = mockRes();
        await streetParkingController.update(
            { params: { id }, query: {}, body: { level: 'hard', valetId: String(oid()) } },
            stranger
        );
        expect(stranger.statusCode).toBe(403);

        const anonymous = mockRes();
        await streetParkingController.update(
            { params: { id }, query: {}, body: { level: 'hard' } },
            anonymous
        );
        expect(anonymous.statusCode).toBe(400);
    });

    test('report rejects malformed segmentKeys', async () => {
        for (const bad of ['{"$ne":1}', 'x'.repeat(201), 'key;drop']) {
            const res = mockRes();
            await streetParkingController.reportSegment(
                { body: { valetId: String(oid()), segmentKey: bad } },
                res
            );
            expect(res.statusCode).toBe(400);
        }
    });

    test('public list responses carry no owner ids for marks', async () => {
        await createMark({
            valetId: String(oid()),
            street: 'Court Street',
            pin: CG,
            level: 'easy',
        });
        const res = await listBbox();
        expect(res.body.segments[0].markedBy).toBeUndefined();
        expect(res.body.segments[0].valet).toBeUndefined();
    });

    test('deleting a mark requires the owning valet', async () => {
        const owner = oid();
        const created = await createMark({
            valetId: String(owner),
            pin: CG,
            level: 'easy',
        });
        const id = String(created.body.mark.id);

        const stranger = mockRes();
        await streetParkingController.remove(
            { params: { id }, query: { valetId: String(oid()) }, body: {} },
            stranger
        );
        expect(stranger.statusCode).toBe(403);

        const anonymous = mockRes();
        await streetParkingController.remove(
            { params: { id }, query: {}, body: {} },
            anonymous
        );
        expect(anonymous.statusCode).toBe(400);

        const owned = mockRes();
        await streetParkingController.remove(
            { params: { id }, query: { valetId: String(owner) }, body: {} },
            owned
        );
        expect(owned.body.success).toBe(true);
        expect(await StreetParkingMark.countDocuments()).toBe(0);
    });

    test('legacy path-based creation still works for old builds', async () => {
        const res = await createMark({
            valetId: String(oid()),
            street: 'Court Street',
            side: 'side1',
            level: 'moderate',
            path: [CG, { lat: CG.lat + 0.001, lng: CG.lng }],
        });
        expect(res.statusCode).toBe(201);
        expect(res.body.mark.origin).toBe('segment');
        expect(res.body.geometrySource).toBe('client-path');
    });
});

describe('free-spot pins', () => {
    test('marking works without a segmentId (outside the ML grid)', async () => {
        const res = mockRes();
        await locationController.markFreeSpace(
            {
                body: {
                    userId: String(oid()),
                    latitude: CG.lat,
                    longitude: CG.lng,
                },
            },
            res
        );
        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.expiresInMinutes).toBe(30);
    });

    test('list window is 30 minutes and carries no PII', async () => {
        const owner = oid();
        await FreeSpace.create({
            userId: owner,
            latitude: CG.lat,
            longitude: CG.lng,
            createdAt: new Date(Date.now() - 20 * 60 * 1000), // 20 min old — in
        });
        await FreeSpace.create({
            userId: owner,
            latitude: CG.lat,
            longitude: CG.lng,
            createdAt: new Date(Date.now() - 40 * 60 * 1000), // 40 min old — out
        });

        const res = mockRes();
        await locationController.listFreeSpaces({ query: {} }, res);
        expect(res.body.success).toBe(true);
        expect(res.body.count).toBe(1);
        expect(res.body.windowMinutes).toBe(30);
        const pin = res.body.data[0];
        expect(pin.createdAt).toBeTruthy();
        // The old populate shipped firstName/lastName/phone/profileImage
        // to any caller. userId must now be a bare id.
        expect(typeof pin.userId === 'object' ? pin.userId.phone : undefined)
            .toBeUndefined();
        expect(String(pin.userId)).toBe(String(owner));
    });

    test('only the owner can remove a pin', async () => {
        const owner = oid();
        const pin = await FreeSpace.create({
            userId: owner,
            latitude: CG.lat,
            longitude: CG.lng,
        });

        const stranger = mockRes();
        await locationController.deleteFreeSpace(
            {
                params: { freeSpaceId: String(pin._id) },
                query: { userId: String(oid()) },
                body: {},
            },
            stranger
        );
        expect(stranger.statusCode).toBe(403);

        const anonymous = mockRes();
        await locationController.deleteFreeSpace(
            { params: { freeSpaceId: String(pin._id) }, query: {}, body: {} },
            anonymous
        );
        expect(anonymous.statusCode).toBe(400);

        const owned = mockRes();
        await locationController.deleteFreeSpace(
            {
                params: { freeSpaceId: String(pin._id) },
                query: { userId: String(owner) },
                body: {},
            },
            owned
        );
        expect(owned.body.success).toBe(true);
        expect(await FreeSpace.countDocuments()).toBe(0);
    });
});
