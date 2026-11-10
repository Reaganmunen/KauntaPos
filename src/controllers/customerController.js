'use strict';

/**
 * Customers and their credit ("deni") accounts. The balance is never written directly:
 * every change is a customer_ledger entry and a database trigger updates the balance.
 */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/respond');
const { requireFields, positive, oneOf } = require('../utils/validate');
const { run, pageParams, toBool } = require('../utils/context');
const { audit } = require('../utils/audit');
const { Customer, CustomerLedger } = require('../models');

// GET /customers?q=&only_owing=true
exports.list = asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const result = await run(req, (db) =>
    Customer.search(db, { q: req.query.q, only_owing: toBool(req.query.only_owing) === true, page, limit })
  );
  return paginated(res, result);
});

// GET /customers/:id
exports.get = asyncHandler(async (req, res) => {
  const customer = await run(req, (db) => Customer.findById(db, req.params.id));
  if (!customer) throw ApiError.notFound('Customer not found');
  return ok(res, customer);
});

// GET /customers/lookup?phone=07...   quick find at the till
exports.lookupByPhone = asyncHandler(async (req, res) => {
  requireFields(req.query, ['phone']);
  const customer = await run(req, (db) => Customer.findByPhone(db, String(req.query.phone).trim()));
  return ok(res, customer);
});

// POST /customers  { name, phone, email, kra_pin, address, price_list_id, credit_limit, notes }
exports.create = asyncHandler(async (req, res) => {
  requireFields(req.body, ['name']);
  const customer = await run(req, async (db) => {
    const record = await Customer.create(db, req.body);
    await audit(db, req, 'customer.create', 'customer', record.id, { name: record.name });
    return record;
  });
  return created(res, customer);
});

// PATCH /customers/:id
exports.update = asyncHandler(async (req, res) => {
  const customer = await run(req, async (db) => {
    const record = await Customer.update(db, req.params.id, req.body);
    if (!record) throw ApiError.notFound('Customer not found');
    await audit(db, req, 'customer.update', 'customer', record.id, { after: req.body });
    return record;
  });
  return ok(res, customer);
});

// DELETE /customers/:id  (soft delete)
exports.remove = asyncHandler(async (req, res) => {
  await run(req, async (db) => {
    const record = await Customer.remove(db, req.params.id);
    if (!record) throw ApiError.notFound('Customer not found');
    await audit(db, req, 'customer.delete', 'customer', record.id, { name: record.name });
  });
  return ok(res, { deleted: true });
});

// GET /customers/:id/statement
exports.statement = asyncHandler(async (req, res) => {
  const data = await run(req, async (db) => {
    const customer = await Customer.findById(db, req.params.id);
    if (!customer) throw ApiError.notFound('Customer not found');
    const entries = await CustomerLedger.statement(db, customer.id, {
      limit: Math.min(parseInt(req.query.limit, 10) || 200, 1000),
    });
    return { customer, balance: customer.balance, entries };
  });
  return ok(res, data);
});

// POST /customers/:id/payments  { amount, method, reference, note }
// The customer pays off some or all of what they owe.
exports.receivePayment = asyncHandler(async (req, res) => {
  requireFields(req.body, ['amount']);
  const amount = positive(req.body.amount, 'amount');
  const method = req.body.method ? oneOf(req.body.method, ['cash', 'mpesa', 'card', 'bank_transfer', 'other'], 'method') : 'cash';

  const result = await run(req, async (db) => {
    const customer = await Customer.findById(db, req.params.id);
    if (!customer) throw ApiError.notFound('Customer not found');
    if (amount > Number(customer.balance)) {
      throw ApiError.unprocessable(`This customer only owes ${customer.balance}. The payment is higher than that.`);
    }
    const entry = await CustomerLedger.recordPayment(db, {
      customer_id: customer.id,
      amount,
      created_by: req.user.id,
      note: [method, req.body.reference, req.body.note].filter(Boolean).join(' | '),
    });
    await audit(db, req, 'customer.payment', 'customer', customer.id, { amount, method });
    return { entry, balance: Number(customer.balance) - amount };
  });
  return created(res, result);
});

// POST /customers/:id/adjustments  { amount (+ owes more / - owes less), note }
exports.adjust = asyncHandler(async (req, res) => {
  requireFields(req.body, ['amount', 'note']);
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount === 0) throw ApiError.unprocessable('amount must be a non-zero number');

  const entry = await run(req, async (db) => {
    const customer = await Customer.findById(db, req.params.id);
    if (!customer) throw ApiError.notFound('Customer not found');
    const record = await CustomerLedger.recordAdjustment(db, {
      customer_id: customer.id,
      amount,
      created_by: req.user.id,
      note: req.body.note,
    });
    await audit(db, req, 'customer.adjustment', 'customer', customer.id, { amount, note: req.body.note });
    return record;
  });
  return created(res, entry);
});

// GET /customers/owing/total
exports.totalOwed = asyncHandler(async (req, res) => {
  const total = await run(req, (db) => Customer.totalOwed(db));
  return ok(res, { total });
});
