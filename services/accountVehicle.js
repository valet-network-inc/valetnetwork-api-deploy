/**
 * The car on the account.
 *
 * Until Oct 30 2026 the account had no car. `updateUser` never read
 * `vehicle` and the User model had no field for it, so a car the customer
 * typed into the app's Your car screen was dropped by the server (the app
 * only kept it in memory), and the car a valet logged went onto that one
 * order and nowhere else. The app then showed its grey placeholder hints
 * ("White", "Honda Civic") in the empty fields, which customers read as the
 * wrong car.
 *
 * Now the account keeps the car. Whoever entered it last wins, and the
 * record says who and when.
 *
 * More than one car (Nov 4 2026, Rishi: "enable people to add multiple cars in
 * the your car section"): `vehicles` is the account's list, and its first car
 * is the one we expect next (the valet's suggestion). `vehicle` stays as a
 * mirror of that first car, because apps from before the list read and write
 * it. An account from before the list has only `vehicle`; carsOf reads that
 * as a list of one, so nothing had to be migrated.
 */
const User = require('../models/User');

const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const normalizeVehicle = (input) => {
    if (!input || typeof input !== 'object') return null;
    return {
        color: clean(input.color, 40),
        model: clean(input.model, 60),
        licensePlate: clean(input.licensePlate, 12).toUpperCase(),
    };
};

const isComplete = (v) => !!(v && v.color && v.model && v.licensePlate);

/**
 * Valets sometimes type a note into the car fields ("Can't find
 * vehicle/phone won't dial", "x", "Dsfdsf"). A car copied from an order has
 * to look like one: a plate of 5+ letters and digits with at least one of
 * each, and a model of 2+ characters. Only applied to copies from orders;
 * what the customer types for their own car is theirs.
 */
const looksLikeACar = (v) => {
    if (!isComplete(v)) return false;
    const plate = v.licensePlate.replace(/[^A-Z0-9]/g, '');
    return plate.length >= 5 && /[A-Z]/.test(plate) && /[0-9]/.test(plate)
        && v.model.replace(/[^A-Za-z0-9]/g, '').length >= 2;
};

/**
 * Whether a car on this order belongs on the customer's own account. A
 * doorman or hotel books for their guests, so the car on those orders is the
 * guest's, not the account holder's; valets also book for customers on their
 * own accounts.
 */
const orderCarBelongsToCustomer = (order, customer) => {
    if (!order || !customer) return false;
    if (order.endCustomerName || order.endCustomerPhone) return false;
    if (customer.isDoorman || customer.isValet || customer.enterpriseCode) return false;
    return true;
};

/* ----------------------------------------------------------------------------
 * The list
 * ------------------------------------------------------------------------- */

const MAX_CARS = 5;

/** A plate as a key: "kdt-4417" and "KDT 4417" are the same car. */
const plateKey = (plate) => String(plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const sameCar = (a, b) => !!(a && b && plateKey(a.licensePlate) && plateKey(a.licensePlate) === plateKey(b.licensePlate));

/** The account's cars, first = the one we expect next. Reads an account from before the list too. */
function carsOf(user) {
    if (!user) return [];
    const list = Array.isArray(user.vehicles) ? user.vehicles.filter((v) => v && plateKey(v.licensePlate)) : [];
    if (list.length) return list;
    return user.vehicle && plateKey(user.vehicle.licensePlate) ? [user.vehicle] : [];
}

const stamp = (v, { source, by } = {}) => ({
    color: v.color || '',
    model: v.model || '',
    licensePlate: v.licensePlate,
    ...(source ? { source } : {}),
    ...(by ? { by } : {}),
    at: new Date(),
});

/** A list as the customer typed it: cleaned, one per plate (first wins), at most MAX_CARS. */
function cleanList(cars, meta = { source: 'customer' }) {
    const out = [];
    for (const raw of Array.isArray(cars) ? cars : []) {
        const v = normalizeVehicle(raw);
        if (!v || !v.licensePlate || out.some((x) => sameCar(x, v))) continue;
        out.push(stamp(v, meta));
        if (out.length >= MAX_CARS) break;
    }
    return out;
}

/** The write for a whole list: `vehicle` mirrors its first car. */
const listUpdate = (list) =>
    list.length ? { $set: { vehicles: list, vehicle: list[0] } } : { $unset: { vehicles: 1, vehicle: 1 } };

/**
 * One car onto an account: it replaces the car with the same plate, else it is
 * added. `primary` puts it first (the car we expect next time); otherwise it
 * keeps its place, or goes last when new. `onlyIfMissing` never touches a car
 * already there (a copy from someone else never overwrites).
 */
async function upsertCar(userId, car, { source = 'customer', by, primary = true, onlyIfMissing = false } = {}) {
    const v = normalizeVehicle(car);
    if (!v || !v.licensePlate || !userId) return null;
    const user = await User.findById(userId).select('+vehicle +vehicles').lean();
    if (!user) return null;
    const cars = carsOf(user);
    const at = cars.findIndex((x) => sameCar(x, v));
    if (at >= 0 && onlyIfMissing) return null;
    const rec = stamp(v, { source, by });
    let list;
    if (primary) list = [rec, ...cars.filter((x) => !sameCar(x, v))];
    else if (at >= 0) list = cars.map((x, i) => (i === at ? rec : x));
    else if (cars.length >= MAX_CARS) return null;
    else list = [...cars, rec];
    await User.updateOne({ _id: userId }, listUpdate(list.slice(0, MAX_CARS)));
    return rec;
}

/**
 * A valet logged the car on an order: put it on the customer's account, first
 * in their list. Only a complete car (color, model and plate) is copied, so a
 * half-filled order never replaces a good record. Never throws: the order
 * write it follows has already succeeded.
 */
const copyOrderCarToAccount = async (order, vehicle) => {
    try {
        const v = normalizeVehicle(vehicle);
        if (!looksLikeACar(v) || !order || !order.customer) return null;
        const customer = await User.findById(order.customer)
            .select('isDoorman isValet enterpriseCode')
            .lean();
        if (!orderCarBelongsToCustomer(order, customer)) return null;
        return await upsertCar(customer._id, v, { source: 'valet', by: order.valet || undefined, primary: true });
    } catch (err) {
        console.error('[accountVehicle] copy failed:', err.message);
        return null;
    }
};

/**
 * The end of a park (Rishi, Nov 4 2026): "when a linked account adds a
 * different vehicle … and if it's the same car by the end of the transaction,
 * it gets saved to the linked account as well."
 *
 * The car the customer's side put on the order (`suggestedVehicle`: their
 * pick, a car they added for this park, or else the account's own) and the
 * car the order ends with (`vehicle`: the valet's entry, as since fixed) are
 * the same plate: then it goes on the booker's linked partner's list, last,
 * unless they already have it. A car the valet found to be a different one
 * never travels; nothing is ever overwritten. Called once an order completes
 * (models/Order.js). Never throws.
 */
async function shareConfirmedCar(orderId) {
    try {
        const Order = require('../models/Order');
        const order = await Order.findById(orderId)
            .select('customer vehicle suggestedVehicle orderType endCustomerName endCustomerPhone')
            .lean();
        if (!order || order.orderType === 'retrieval') return null;
        const final = normalizeVehicle(order.vehicle);
        if (!looksLikeACar(final) || !sameCar(final, order.suggestedVehicle)) return null;
        const customer = await User.findById(order.customer).select('isDoorman isValet enterpriseCode').lean();
        if (!orderCarBelongsToCustomer(order, customer)) return null;
        const { partnerIdOf } = require('./accountLinks');
        const partnerId = await partnerIdOf(order.customer);
        if (!partnerId) return null;
        return await upsertCar(partnerId, final, { source: 'partner', primary: false, onlyIfMissing: true });
    } catch (err) {
        console.error('[accountVehicle] share failed:', err.message);
        return null;
    }
}

/**
 * The car to put in front of the valet on a customer's new job (Nov 2026,
 * Rishi: "auto populating vehicle information for cars that we've already
 * parked for before"): the account's car, else the last real-looking car a
 * valet noted on one of their orders. A SUGGESTION only (`Order.suggestedVehicle`):
 * `order.vehicle` stays empty until the valet confirms it, because a filled
 * colour skips the valet's pre-pickup photo gate.
 */
async function suggestedVehicleFor(customerId) {
    if (!customerId) return null;
    const User = require('../models/User');
    const Order = require('../models/Order');
    const user = await User.findById(customerId).select('+vehicle +vehicles').lean();
    const first = carsOf(user)[0];
    const own = first && normalizeVehicle(first);
    if (own && (own.licensePlate || own.model)) return own;
    const last = await Order.findOne({ customer: customerId, 'vehicle.licensePlate': { $exists: true, $ne: '' } })
        .sort({ createdAt: -1 })
        .select('vehicle')
        .lean();
    const noted = last && last.vehicle && normalizeVehicle(last.vehicle);
    return noted && looksLikeACar(noted) ? noted : null;
}

module.exports = {
    normalizeVehicle,
    isComplete,
    looksLikeACar,
    orderCarBelongsToCustomer,
    copyOrderCarToAccount,
    suggestedVehicleFor,
    MAX_CARS,
    plateKey,
    sameCar,
    carsOf,
    cleanList,
    listUpdate,
    upsertCar,
    shareConfirmedCar,
};
