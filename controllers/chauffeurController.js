/**
 * chauffeurController — rider side of the Chauffeur (ride-hail) product.
 *
 * Endpoints (mounted at /api/chauffeur):
 *   POST /quote    -> price a pickup->dropoff trip (no commitment)
 *   POST /request  -> create a pending ride request for the rider
 *
 * Pricing comes entirely from the engine (services/chauffeurQuoteService.js);
 * this controller only resolves trip geometry (Google Directions) and live
 * supply/demand, then persists a snapshot. Dispatch, payment capture, and live
 * tracking land in later increments (driver side not built yet).
 */

const axios = require('axios');
const Ride = require('../models/Ride');
const User = require('../models/User');
const { getRideQuote } = require('../services/chauffeurQuoteService');
const { pickHeadlineOffers } = require('../services/chauffeurMatch');
const { sendPushNotification } = require('./notificationController');

const stripeModule = require('stripe');
const stripe = process.env.STRIPE_API_KEY ? stripeModule(process.env.STRIPE_API_KEY) : null;

const GOOGLE_KEY = process.env.REACT_APP_GOOGLE_MAPS_APIKEY;

/**
 * Resolve driving distance (miles) + duration (minutes) for a trip via Google
 * Directions. Returns null on any failure so the caller can fall back to
 * client-supplied geometry.
 */
async function getTripGeometry(pickup, dropoff) {
  if (!GOOGLE_KEY) return null;
  try {
    const { data } = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
      params: {
        origin: `${pickup.lat},${pickup.lng}`,
        destination: `${dropoff.lat},${dropoff.lng}`,
        mode: 'driving',
        departure_time: 'now', // traffic-aware duration when available
        key: GOOGLE_KEY,
      },
      timeout: 5000,
    });
    const route = data.routes && data.routes[0];
    const leg = route && route.legs && route.legs[0];
    if (!leg) return null;
    const meters = leg.distance.value;
    const seconds = (leg.duration_in_traffic || leg.duration).value;
    return {
      distanceMiles: meters / 1609.344,
      durationMinutes: seconds / 60,
    };
  } catch (err) {
    console.error('[chauffeur] Directions lookup failed:', err.message);
    return null;
  }
}

/**
 * Live supply/demand for surge. With no chauffeur pool yet, demand stays
 * neutral (surge = 1). Wire real counts when the driver side ships:
 *   openRequests     = Ride.countDocuments({ status: { $in: ['requested','searching'] } })
 *   availableDrivers = online idle chauffeurs near the pickup.
 */
async function getSupplyDemand(/* pickup */) {
  return { openRequests: 0, availableDrivers: 0 };
}

function validLocation(loc) {
  return loc && typeof loc.lat === 'number' && typeof loc.lng === 'number';
}

/**
 * POST /api/chauffeur/quote
 * Body: { pickup:{lat,lng,streetAddress}, dropoff:{...},
 *         miles?, minutes?, serviceTier? }
 * Returns the full pricing breakdown (cents).
 */
exports.getQuote = async (req, res) => {
  try {
    const { pickup, dropoff, miles, minutes, serviceTier } = req.body;
    if (!validLocation(pickup) || !validLocation(dropoff)) {
      return res.status(400).json({ success: false, message: 'pickup and dropoff coordinates are required.' });
    }

    let geometry = await getTripGeometry(pickup, dropoff);
    if (!geometry && typeof miles === 'number' && typeof minutes === 'number') {
      geometry = { distanceMiles: miles, durationMinutes: minutes }; // client fallback
    }
    if (!geometry) {
      return res.status(502).json({ success: false, message: 'Could not determine trip distance.' });
    }

    const { openRequests, availableDrivers } = await getSupplyDemand(pickup);

    const quote = await getRideQuote({
      miles: geometry.distanceMiles,
      minutes: geometry.durationMinutes,
      wav: serviceTier === 'wav',
      pickup,
      dropoff,
      openRequests,
      availableDrivers,
    });

    return res.json({
      success: true,
      distanceMiles: Number(geometry.distanceMiles.toFixed(2)),
      durationMinutes: Math.round(geometry.durationMinutes),
      quote,
    });
  } catch (err) {
    console.error('[chauffeur] getQuote error:', err);
    return res.status(500).json({ success: false, message: 'Failed to price ride.' });
  }
};

/**
 * POST /api/chauffeur/request
 * Body: { riderId, pickup, dropoff, serviceTier? }
 * Re-prices server-side (never trust a client price), persists a pending Ride.
 * No charge / dispatch yet — that lands with the driver side.
 */
exports.requestRide = async (req, res) => {
  try {
    const { riderId, pickup, dropoff, serviceTier } = req.body;
    if (!riderId) {
      return res.status(400).json({ success: false, message: 'riderId is required.' });
    }
    if (!validLocation(pickup) || !validLocation(dropoff) || !pickup.streetAddress || !dropoff.streetAddress) {
      return res.status(400).json({ success: false, message: 'pickup and dropoff (with address) are required.' });
    }

    let geometry = await getTripGeometry(pickup, dropoff);
    if (!geometry && typeof req.body.miles === 'number' && typeof req.body.minutes === 'number') {
      geometry = { distanceMiles: req.body.miles, durationMinutes: req.body.minutes };
    }
    if (!geometry) {
      return res.status(502).json({ success: false, message: 'Could not determine trip distance.' });
    }

    const { openRequests, availableDrivers } = await getSupplyDemand(pickup);
    const quote = await getRideQuote({
      miles: geometry.distanceMiles,
      minutes: geometry.durationMinutes,
      wav: serviceTier === 'wav',
      pickup,
      dropoff,
      openRequests,
      availableDrivers,
    });

    const ride = await Ride.create({
      rider: riderId,
      pickup,
      dropoff,
      distanceMiles: Number(geometry.distanceMiles.toFixed(2)),
      durationMinutes: Math.round(geometry.durationMinutes),
      serviceTier: serviceTier === 'wav' ? 'wav' : 'standard',
      pricing: {
        floorCents: quote.floorCents,
        baseRateCents: quote.baseRateCents,
        surgeMultiplier: quote.surgeMultiplier,
        suggestedCents: quote.suggestedCents,
        softwareFeeCents: quote.softwareFeeCents,
        driverNetCents: quote.driverNetCents,
        feeMode: quote.feeMode,
        referenceCompetitorCents: quote.referenceCompetitorCents,
      },
      status: 'searching',
    });

    // Dispatch: tell online chauffeurs a new ride is open for bids (socket
    // broadcast + best-effort FCM). Drivers also poll GET /open-rides.
    try {
      if (req.io) {
        req.io.emit('newRideRequest', {
          rideId: ride._id,
          pickup: ride.pickup,
          distanceMiles: ride.distanceMiles,
        });
      }
      const onlineDrivers = await User.find({ isChauffeur: true, chauffeurOnline: true }).select('firebaseUid');
      await Promise.all(
        onlineDrivers.map((d) =>
          d.firebaseUid
            ? sendPushNotification(
                d.firebaseUid,
                'New ride request',
                'A rider nearby is requesting a chauffeur — set your price.',
                { type: 'new_ride', rideId: String(ride._id) }
              ).catch(() => {})
            : null
        )
      );
    } catch (e) {
      console.error('[chauffeur] dispatch error:', e.message);
    }

    // No fare returned to the rider — price comes from driver bids (reverse
    // auction). suggestedCents is stored as the DRIVER's bid anchor only.
    return res.json({
      success: true,
      rideId: ride._id,
      status: ride.status,
      distanceMiles: ride.distanceMiles,
      durationMinutes: ride.durationMinutes,
    });
  } catch (err) {
    console.error('[chauffeur] requestRide error:', err);
    return res.status(500).json({ success: false, message: 'Failed to request ride.' });
  }
};

/**
 * POST /api/chauffeur/:rideId/bid   (driver side, later)
 * Body: { chauffeurId, chauffeurName?, priceCents, etaMinutes?, distanceMeters? }
 * A driver bids on an open ride. priceCents is validated >= the ride's floor.
 */
exports.submitBid = async (req, res) => {
  try {
    const { rideId } = req.params;
    const { chauffeurId, chauffeurName, priceCents, etaMinutes, distanceMeters } = req.body;

    if (typeof priceCents !== 'number') {
      return res.status(400).json({ success: false, message: 'priceCents is required.' });
    }
    const ride = await Ride.findById(rideId);
    if (!ride) return res.status(404).json({ success: false, message: 'Ride not found.' });
    if (ride.status !== 'searching') {
      return res.status(409).json({ success: false, message: 'This ride is no longer accepting bids.' });
    }
    const floorCents = ride.pricing?.floorCents ?? 0;
    if (priceCents < floorCents) {
      return res.status(400).json({ success: false, message: 'Bid is below the floor price.' });
    }

    ride.offers.push({ chauffeur: chauffeurId, chauffeurName, priceCents, etaMinutes, distanceMeters, status: 'offered' });
    await ride.save();
    return res.json({ success: true, offerId: ride.offers[ride.offers.length - 1]._id });
  } catch (err) {
    console.error('[chauffeur] submitBid error:', err);
    return res.status(500).json({ success: false, message: 'Failed to submit bid.' });
  }
};

/**
 * GET /api/chauffeur/:rideId/offers
 * Returns the open offers plus the cheapest + fastest headline ids the rider UI
 * surfaces. Polled by the rider while status is 'searching'.
 */
exports.getOffers = async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.rideId).lean();
    if (!ride) return res.status(404).json({ success: false, message: 'Ride not found.' });

    const offers = (ride.offers || []).filter((o) => o.status === 'offered');
    const { cheapestId, fastestId } = pickHeadlineOffers(offers);

    return res.json({
      success: true,
      status: ride.status,
      offers,
      cheapestOfferId: cheapestId,
      fastestOfferId: fastestId,
      chauffeur: ride.chauffeur || null,
      finalPriceCents: ride.finalPriceCents || null,
    });
  } catch (err) {
    console.error('[chauffeur] getOffers error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load offers.' });
  }
};

/**
 * POST /api/chauffeur/:rideId/select
 * Body: { offerId, riderId }
 * Rider picks an offer. Assigns the chauffeur, sets the final price, rejects
 * the rest, flips the ride to 'accepted'.
 */
exports.selectOffer = async (req, res) => {
  try {
    const { rideId } = req.params;
    const { offerId, riderId, paymentIntentId } = req.body;

    const ride = await Ride.findById(rideId);
    if (!ride) return res.status(404).json({ success: false, message: 'Ride not found.' });
    if (riderId && String(ride.rider) !== String(riderId)) {
      return res.status(403).json({ success: false, message: 'Not your ride.' });
    }
    if (ride.status !== 'searching') {
      return res.status(409).json({ success: false, message: 'This ride is no longer open.' });
    }

    const chosen = ride.offers.id(offerId);
    if (!chosen || chosen.status !== 'offered') {
      return res.status(404).json({ success: false, message: 'Offer not available.' });
    }

    // Verify the rider's payment was authorized (manual-capture intent) before
    // assigning. Captured later on trip completion.
    if (stripe && paymentIntentId) {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      const ok = ['requires_capture', 'processing', 'succeeded'].includes(pi.status);
      if (!ok) {
        return res.status(402).json({ success: false, message: 'Payment was not authorized.' });
      }
      ride.paymentIntentId = paymentIntentId;
      ride.paymentStatus = 'authorized';
    }

    ride.offers.forEach((o) => { o.status = o._id.equals(chosen._id) ? 'selected' : 'rejected'; });
    ride.chauffeur = chosen.chauffeur;
    ride.finalPriceCents = chosen.priceCents;
    ride.status = 'accepted';
    await ride.save();

    // Notify the assigned driver + the rider's room.
    try {
      if (req.io) {
        req.io.emit('rideUpdated', ride);
        if (chosen.chauffeur) req.io.to(String(chosen.chauffeur)).emit('rideUpdated', ride);
        req.io.to(String(ride.rider)).emit('rideUpdated', ride);
      }
    } catch (e) { /* non-blocking */ }

    return res.json({ success: true, ride });
  } catch (err) {
    console.error('[chauffeur] selectOffer error:', err);
    return res.status(500).json({ success: false, message: 'Failed to select offer.' });
  }
};

/**
 * POST /api/chauffeur/:rideId/create-payment
 * Body: { offerId }
 * Creates a manual-capture (authorize-now) PaymentIntent for the chosen offer's
 * price so the rider can authorize via PaymentSheet. Captured on completion.
 */
exports.createRidePayment = async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ success: false, message: 'Payments unavailable.' });
    const { rideId } = req.params;
    const { offerId } = req.body;

    const ride = await Ride.findById(rideId).populate('rider');
    if (!ride) return res.status(404).json({ success: false, message: 'Ride not found.' });
    const offer = ride.offers.id(offerId);
    if (!offer) return res.status(404).json({ success: false, message: 'Offer not found.' });

    const rider = ride.rider;
    let stripeCustomerId = rider.stripeCustomerId;
    if (!stripeCustomerId) {
      const c = await stripe.customers.create({
        metadata: { userId: String(rider._id), phone: rider.phone || '' },
        name: [rider.firstName, rider.lastName].filter(Boolean).join(' ') || undefined,
        phone: rider.phone || undefined,
      });
      stripeCustomerId = c.id;
      await User.findByIdAndUpdate(rider._id, { stripeCustomerId });
    }

    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: stripeCustomerId },
      { apiVersion: '2024-06-20' }
    );

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(offer.priceCents),
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      customer: stripeCustomerId,
      capture_method: 'manual', // authorize now, capture on completion
      setup_future_usage: 'off_session',
      metadata: { rideId: String(ride._id), offerId: String(offerId), riderId: String(rider._id), platform: 'react-native' },
    });

    return res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      customerId: stripeCustomerId,
      customerEphemeralKeySecret: ephemeralKey.secret,
      amountCents: offer.priceCents,
    });
  } catch (err) {
    console.error('[chauffeur] createRidePayment error:', err);
    return res.status(500).json({ success: false, message: 'Failed to start payment.' });
  }
};

/**
 * GET /api/chauffeur/open-rides
 * Rides currently open for bids. Each includes the suggested bid ANCHOR + floor
 * so the driver app can render the bid control. (Driver side.)
 */
exports.getOpenRides = async (req, res) => {
  try {
    const rides = await Ride.find({ status: 'searching' })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const shaped = rides.map((r) => ({
      _id: r._id,
      pickup: r.pickup,
      dropoff: r.dropoff,
      distanceMiles: r.distanceMiles,
      durationMinutes: r.durationMinutes,
      suggestedCents: r.pricing?.suggestedCents,
      floorCents: r.pricing?.floorCents,
      offerCount: (r.offers || []).filter((o) => o.status === 'offered').length,
      createdAt: r.createdAt,
    }));
    return res.json({ success: true, rides: shaped });
  } catch (err) {
    console.error('[chauffeur] getOpenRides error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load open rides.' });
  }
};

/**
 * POST /api/chauffeur/:rideId/status
 * Body: { status, driverId }
 * Driver advances the ride: en_route -> arrived -> in_trip -> completed.
 * On 'completed', captures the authorized payment.
 */
exports.updateRideStatus = async (req, res) => {
  try {
    const { rideId } = req.params;
    const { status, driverId } = req.body;
    const allowed = ['en_route', 'arrived', 'in_trip', 'completed', 'cancelled'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status.' });
    }
    const ride = await Ride.findById(rideId);
    if (!ride) return res.status(404).json({ success: false, message: 'Ride not found.' });
    if (driverId && ride.chauffeur && String(ride.chauffeur) !== String(driverId)) {
      return res.status(403).json({ success: false, message: 'Not your ride.' });
    }

    ride.status = status;
    if (status === 'completed') {
      ride.completedAt = new Date();
      if (stripe && ride.paymentIntentId && ride.paymentStatus === 'authorized') {
        try {
          await stripe.paymentIntents.capture(ride.paymentIntentId);
          ride.paymentStatus = 'captured';
        } catch (e) {
          console.error('[chauffeur] capture failed:', e.message);
        }
      }
    }
    if (status === 'cancelled') ride.cancelledAt = new Date();
    await ride.save();

    try {
      if (req.io) {
        req.io.to(String(ride.rider)).emit('rideUpdated', ride);
        if (ride.chauffeur) req.io.to(String(ride.chauffeur)).emit('rideUpdated', ride);
      }
    } catch (e) { /* non-blocking */ }

    return res.json({ success: true, ride });
  } catch (err) {
    console.error('[chauffeur] updateRideStatus error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update ride.' });
  }
};

/**
 * POST /api/chauffeur/subscription
 * Body: { driverId, active }
 * Toggles the driver's software-fee subscription. When active, the pricing
 * engine charges $0/ride (resolveFeeMode).
 */
exports.setSubscription = async (req, res) => {
  try {
    const { driverId, active } = req.body;
    const user = await User.findByIdAndUpdate(
      driverId,
      { 'chauffeurSubscription.active': !!active, 'chauffeurSubscription.plan': active ? 'monthly' : undefined },
      { new: true }
    );
    if (!user) return res.status(404).json({ success: false, message: 'Driver not found.' });
    return res.json({ success: true, chauffeurSubscription: user.chauffeurSubscription });
  } catch (err) {
    console.error('[chauffeur] setSubscription error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update subscription.' });
  }
};

/**
 * POST /api/chauffeur/:rideId/driver-location
 * Body: { lat, lng, driverId }
 * Driver pushes live location during an active ride; relayed to the rider.
 */
exports.updateDriverLocation = async (req, res) => {
  try {
    const { rideId } = req.params;
    const { lat, lng } = req.body;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ success: false, message: 'lat/lng required.' });
    }
    const ride = await Ride.findByIdAndUpdate(
      rideId,
      { driverLocation: { lat, lng, updatedAt: new Date() } },
      { new: true }
    );
    if (!ride) return res.status(404).json({ success: false, message: 'Ride not found.' });

    try {
      if (req.io) {
        req.io.to(String(ride.rider)).emit('rideDriverLocation', { rideId: ride._id, lat, lng });
      }
    } catch (e) { /* non-blocking */ }

    return res.json({ success: true });
  } catch (err) {
    console.error('[chauffeur] updateDriverLocation error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update location.' });
  }
};

/**
 * POST /api/chauffeur/:rideId/simulate-offers   (DEV ONLY)
 * Injects fake driver bids so the rider flow is demoable before the driver app
 * exists. Bids spread between the floor and ~1.1x the suggested anchor, with
 * varied ETAs. Disabled in production.
 */
exports.simulateOffers = async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ success: false, message: 'Disabled in production.' });
    }
    const ride = await Ride.findById(req.params.rideId);
    if (!ride) return res.status(404).json({ success: false, message: 'Ride not found.' });
    if (ride.status !== 'searching') {
      return res.status(409).json({ success: false, message: 'Ride not open for bids.' });
    }

    const floor = ride.pricing?.floorCents ?? 0;
    const anchor = ride.pricing?.suggestedCents ?? floor;
    const names = ['Marcus', 'Priya', 'Diego', 'Aisha', 'Sam'];
    const n = 3 + Math.floor(Math.random() * 2); // 3-4 bids

    for (let i = 0; i < n; i++) {
      const spread = floor + Math.random() * (anchor * 1.1 - floor);
      ride.offers.push({
        chauffeurName: names[i % names.length],
        priceCents: Math.max(floor, Math.round(spread)),
        etaMinutes: 2 + Math.floor(Math.random() * 11), // 2-12 min
        distanceMeters: 300 + Math.floor(Math.random() * 3000),
        status: 'offered',
      });
    }
    await ride.save();
    return res.json({ success: true, count: n });
  } catch (err) {
    console.error('[chauffeur] simulateOffers error:', err);
    return res.status(500).json({ success: false, message: 'Failed to simulate offers.' });
  }
};
