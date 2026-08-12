/**
 * Cancelling a retrieval — the rules that are expensive to get wrong.
 * Run: npx jest cancelRetrieval
 *
 * Three things are being pinned down here:
 *
 *  1. A cancelled retrieval leaves the car parked and the order claimable
 *     again, with its service type (and so its included return trip) intact.
 *
 *  2. Cancel has to stop at the keys handoff. A retrieval sits on 'accepted'
 *     from the moment a valet takes it until the car is back, so status alone
 *     can't tell "walking over" from "driving your car".
 *
 *  3. There is exactly one parked state. Phones still running the old build
 *     send the retired 'parked-with-keys'; it has to fold into 'parked'
 *     instead of failing validation and stranding a valet mid-park.
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../models/Order');
const User = require('../models/User');
const orderController = require('../controllers/orderController');

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

/** Socket double that records every emit so we can assert on the wiring. */
const mockIo = () => {
    const emits = [];
    const io = {
        emits,
        emit: (event, payload) => emits.push({ room: null, event, payload }),
        to: (room) => ({
            emit: (event, payload) => emits.push({ room, event, payload }),
        }),
    };
    return io;
};

// `phone` is unique-indexed and `verified` is required on User.
let phoneSeq = 5550000000;
const makeCustomer = () => User.create({
    firstName: 'Rishi',
    lastName: 'G',
    email: `c${new mongoose.Types.ObjectId()}@example.com`,
    phone: String(++phoneSeq),
    verified: true,
});

// `customerLocation.streetAddress` is required, so share one valid pin.
const LOC = { lat: 40.68, lng: -73.99, streetAddress: '1 Court St' };

/**
 * A finished park plus the retrieval it spawned, wired the way
 * `createRetrievalOrder` wires them.
 */
const makePair = async ({
    customerId,
    serviceType = 'park-and-hold',
    parkingStatus = 'parked',
    retrievalStatus = 'accepted',
    retrievalExtras = {},
    parkingExtras = {},
}) => {
    const parking = await Order.create({
        customer: customerId,
        customerLocation: LOC,
        parkingType: 'street',
        orderType: 'parking',
        duration: 120,
        pickUpTime: new Date(),
        status: parkingStatus,
        totalAmount: 1300,
        paymentMethod: 'card',
        paymentStatus: 'paid',
        serviceType,
        ...parkingExtras,
    });
    const retrieval = await Order.create({
        customer: customerId,
        customerLocation: LOC,
        parkingType: 'retrieval',
        orderType: 'retrieval',
        duration: 30,
        pickUpTime: new Date(),
        status: retrievalStatus,
        totalAmount: 300,
        paymentMethod: 'card',
        paymentStatus: 'paid',
        isFreeService: true,
        serviceType,
        linkedOrderId: parking._id,
        ...retrievalExtras,
    });
    parking.linkedOrderId = retrieval._id;
    await parking.save();
    return { parking, retrieval };
};

const cancel = async (orderId, userId) => {
    const req = { body: { orderId: String(orderId), userId: String(userId) }, io: mockIo() };
    const res = mockRes();
    await orderController.cancelOrder(req, res);
    return { req, res };
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
    await Order.deleteMany({});
    await User.deleteMany({});
});

describe('restoring the park', () => {
    test('Park & Retrieve goes back to parked with its included return intact', async () => {
        const customer = await makeCustomer();
        const { parking, retrieval } = await makePair({ customerId: customer._id });

        const { res } = await cancel(retrieval._id, customer._id);
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);

        const after = await Order.findById(parking._id);
        expect(after.status).toBe('parked');
        // The return trip is bought with the park, so losing this would cost
        // the customer $5 for something they already paid for.
        expect(after.serviceType).toBe('park-and-hold');
        expect(after.linkedOrderId).toBeUndefined();
        expect((await Order.findById(retrieval._id)).status).toBe('cancelled');
    });

    test('a standard park goes back to parked', async () => {
        const customer = await makeCustomer();
        const { parking, retrieval } = await makePair({
            customerId: customer._id,
            serviceType: 'standard',
            parkingStatus: 'parked',
        });

        await cancel(retrieval._id, customer._id);

        expect((await Order.findById(parking._id)).status).toBe('parked');
    });

    test('an old client writing the retired status folds into parked', async () => {
        // Phones on the shipped build still send this when a valet finishes a
        // park. Rejecting it would strand them mid-park until they updated.
        const customer = await makeCustomer();
        const parking = await Order.create({
            customer: customer._id,
            customerLocation: LOC,
            parkingType: 'street',
            orderType: 'parking',
            duration: 120,
            pickUpTime: new Date(),
            status: 'parked-with-keys',
            totalAmount: 1300,
            paymentMethod: 'card',
            paymentStatus: 'paid',
            serviceType: 'park-and-hold',
        });
        expect(parking.status).toBe('parked');

        // ...and on update, which is the path the valet app actually uses.
        await Order.findByIdAndUpdate(parking._id, { status: 'parked-with-keys' });
        expect((await Order.findById(parking._id)).status).toBe('parked');
    });

    test('Enterprise park (flipped to completed on request) is restored', async () => {
        const customer = await makeCustomer();
        const { parking, retrieval } = await makePair({
            customerId: customer._id,
            parkingStatus: 'completed',
        });

        await cancel(retrieval._id, customer._id);

        expect((await Order.findById(parking._id)).status).toBe('parked');
    });

    test('the restored park is returned to the caller and pushed on the socket', async () => {
        const customer = await makeCustomer();
        const { parking, retrieval } = await makePair({ customerId: customer._id });

        const { req, res } = await cancel(retrieval._id, customer._id);

        expect(String(res.body.restoredParkingOrder._id)).toBe(String(parking._id));
        expect(res.body.restoredParkingOrder.status).toBe('parked');

        const restoreEvent = req.io.emits.find(
            (e) => e.payload?.type === 'RETRIEVAL_CANCELLED_PARK_RESTORED'
        );
        expect(restoreEvent).toBeTruthy();
        expect(restoreEvent.room).toBe(String(customer._id));
        expect(req.io.emits.some((e) => e.payload?.type === 'ORDER_CANCELLED')).toBe(true);
    });

    test('a park the customer already closed out is not resurrected', async () => {
        const customer = await makeCustomer();
        const { parking, retrieval } = await makePair({
            customerId: customer._id,
            parkingStatus: 'cancelled',
        });

        const { res } = await cancel(retrieval._id, customer._id);
        expect(res.statusCode).toBe(200);

        const after = await Order.findById(parking._id);
        expect(after.status).toBe('cancelled');
        expect(after.linkedOrderId).toBeUndefined();
        expect(res.body.restoredParkingOrder).toBeNull();
    });

    test('cancelling a plain park touches nothing else', async () => {
        const customer = await makeCustomer();
        const parking = await Order.create({
            customer: customer._id,
            customerLocation: LOC,
            parkingType: 'street',
            orderType: 'parking',
            duration: 60,
            pickUpTime: new Date(),
            status: 'pending',
            totalAmount: 1000,
            paymentMethod: 'card',
            paymentStatus: 'paid',
        });

        const { res } = await cancel(parking._id, customer._id);

        expect(res.statusCode).toBe(200);
        expect(res.body.restoredParkingOrder).toBeNull();
        expect((await Order.findById(parking._id)).status).toBe('cancelled');
    });
});

describe('the custody gate', () => {
    test('blocked once the keys have changed hands', async () => {
        const customer = await makeCustomer();
        const { parking, retrieval } = await makePair({
            customerId: customer._id,
            retrievalExtras: { otpVerifiedTimes: { returnKey: new Date() } },
        });

        const { res } = await cancel(retrieval._id, customer._id);

        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('RETRIEVAL_IN_CUSTODY');
        // Nothing moved — the valet is still on the job.
        expect((await Order.findById(retrieval._id)).status).toBe('accepted');
        expect((await Order.findById(parking._id)).status).toBe('parked');
    });

    test('blocked for a street-cleaning return leg, which never stamps a handoff', async () => {
        const customer = await makeCustomer();
        const { retrieval } = await makePair({
            customerId: customer._id,
            retrievalExtras: { aspMode: true },
        });

        const { res } = await cancel(retrieval._id, customer._id);

        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('RETRIEVAL_IN_CUSTODY');
    });

    test('blocked for an older sweep leg that only the parent flags', async () => {
        const customer = await makeCustomer();
        const { retrieval } = await makePair({
            customerId: customer._id,
            parkingExtras: { aspMode: true, aspOrderCreated: true },
        });

        const { res } = await cancel(retrieval._id, customer._id);

        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('RETRIEVAL_IN_CUSTODY');
    });

    test('a manual retrieval on an ASP park is still the customer\'s to cancel', async () => {
        // The park is an ASP one, but the customer asked for the car back
        // themselves rather than the sweep cron minting a return leg. Treating
        // "parent is ASP" as custody on its own would lock them out.
        const customer = await makeCustomer();
        const { parking, retrieval } = await makePair({
            customerId: customer._id,
            parkingExtras: { aspMode: true },
        });

        const { res } = await cancel(retrieval._id, customer._id);

        expect(res.statusCode).toBe(200);
        expect((await Order.findById(parking._id)).status).toBe('parked');
    });

    test('blocked for a standalone retrieval once beat 1 is verified', async () => {
        // Standalone $5 retrievals are minted by createOrder, whose OTP is
        // `order_creation` — so the keys handoff stamps orderCreation, not
        // returnKey. Reading only returnKey left these cancellable (and fully
        // refundable) while the valet was already driving the car back.
        const customer = await makeCustomer();
        const standalone = await Order.create({
            customer: customer._id,
            customerLocation: LOC,
            parkingType: 'retrieval',
            orderType: 'retrieval',
            duration: 30,
            pickUpTime: new Date(),
            status: 'accepted',
            totalAmount: 500,
            paymentMethod: 'card',
            paymentStatus: 'paid',
            otpVerifiedTimes: { orderCreation: new Date() },
        });

        const { res } = await cancel(standalone._id, customer._id);

        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe('RETRIEVAL_IN_CUSTODY');
        expect((await Order.findById(standalone._id)).status).toBe('accepted');
    });

    test('a standalone retrieval nobody has met yet is still cancellable', async () => {
        const customer = await makeCustomer();
        const standalone = await Order.create({
            customer: customer._id,
            customerLocation: LOC,
            parkingType: 'retrieval',
            orderType: 'retrieval',
            duration: 30,
            pickUpTime: new Date(),
            status: 'pending',
            totalAmount: 500,
            paymentMethod: 'card',
            paymentStatus: 'paid',
        });

        const { res } = await cancel(standalone._id, customer._id);

        expect(res.statusCode).toBe(200);
    });

    test('allowed while the valet is still on their way', async () => {
        const customer = await makeCustomer();
        const { retrieval } = await makePair({ customerId: customer._id });

        const { res } = await cancel(retrieval._id, customer._id);

        expect(res.statusCode).toBe(200);
    });

    test("someone else's order is still refused", async () => {
        const customer = await makeCustomer();
        const stranger = await makeCustomer();
        const { retrieval } = await makePair({ customerId: customer._id });

        const { res } = await cancel(retrieval._id, stranger._id);

        expect(res.statusCode).toBe(403);
    });
});

describe('one retrieval per park', () => {
    const requestRetrieval = async (customerId, parkingId) => {
        const req = {
            body: { customer: String(customerId), originalOrderId: String(parkingId) },
            hasSubscription: false,
            io: mockIo(),
        };
        const res = mockRes();
        await orderController.createRetrievalOrder(req, res);
        return res;
    };

    test('a second request returns the one already in flight', async () => {
        const customer = await makeCustomer();
        const parking = await Order.create({
            customer: customer._id,
            customerLocation: LOC,
            parkingType: 'street',
            orderType: 'parking',
            duration: 120,
            pickUpTime: new Date(),
            status: 'parked',
            totalAmount: 1300,
            paymentMethod: 'card',
            paymentStatus: 'paid',
            serviceType: 'park-and-hold',
        });

        const first = await requestRetrieval(customer._id, parking._id);
        expect(first.statusCode).toBe(201);
        expect(first.body.success).toBe(true);

        const second = await requestRetrieval(customer._id, parking._id);
        expect(second.statusCode).toBe(200);
        expect(second.body.alreadyRequested).toBe(true);
        expect(String(second.body.order._id)).toBe(String(first.body.order._id));

        // One valet run, not two.
        expect(await Order.countDocuments({ orderType: 'retrieval' })).toBe(1);
    });

    test('requesting a return leaves the park parked and linked', async () => {
        const customer = await makeCustomer();
        const parking = await Order.create({
            customer: customer._id,
            customerLocation: LOC,
            parkingType: 'street',
            orderType: 'parking',
            duration: 120,
            pickUpTime: new Date(),
            status: 'parked',
            totalAmount: 1300,
            paymentMethod: 'card',
            paymentStatus: 'paid',
            serviceType: 'park-and-hold',
        });

        await requestRetrieval(customer._id, parking._id);

        // Requesting a return doesn't move the car; the park stays parked and
        // just points at the leg that's coming.
        const after = await Order.findById(parking._id);
        expect(after.status).toBe('parked');
        expect(after.linkedOrderId).toBeTruthy();
    });

    test('the whole journey: ask for it back, change your mind, ask again later', async () => {
        const customer = await makeCustomer();
        const parking = await Order.create({
            customer: customer._id,
            customerLocation: LOC,
            parkingType: 'street',
            orderType: 'parking',
            duration: 120,
            pickUpTime: new Date(),
            status: 'parked',
            totalAmount: 1300,
            paymentMethod: 'card',
            paymentStatus: 'paid',
            serviceType: 'park-and-hold',
        });

        const requested = await requestRetrieval(customer._id, parking._id);
        expect(requested.statusCode).toBe(201);

        const { res } = await cancel(requested.body.order._id, customer._id);
        expect(res.statusCode).toBe(200);

        const after = await Order.findById(parking._id);
        // Back to a keys-held ticket with its included return trip intact —
        // not a $5 one.
        expect(after.status).toBe('parked');
        expect(after.serviceType).toBe('park-and-hold');
        expect(after.linkedOrderId).toBeUndefined();
    });

    test('asking again works once the first was cancelled', async () => {
        const customer = await makeCustomer();
        const parking = await Order.create({
            customer: customer._id,
            customerLocation: LOC,
            parkingType: 'street',
            orderType: 'parking',
            duration: 120,
            pickUpTime: new Date(),
            status: 'parked',
            totalAmount: 1300,
            paymentMethod: 'card',
            paymentStatus: 'paid',
            serviceType: 'park-and-hold',
        });

        const first = await requestRetrieval(customer._id, parking._id);
        await cancel(first.body.order._id, customer._id);

        const again = await requestRetrieval(customer._id, parking._id);
        expect(again.statusCode).toBe(201);
        expect(again.body.alreadyRequested).toBeUndefined();
        expect(String(again.body.order._id)).not.toBe(String(first.body.order._id));
    });
});
