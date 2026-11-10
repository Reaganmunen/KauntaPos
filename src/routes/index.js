'use strict';

/**
 * Every route in the API, in one router. app.js mounts it at API_PREFIX (default /api).
 *
 *   Public (no login)           /health  /hooks/pay  /store  /auth (login, signup, recovery)
 *   Kaunta staff panel          /platform            (own token, secret and audience)
 *   Shop staff (login needed)   everything after `secured` below
 *
 * Shop-staff requests all pass through the same four steps before any route runs:
 *   rate limit -> which shop (host) -> who is calling (token) -> is the subscription OK
 * and then each route adds its own permission check (can / canAny) and, where it works on a
 * branch, resolveBranch.
 *
 * Route order matters inside each file: fixed paths such as /products/low-stock are declared
 * BEFORE /products/:id so they are not mistaken for an id.
 */
const express = require('express');
const { query } = require('../config/database');
const { rateLimit, resolveTenant, authenticate, requireActiveSubscription } = require('../middleware');

const router = express.Router();

// ---------- public ----------

router.get('/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ success: true, data: { status: 'ok' } });
  } catch (err) {
    res.status(503).json({ success: false, error: { message: 'Database unavailable', code: 'unavailable', request_id: req.id } });
  }
});

router.use('/hooks/pay', require('./webhooks'));
router.use('/store', require('./publicStore'));
router.use('/auth', require('./auth'));
router.use('/platform', require('./platform'));

// ---------- shop staff ----------

const secured = [rateLimit.api, resolveTenant(), authenticate, requireActiveSubscription];
router.use(...secured);

const team = require('./team');
const catalog = require('./catalog');
const people = require('./people');
const stock = require('./inventory');
const till = require('./sales');
const money = require('./money');
const online = require('./storefront');
const insight = require('./reports');

router.use('/tenant', require('./tenant'));

router.use('/users', team.usersRouter);
router.use('/roles', team.rolesRouter);
router.use('/branches', team.branchesRouter);
router.use('/terminals', team.terminalsRouter);

router.use('/categories', catalog.categoriesRouter);
router.use('/brands', catalog.brandsRouter);
router.use('/units', catalog.unitsRouter);
router.use('/tax-classes', catalog.taxRouter);
router.use('/price-lists', catalog.priceListsRouter);
router.use('/products', catalog.productsRouter);

router.use('/customers', people.customersRouter);
router.use('/suppliers', people.suppliersRouter);

router.use('/inventory', stock.inventoryRouter);
router.use('/stock-counts', stock.countsRouter);
router.use('/transfers', stock.transfersRouter);
router.use('/purchases', stock.purchasesRouter);
router.use('/pharmacy', stock.pharmacyRouter);

router.use('/sales', till.salesRouter);
router.use('/shifts', till.shiftsRouter);
router.use('/sync', till.syncRouter);

router.use('/expenses', money.expensesRouter);
router.use('/expense-categories', money.expenseCategoriesRouter);
router.use('/mpesa', money.mpesaRouter);
router.use('/etims', money.etimsRouter);

router.use('/restaurant', require('./restaurant'));

router.use('/storefront', online.storefrontRouter);
router.use('/online-orders', online.ordersRouter);

router.use('/reports', insight.reportsRouter);
router.use('/audit', insight.auditRouter);

module.exports = router;
