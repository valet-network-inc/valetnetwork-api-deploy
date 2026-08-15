/**
 * Where a handoff photo came from, and where it was taken.
 * Run: npx jest orderPhotoSource
 *
 * These photos are the evidence trail in a damage dispute, so two things
 * have to hold:
 *
 *  1. A photo picked out of the valet's library is recorded as such, and
 *     never carries a capture location — it could be from any day, anywhere.
 *
 *  2. A camera photo DOES carry its location. Multipart fields arrive as
 *     strings, and the old `typeof capturedLat === 'number'` test could
 *     never be true, so this field was silently empty on every photo ever
 *     uploaded. That's the regression this pins down.
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../models/Order');
const OrderPhoto = require('../models/OrderPhoto');
const User = require('../models/User');

// Firebase Storage is the one external dependency in this path; stub it so
// the test exercises our validation and persistence, not Google's.
jest.mock('../services/firebaseStorage', () => ({
    uploadFile: jest.fn(async () => ({ bucket: 'test-bucket' })),
    getSignedUrl: jest.fn(async () => 'https://signed.example/photo.jpg'),
    deleteFile: jest.fn(async () => true),
}));

const orderPhotoController = require('../controllers/orderPhotoController');

let mongo;

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

let phoneSeq = 5570000000;
const makeUser = (extra = {}) => User.create({
    firstName: 'Test',
    lastName: 'User',
    email: `p${new mongoose.Types.ObjectId()}@example.com`,
    phone: String(++phoneSeq),
    verified: true,
    ...extra,
});

const LOC = { lat: 40.68, lng: -73.99, streetAddress: '1 Court St' };

const makeOrder = (customerId, valetId) => Order.create({
    customer: customerId,
    customerLocation: LOC,
    parkingType: 'street',
    orderType: 'parking',
    duration: 120,
    pickUpTime: new Date(),
    status: 'accepted',
    totalAmount: 1300,
    paymentMethod: 'card',
    paymentStatus: 'paid',
    valet: valetId,
});

/** Multipart bodies are all strings — that's the whole point of test 2. */
const upload = async (orderId, valetId, fields = {}) => {
    const req = {
        params: { orderId: String(orderId) },
        body: {
            type: 'pre_pickup',
            valetId: String(valetId),
            ...fields,
        },
        file: {
            buffer: Buffer.from('fake-jpeg-bytes'),
            mimetype: 'image/jpeg',
            size: 15,
            originalname: 'photo.jpg',
        },
    };
    const res = mockRes();
    await orderPhotoController.uploadPhoto(req, res);
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
    await OrderPhoto.deleteMany({});
    await Order.deleteMany({});
    await User.deleteMany({});
});

describe('photo provenance', () => {
    test('a library pick is recorded as library and carries no location', async () => {
        const customer = await makeUser();
        const valet = await makeUser({ isValet: true });
        const order = await makeOrder(customer._id, valet._id);

        const res = await upload(order._id, valet._id, {
            source: 'library',
            // Even if a client sends coordinates, a library photo must not
            // keep them — they describe where the valet stood while picking.
            capturedLat: '40.6754',
            capturedLng: '-73.9976',
        });

        expect(res.statusCode).toBe(200);
        expect(res.body.photo.source).toBe('library');

        const stored = await OrderPhoto.findById(res.body.photo.id);
        expect(stored.source).toBe('library');
        expect(stored.capturedAtLocation?.lat).toBeUndefined();
    });

    test('a camera photo keeps its location — multipart sends strings', async () => {
        const customer = await makeUser();
        const valet = await makeUser({ isValet: true });
        const order = await makeOrder(customer._id, valet._id);

        const res = await upload(order._id, valet._id, {
            source: 'camera',
            capturedLat: '40.6754',
            capturedLng: '-73.9976',
        });

        expect(res.statusCode).toBe(200);

        const stored = await OrderPhoto.findById(res.body.photo.id);
        expect(stored.source).toBe('camera');
        expect(stored.capturedAtLocation.lat).toBeCloseTo(40.6754, 4);
        expect(stored.capturedAtLocation.lng).toBeCloseTo(-73.9976, 4);
    });

    test('a client that sends no source is treated as camera', async () => {
        const customer = await makeUser();
        const valet = await makeUser({ isValet: true });
        const order = await makeOrder(customer._id, valet._id);

        const res = await upload(order._id, valet._id);

        expect(res.statusCode).toBe(200);
        const stored = await OrderPhoto.findById(res.body.photo.id);
        expect(stored.source).toBe('camera');
    });

    test('a junk source value is not trusted into the record', async () => {
        const customer = await makeUser();
        const valet = await makeUser({ isValet: true });
        const order = await makeOrder(customer._id, valet._id);

        const res = await upload(order._id, valet._id, { source: 'scanner' });

        expect(res.statusCode).toBe(200);
        const stored = await OrderPhoto.findById(res.body.photo.id);
        expect(stored.source).toBe('camera');
    });

    test('unparseable coordinates leave the location empty rather than NaN', async () => {
        const customer = await makeUser();
        const valet = await makeUser({ isValet: true });
        const order = await makeOrder(customer._id, valet._id);

        const res = await upload(order._id, valet._id, {
            source: 'camera',
            capturedLat: 'undefined',
            capturedLng: '',
        });

        expect(res.statusCode).toBe(200);
        const stored = await OrderPhoto.findById(res.body.photo.id);
        expect(stored.capturedAtLocation?.lat).toBeUndefined();
    });

    test('listPhotos reports the source, defaulting old rows to camera', async () => {
        const customer = await makeUser();
        const valet = await makeUser({ isValet: true });
        const order = await makeOrder(customer._id, valet._id);

        await upload(order._id, valet._id, { source: 'library' });
        // A row written before the field existed.
        await OrderPhoto.collection.insertOne({
            order: order._id,
            valet: valet._id,
            type: 'post_park',
            bucket: 'test-bucket',
            storagePath: 'legacy/path.jpg',
            mimeType: 'image/jpeg',
            capturedAt: new Date(),
        });

        const req = { params: { orderId: String(order._id) }, query: {} };
        const res = mockRes();
        await orderPhotoController.listPhotos(req, res);

        expect(res.body.success).toBe(true);
        const bySource = res.body.photos.map((p) => p.source).sort();
        expect(bySource).toEqual(['camera', 'library']);
    });
});
