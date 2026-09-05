const express = require('express');
const router = express.Router();
const custodyController = require('../controllers/custodyController');
const requireSelf = require('../middleware/requireSelf');

/**
 * What a customer can do about a car we are holding.
 *
 * Only one thing, and it is the important one: get the keys back. On the $250
 * and $300 plans the valet keeps them after every park, which is the only way
 * we can move the car before its block is swept without the customer standing
 * at the curb twice per cleaning. That arrangement is only fair if undoing it
 * takes one tap, which is what this route is.
 */
// This one dispatches a valet to walk a customer's car keys to the address on
// file AND answers with the freshly minted order — whose `return_key` OTP is
// the code that releases those keys (models/Order.js:568 strips nothing). It
// read the userId straight out of the body, so any ObjectId bought a stranger
// both the delivery and the code for it.
//
// Both callers are the account holder on a signed-in screen — iOS
// KeyCustody.js:169 and web keys-card.tsx:110 — and both send the token. No
// valet, admin, webhook or unauthenticated page calls it. The custody unit
// tests invoke the controller function directly, so they do not pass through
// this middleware.
router.post('/request-keys', requireSelf((req) => req.body?.userId), custodyController.requestKeys);

// DELIBERATELY UNGATED with requireSelf. Its only caller in any repo is the
// VALET app asking about the CUSTOMER on the job in front of it
// (hooks/useValetOrder.js:259). The valet's uid can never match that
// customer's `firebaseUid`, so requireSelf would 403 every call — and this
// lookup is the fallback that tells the valet the keys stay with him on a
// $250/$300 managed park. A 403 reads as "hand them back", which parks the car
// with its keys upstairs and leaves nobody able to move it before the sweep.
// The right rule here is requireValet(), which is a different decision with a
// different blast radius; raised, not taken, in this pass.
router.get('/mine/:userId', custodyController.getMine);

module.exports = router;
