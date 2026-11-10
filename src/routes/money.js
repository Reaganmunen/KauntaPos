'use strict';

/** Expenses, M-Pesa (configuration and taking payments) and KRA eTIMS. */
const express = require('express');
const { can, canAny, resolveBranch, rateLimit } = require('../middleware');
const { crudRoutes } = require('./guards');
const expenses = require('../controllers/expenseController');
const mpesa = require('../controllers/mpesaController');
const etims = require('../controllers/etimsController');

// ---------- /expenses ----------
const expensesRouter = express.Router();
const expenseRead = canAny('expenses.manage', 'reports.view');
expensesRouter.get('/summary', expenseRead, resolveBranch(), expenses.summary);
expensesRouter.get('/', expenseRead, resolveBranch(), expenses.list);
expensesRouter.post('/', can('expenses.manage'), resolveBranch(), expenses.create);
expensesRouter.patch('/:id', can('expenses.manage'), expenses.update);
expensesRouter.delete('/:id', can('expenses.manage'), expenses.remove);

// ---------- /expense-categories ----------
const expenseCategoriesRouter = express.Router();
crudRoutes(expenseCategoriesRouter, '/', expenses.categories, {
  read: [expenseRead],
  write: [can('expenses.manage')],
});

// ---------- /mpesa ----------
const mpesaRouter = express.Router();

// configuration (the shop's own Daraja credentials)
mpesaRouter.get('/configs', can('mpesa.manage'), mpesa.listConfigs);
mpesaRouter.post('/configs', can('mpesa.manage'), mpesa.createConfig);
mpesaRouter.patch('/configs/:id', can('mpesa.manage'), mpesa.updateConfig);
mpesaRouter.post('/configs/:id/deactivate', can('mpesa.manage'), mpesa.deactivateConfig);
mpesaRouter.post('/configs/:id/test', can('mpesa.manage'), mpesa.testConfig);
mpesaRouter.post('/configs/:id/register-c2b', can('mpesa.manage'), mpesa.registerC2b);

// taking payments at the till (limited per signed-in user, not per IP: a shop shares one address)
const takesPayments = canAny('pos.sell', 'orders.online', 'mpesa.manage');
mpesaRouter.post('/stk-push', can('pos.sell'), rateLimit.posStk, resolveBranch(), mpesa.stkPush);
mpesaRouter.get('/unmatched', takesPayments, mpesa.unmatched);
mpesaRouter.get('/transactions', canAny('mpesa.manage', 'reports.view'), mpesa.listTransactions);
mpesaRouter.get('/transactions/:id', takesPayments, mpesa.transactionStatus);
mpesaRouter.post('/transactions/:id/claim', takesPayments, mpesa.claim);
mpesaRouter.get('/sales/:saleId/transactions', takesPayments, mpesa.forSale);

// ---------- /etims ----------
const etimsRouter = express.Router();
const etimsRead = canAny('etims.manage', 'reports.view');
etimsRouter.get('/config', can('etims.manage'), etims.getConfig);
etimsRouter.put('/config', can('etims.manage'), etims.saveConfig);
etimsRouter.post('/verify', can('etims.manage'), etims.verify);
etimsRouter.get('/status', etimsRead, etims.statusCounts);
etimsRouter.get('/invoices', etimsRead, etims.listInvoices);
etimsRouter.get('/invoices/:id', etimsRead, etims.getInvoice);
etimsRouter.post('/invoices/:id/retry', can('etims.manage'), etims.retry);
etimsRouter.post('/invoices/:id/submit', can('etims.manage'), etims.submitNow);
etimsRouter.post('/retry-all', can('etims.manage'), etims.retryAll);
etimsRouter.post('/sync-items', can('etims.manage'), etims.syncItems);

module.exports = { expensesRouter, expenseCategoriesRouter, mpesaRouter, etimsRouter };
