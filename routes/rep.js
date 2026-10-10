const express = require('express');
const router = express.Router();
const requireRep = require('../middleware/requireRep');
const rep = require('../controllers/repController');

// The rep portal (valetnetwork.co/rep). /me and the agreement work before
// signing; everything else needs the signed agreement.
const open = requireRep({ signed: false });
const signed = requireRep();
const adminOnly = requireRep({ adminOnly: true });

router.get('/me', open, rep.me);
router.get('/agreement', open, rep.agreement);
router.post('/agreement/sign', open, rep.sign);
router.get('/agreement/pdf', open, rep.agreementPdf);

router.get('/home', signed, rep.home);
router.get('/unlocks', signed, rep.unlocks);
router.get('/customers', signed, rep.customers);
router.post('/customers', signed, rep.addCustomer);
router.post('/price', signed, rep.price);
router.get('/earnings', signed, rep.earnings);

router.get('/admin/pricing', adminOnly, rep.getPricing);
router.put('/admin/pricing', adminOnly, rep.putPricing);
router.get('/admin/codes', adminOnly, rep.listCodes);
router.post('/admin/codes', adminOnly, rep.createCode);
router.patch('/admin/codes/:id', adminOnly, rep.patchCode);
router.get('/admin/reps', adminOnly, rep.listReps);
router.post('/admin/reps', adminOnly, rep.createRep);
router.post('/admin/payouts', adminOnly, rep.createPayout);
router.get('/admin/unlocks', adminOnly, rep.adminUnlocks);
router.put('/admin/unlocks/:key/note', adminOnly, rep.saveNote);
router.get('/admin/referral-payouts', adminOnly, rep.referralPayouts);
router.post('/admin/referral-payouts', adminOnly, rep.recordReferralPayout);

module.exports = router;
