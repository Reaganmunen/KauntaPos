'use strict';

/** Reports and the audit trail. */
const express = require('express');
const { can, canAny, resolveBranch } = require('../middleware');
const reports = require('../controllers/reportController');
const audit = require('../controllers/auditController');

// ---------- /reports ----------
const reportsRouter = express.Router();
const view = can('reports.view');

// the Z-report is also printed by the cashier closing the till
reportsRouter.get('/end-of-day', canAny('reports.view', 'pos.shift'), resolveBranch({ required: true }), reports.endOfDay);

reportsRouter.get('/dashboard', view, resolveBranch(), reports.dashboard);
reportsRouter.get('/sales', view, resolveBranch(), reports.sales);
reportsRouter.get('/top-products', view, resolveBranch(), reports.topProducts);
reportsRouter.get('/by-category', view, resolveBranch(), reports.byCategory);
reportsRouter.get('/payment-methods', view, resolveBranch(), reports.byPaymentMethod);
reportsRouter.get('/profit', view, resolveBranch(), reports.profit);
reportsRouter.get('/vat', view, resolveBranch(), reports.vat);
reportsRouter.get('/cashiers', view, resolveBranch(), reports.cashiers);
reportsRouter.get('/expenses', view, resolveBranch(), reports.expenses);
reportsRouter.get('/stock-value', view, resolveBranch(), reports.stockValue);

// ---------- /audit ----------
const auditRouter = express.Router();
auditRouter.use(can('audit.view'));
auditRouter.get('/', audit.list);
auditRouter.get('/:entityType/:entityId', audit.history);

module.exports = { reportsRouter, auditRouter };
