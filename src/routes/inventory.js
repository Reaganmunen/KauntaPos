'use strict';

/**
 * Stock: levels and adjustments, stocktakes, branch transfers, purchase orders, and the
 * pharmacy extras (expiry, write-off, prescription register).
 * Every route that works on a branch goes through resolveBranch so staff limited to certain
 * branches cannot read or change another branch's stock.
 */
const express = require('express');
const { can, canAny, requireFeature, resolveBranch } = require('../middleware');
const inventory = require('../controllers/inventoryController');
const counts = require('../controllers/stockCountController');
const transfers = require('../controllers/transferController');
const purchases = require('../controllers/purchaseController');
const pharmacy = require('../controllers/pharmacyController');

// ---------- /inventory ----------
const inventoryRouter = express.Router();
inventoryRouter.get('/', can('inventory.view'), resolveBranch({ required: true }), inventory.levels);
inventoryRouter.get('/availability', canAny('inventory.view', 'pos.sell'), resolveBranch({ required: true }), inventory.availability);
inventoryRouter.get('/valuation', canAny('reports.view', 'inventory.adjust'), resolveBranch(), inventory.valuation);
inventoryRouter.get('/variants/:variantId/movements', can('inventory.view'), resolveBranch(), inventory.movements);
inventoryRouter.get('/variants/:variantId/batches', can('inventory.view'), resolveBranch({ required: true }), inventory.batches);
inventoryRouter.post('/adjust', can('inventory.adjust'), resolveBranch({ required: true }), inventory.adjust);
inventoryRouter.post('/opening-stock', can('inventory.adjust'), resolveBranch({ required: true }), inventory.openingStock);

// ---------- /stock-counts ----------
const countsRouter = express.Router();
countsRouter.get('/', can('inventory.view'), resolveBranch(), counts.list);
countsRouter.post('/', can('inventory.adjust'), resolveBranch({ required: true }), counts.start);
countsRouter.get('/:id', can('inventory.view'), counts.get);
countsRouter.put('/:id/items', can('inventory.adjust'), counts.recordCounts);
countsRouter.get('/:id/variances', can('inventory.view'), counts.variances);
countsRouter.post('/:id/complete', can('inventory.adjust'), counts.complete);
countsRouter.post('/:id/cancel', can('inventory.adjust'), counts.cancel);

// ---------- /transfers ----------
// The sending branch must be one the user may use; the receiving branch only has to exist, because
// a branch manager sends stock to branches they do not run.
const transfersRouter = express.Router();
transfersRouter.get('/', canAny('inventory.view', 'inventory.transfer'), resolveBranch(), transfers.list);
transfersRouter.post(
  '/',
  can('inventory.transfer'),
  resolveBranch({ also: ['from_branch_id'], exists: ['to_branch_id'] }),
  transfers.create
);
transfersRouter.get('/:id', canAny('inventory.view', 'inventory.transfer'), transfers.get);
transfersRouter.post('/:id/send', can('inventory.transfer'), transfers.send);
transfersRouter.post('/:id/receive', can('inventory.transfer'), transfers.receive);
transfersRouter.post('/:id/cancel', can('inventory.transfer'), transfers.cancel);

// ---------- /purchases ----------
const purchasesRouter = express.Router();
purchasesRouter.use(can('purchases.manage'));
purchasesRouter.get('/', resolveBranch(), purchases.list);
purchasesRouter.post('/', resolveBranch(), purchases.create);
purchasesRouter.get('/:id', purchases.get);
purchasesRouter.post('/:id/order', purchases.markOrdered);
purchasesRouter.post('/:id/receive', purchases.receive);
purchasesRouter.post('/:id/payments', purchases.pay);
purchasesRouter.post('/:id/cancel', purchases.cancel);

// ---------- /pharmacy ----------
const pharmacyRouter = express.Router();
pharmacyRouter.get(
  '/expiring',
  requireFeature('batch_expiry'),
  canAny('inventory.view', 'pharmacy.dispense'),
  resolveBranch(),
  pharmacy.expiringSoon
);
pharmacyRouter.get(
  '/expired',
  requireFeature('batch_expiry'),
  canAny('inventory.view', 'pharmacy.dispense'),
  resolveBranch(),
  pharmacy.expired
);
pharmacyRouter.post('/write-off', requireFeature('batch_expiry'), can('inventory.adjust'), pharmacy.writeOffExpired);
pharmacyRouter.get(
  '/prescriptions',
  requireFeature('prescriptions'),
  canAny('pharmacy.dispense', 'reports.view'),
  pharmacy.register
);
pharmacyRouter.get(
  '/prescriptions/sale/:saleId',
  requireFeature('prescriptions'),
  canAny('pharmacy.dispense', 'reports.view'),
  pharmacy.forSale
);

module.exports = { inventoryRouter, countsRouter, transfersRouter, purchasesRouter, pharmacyRouter };
