/**
 * seedshots.js — put the rig's database into the states we need to photograph.
 *
 * Run from inside the backend clone, against localrig.js:
 *   node seedshots.js live-valet-on-way
 *   node seedshots.js live-tracking
 *   node seedshots.js live-parked
 *   node seedshots.js live-say-the-code
 *   node seedshots.js history          <- completed orders for Activity/receipt
 *   node seedshots.js clear
 *
 * Writes order documents directly rather than driving the valet app, so no
 * real valet is dispatched and no card is touched.
 */
const mongoose = require('mongoose');

const URI = 'mongodb://127.0.0.1:27099/test';
const CARROLL = { lat: 40.6795, lng: -73.995 };

const money = (d) => Math.round(d * 100);

async function main() {
  const mode = process.argv[2] || 'live-parked';
  await mongoose.connect(URI);

  const User = require('./models/User');
  const Order = require('./models/Order');

  const customer = await User.findOne({ isValet: { $ne: true } }).sort({ createdAt: -1 });
  if (!customer) {
    console.error('No customer yet — sign up in the app first.');
    process.exit(1);
  }

  // A valet to attach to the ticket. Cloned from the customer so every
  // required field is already valid.
  let valet = await User.findOne({ isValet: true });
  if (!valet) {
    valet = await User.create({
      phone: '+19175550147',
      firstName: 'Marcus',
      lastName: 'Rivera',
      isValet: true,
      isActive: true,
      verified: true,
      age: 34,
      currentLocation: { ...CARROLL, address: '2nd Pl, Brooklyn', lastUpdated: new Date() },
    });
  }

  const base = () => ({
    customer: customer._id,
    customerLocation: {
      lat: CARROLL.lat,
      lng: CARROLL.lng,
      streetAddress: '5 2nd St, Brooklyn, NY 11231, USA',
    },
    orderType: 'parking',
    duration: 120,
    paymentMethod: 'card',
    paymentStatus: 'paid',
    vehicle: { make: 'BMW', model: 'X5', color: 'Red', licensePlate: 'AA224' },
  });

  const parkedAt = {
    lat: 40.6802,
    lng: -73.9961,
    streetAddress: '84 2nd Pl, Brooklyn, NY 11231',
  };

  if (mode === 'clear') {
    const r = await Order.deleteMany({ customer: customer._id });
    console.log('cleared', r.deletedCount, 'orders');
    return done();
  }

  if (mode === 'history') {
    await Order.deleteMany({ customer: customer._id });
    const day = 86400000;
    const now = Date.now();
    const rows = [
      { d: 1, amt: money(13), type: 'parking', service: 'standard', addr: '360 Smith St, Brooklyn, NY 11231' },
      { d: 3, amt: money(10), type: 'parking', service: 'standard', addr: '5 2nd St, Brooklyn, NY 11231' },
      { d: 5, amt: money(15), type: 'parking', service: 'standard', asp: true, addr: '84 2nd Pl, Brooklyn, NY 11231' },
      { d: 8, amt: money(5), type: 'retrieval', service: 'standard', addr: '112 Court St, Brooklyn, NY 11201' },
      { d: 12, amt: money(10), type: 'parking', service: 'standard', addr: '5 2nd St, Brooklyn, NY 11231' },
    ];
    for (const r of rows) {
      const at = new Date(now - r.d * day);
      await Order.create({
        ...base(),
        orderType: r.type,
        serviceType: r.service,
        status: 'completed',
        totalAmount: r.amt,
        valet: valet._id,
        parkingLocation: { ...parkedAt, streetAddress: r.addr },
        createdAt: at,
        updatedAt: at,
        pickUpTime: at,
        ...(r.asp ? { asp_time: at } : {}),
        otpVerifiedTimes: { orderCreation: at, parkingLocation: at, returnKey: at },
      });
    }
    console.log('seeded', rows.length, 'completed orders');
    return done();
  }

  // one live order, in whichever state was asked for
  await Order.deleteMany({ customer: customer._id, status: { $ne: 'completed' } });
  const now = new Date();
  const doc = {
    ...base(),
    status: 'accepted',
    totalAmount: money(13),
    serviceType: 'standard',
    valet: valet._id,
    valetLocation: { lat: 40.6811, lng: -73.9973, lastUpdated: now },
    createdAt: now,
    pickUpTime: now,
  };

  if (mode === 'live-pending') {
    doc.status = 'pending';
    delete doc.valet;
    delete doc.valetLocation;
  } else if (mode === 'live-valet-on-way' || mode === 'live-tracking') {
    doc.status = 'accepted';
  } else if (mode === 'live-parked') {
    doc.status = 'parked';
    doc.parkingLocation = parkedAt;
    doc.otpVerifiedTimes = { orderCreation: now, parkingLocation: now };
  } else if (mode === 'live-say-the-code') {
    doc.status = 'keys-returning';
    doc.parkingLocation = parkedAt;
    doc.otpVerifiedTimes = { orderCreation: now, parkingLocation: now };
    doc.otp = {
      code: '4417',
      createdAt: now,
      expiresAt: new Date(Date.now() + 15 * 60000),
      verified: false,
      type: 'return_key',
    };
  } else {
    console.error('unknown mode', mode);
    process.exit(1);
  }

  const o = await Order.create(doc);
  console.log('order', o._id.toString(), '->', o.status);
  return done();
}

async function done() {
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
