'use strict';

/** Customers (and their credit accounts) and suppliers. */
const express = require('express');
const { can, canAny } = require('../middleware');
const { stripUnless } = require('./guards');
const customers = require('../controllers/customerController');
const suppliers = require('../controllers/supplierController');

// ---------- /customers ----------
const customersRouter = express.Router();
const atTill = canAny('customers.manage', 'pos.sell');
const manage = can('customers.manage');

// fixed paths first
customersRouter.get('/lookup', atTill, customers.lookupByPhone);
customersRouter.get('/owing/total', canAny('customers.manage', 'reports.view'), customers.totalOwed);

customersRouter.get('/', atTill, customers.list);
// a cashier may add a customer at the till, but not decide their credit limit or price list
customersRouter.post('/', atTill, stripUnless(['credit_limit', 'price_list_id'], 'customers.manage'), customers.create);
customersRouter.get('/:id', atTill, customers.get);
customersRouter.patch('/:id', manage, customers.update);
customersRouter.delete('/:id', manage, customers.remove);

customersRouter.get('/:id/statement', canAny('customers.manage', 'reports.view'), customers.statement);
customersRouter.post('/:id/payments', atTill, customers.receivePayment);
customersRouter.post('/:id/adjustments', manage, customers.adjust);

// ---------- /suppliers ----------
const suppliersRouter = express.Router();
suppliersRouter.get('/', canAny('suppliers.manage', 'purchases.manage'), suppliers.list);
suppliersRouter.post('/', can('suppliers.manage'), suppliers.create);
suppliersRouter.get('/:id', canAny('suppliers.manage', 'purchases.manage'), suppliers.get);
suppliersRouter.patch('/:id', can('suppliers.manage'), suppliers.update);
suppliersRouter.delete('/:id', can('suppliers.manage'), suppliers.remove);

module.exports = { customersRouter, suppliersRouter };
