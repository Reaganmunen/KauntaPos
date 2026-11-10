'use strict';

/**
 * The till: sales, payments on a sale, cashier shifts, and offline sync.
 */
const express = require('express');
const { can, canAny, resolveBranch } = require('../middleware');
const { saleRights, requireFeatureIf } = require('./guards');
const sales = require('../controllers/saleController');
const payments = require('../controllers/paymentController');
const shifts = require('../controllers/shiftController');
const sync = require('../controllers/syncController');

// who may look at sales (the controller further limits plain cashiers to their own)
const salesRead = canAny('pos.sell', 'reports.view', 'orders.online');

// ---------- /sales ----------
const salesRouter = express.Router();

salesRouter.post(
  '/',
  can('pos.sell'),
  resolveBranch({ required: true }),
  saleRights, // discounts need pos.discount, prescriptions need pharmacy.dispense
  requireFeatureIf('restaurant', (req) => Boolean(req.body && (req.body.status === 'open' || req.body.table_id))),
  requireFeatureIf('prescriptions', (req) => Boolean(req.body && req.body.prescription)),
  sales.create
);
salesRouter.get('/', salesRead, resolveBranch(), sales.list);
salesRouter.get('/by-number/:number', salesRead, sales.getByNumber); // before /:id
salesRouter.get('/:id', salesRead, sales.get);
salesRouter.get('/:id/receipt', salesRead, sales.receipt);

salesRouter.post('/:id/items', can('pos.sell'), saleRights, requireFeatureIf('restaurant', () => true), sales.addItems);
salesRouter.post('/:id/void', can('pos.void'), sales.void);
salesRouter.post('/:id/refund', can('pos.refund'), sales.refund);

salesRouter.get('/:id/payments', salesRead, payments.listForSale);
salesRouter.post('/:id/payments', can('pos.sell'), payments.add);

// ---------- /shifts ----------
const shiftsRouter = express.Router();
shiftsRouter.get('/current', can('pos.shift'), shifts.current); // before /:id
shiftsRouter.post('/open', can('pos.shift'), resolveBranch({ required: true }), shifts.open);
shiftsRouter.get('/', canAny('pos.shift', 'reports.view'), resolveBranch(), shifts.list);
shiftsRouter.get('/:id', canAny('pos.shift', 'reports.view'), shifts.get);
shiftsRouter.post('/:id/cash', can('pos.shift'), shifts.cashMovement);
shiftsRouter.post('/:id/close', can('pos.shift'), shifts.close);

// ---------- /sync ----------
// POST /sync/sales is exempt from the subscription gate (see middleware/subscription.js): sales
// made offline have already happened and must always be accepted.
const syncRouter = express.Router();
syncRouter.post('/sales', can('pos.sell'), resolveBranch({ required: true }), sync.pushSales);
syncRouter.get('/catalog', can('pos.sell'), resolveBranch({ required: true }), sync.catalog);

module.exports = { salesRouter, shiftsRouter, syncRouter };
