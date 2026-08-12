const express = require('express');
const router = express.Router();
const {
  getQuote,
  requestRide,
  submitBid,
  getOffers,
  selectOffer,
  simulateOffers,
  createRidePayment,
  getOpenRides,
  updateRideStatus,
  updateDriverLocation,
  setSubscription,
} = require('../controllers/chauffeurController');

// Rider side.
router.post('/quote', getQuote);            // driver bid anchor / internal
router.post('/request', requestRide);       // rider sends a request to drivers
router.get('/open-rides', getOpenRides);    // driver side: rides open for bids
router.post('/subscription', setSubscription); // driver per-ride-fee subscription toggle

// Reverse auction.
router.post('/:rideId/bid', submitBid);                  // driver bids
router.get('/:rideId/offers', getOffers);                // rider polls for bids
router.post('/:rideId/create-payment', createRidePayment); // rider authorizes payment
router.post('/:rideId/select', selectOffer);             // rider picks a driver
router.post('/:rideId/simulate-offers', simulateOffers); // DEV only

// Trip lifecycle (driver).
router.post('/:rideId/status', updateRideStatus);
router.post('/:rideId/driver-location', updateDriverLocation);

module.exports = router;
