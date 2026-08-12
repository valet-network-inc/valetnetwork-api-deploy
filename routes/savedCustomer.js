const express = require('express');
const router = express.Router();
const savedCustomerController = require('../controllers/savedCustomerController');

router.get('/', savedCustomerController.listSavedCustomers);
router.post('/', savedCustomerController.createSavedCustomer);
router.patch('/:id', savedCustomerController.updateSavedCustomer);
router.delete('/:id', savedCustomerController.deleteSavedCustomer);

module.exports = router;
