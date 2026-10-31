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

/**
 * A valet logged the car on an order: put it on the customer's account.
 * Only a complete car (color, model and plate) is copied, so a half-filled
 * order never replaces a good record. Never throws: the order write it
 * follows has already succeeded.
 */
const copyOrderCarToAccount = async (order, vehicle) => {
    try {
        const v = normalizeVehicle(vehicle);
        if (!looksLikeACar(v) || !order || !order.customer) return null;
        const customer = await User.findById(order.customer)
            .select('isDoorman isValet enterpriseCode')
            .lean();
        if (!orderCarBelongsToCustomer(order, customer)) return null;
        const record = {
            ...v,
            source: 'valet',
            ...(order.valet ? { by: order.valet } : {}),
            at: new Date(),
        };
        await User.updateOne({ _id: customer._id }, { $set: { vehicle: record } });
        return record;
    } catch (err) {
        console.error('[accountVehicle] copy failed:', err.message);
        return null;
    }
};

module.exports = { normalizeVehicle, isComplete, looksLikeACar, orderCarBelongsToCustomer, copyOrderCarToAccount };
