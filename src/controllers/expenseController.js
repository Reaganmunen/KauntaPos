'use strict';

const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/respond');
const { requireFields, positive } = require('../utils/validate');
const { run, branchId, pageParams } = require('../utils/context');
const { audit } = require('../utils/audit');
const { makeCrud } = require('../utils/crud');
const { Expense, ExpenseCategory } = require('../models');
const ReportService = require('../services/ReportService');

// GET /expenses?branch_id=&category_id=&from=&to=&q=
exports.list = asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const result = await run(req, (db) =>
    Expense.search(db, {
      branch_id: req.query.branch_id,
      category_id: req.query.category_id,
      from: req.query.from,
      to: req.query.to,
      q: req.query.q,
      page,
      limit,
    })
  );
  return paginated(res, result);
});

// POST /expenses  { amount, category_id, expense_date, payment_method, reference, description, supplier_id,
//                   supplier_etims_invoice_no, receipt_url }
exports.create = asyncHandler(async (req, res) => {
  requireFields(req.body, ['amount']);
  const amount = positive(req.body.amount, 'amount');
  const branch = branchId(req, { required: false });

  const expense = await run(req, async (db) => {
    const record = await Expense.create(db, {
      ...req.body,
      amount,
      branch_id: branch,
      created_by: req.user.id,
    });
    await audit(db, req, 'expense.create', 'expense', record.id, { amount });
    return record;
  });
  return created(res, expense);
});

// PATCH /expenses/:id
exports.update = asyncHandler(async (req, res) => {
  const data = { ...req.body };
  delete data.created_by;
  if (data.amount !== undefined) data.amount = positive(data.amount, 'amount');

  const expense = await run(req, async (db) => {
    const record = await Expense.update(db, req.params.id, data);
    if (!record) throw ApiError.notFound('Expense not found');
    await audit(db, req, 'expense.update', 'expense', record.id, { after: data });
    return record;
  });
  return ok(res, expense);
});

// DELETE /expenses/:id
exports.remove = asyncHandler(async (req, res) => {
  await run(req, async (db) => {
    const record = await Expense.remove(db, req.params.id);
    if (!record) throw ApiError.notFound('Expense not found');
    await audit(db, req, 'expense.delete', 'expense', record.id, { amount: record.amount });
  });
  return ok(res, { deleted: true });
});

// GET /expenses/summary?from=&to=&period=month&branch_id=   totals by category
exports.summary = asyncHandler(async (req, res) => {
  const branch = branchId(req, { required: false });
  const data = await run(req, async (db) => {
    const range = await ReportService.resolveRange(db, req.query);
    const categories = await Expense.summaryByCategory(db, { from: range.from, to: range.to, branch_id: branch });
    const total = categories.reduce((sum, c) => sum + Number(c.total), 0);
    return { range, total, categories };
  });
  return ok(res, data);
});

// Expense categories: list / get / create / update / remove
exports.categories = makeCrud(ExpenseCategory, { label: 'Expense category' });
