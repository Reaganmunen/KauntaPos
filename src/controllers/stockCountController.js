'use strict';

/** Stocktakes: start (snapshot) -> enter counted quantities -> complete (adjustments booked). */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/respond');
const { nonEmptyArray, requireFields } = require('../utils/validate');
const { run, branchId, pageParams, toBool } = require('../utils/context');
const { audit } = require('../utils/audit');
const { StockCount } = require('../models');
const InventoryService = require('../services/InventoryService');

// GET /stock-counts?branch_id=&status=
exports.list = asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const filters = {};
  if (req.query.branch_id) filters.branch_id = req.query.branch_id;
  if (req.query.status) filters.status = req.query.status;
  const result = await run(req, (db) => StockCount.paginate(db, { filters, page, limit }));
  return paginated(res, result);
});

// GET /stock-counts/:id?only_counted=true
exports.get = asyncHandler(async (req, res) => {
  const data = await run(req, async (db) => {
    const count = await StockCount.findById(db, req.params.id);
    if (!count) return null;
    const items = await StockCount.getItems(db, count.id, { onlyCounted: toBool(req.query.only_counted) === true });
    return { ...count, items };
  });
  if (!data) throw ApiError.notFound('Stock count not found');
  return ok(res, data);
});

// POST /stock-counts  { notes }   counts the branch in X-Branch-Id
exports.start = asyncHandler(async (req, res) => {
  const branch = branchId(req);
  const count = await run(req, async (db) => {
    const record = await StockCount.start(db, { branch_id: branch, started_by: req.user.id, notes: req.body.notes });
    await audit(db, req, 'stock_count.start', 'stock_count', record.id, { number: record.count_number });
    return record;
  });
  return created(res, count);
});

// PUT /stock-counts/:id/items  { items: [{ variant_id, counted_qty, note }] }
exports.recordCounts = asyncHandler(async (req, res) => {
  const items = nonEmptyArray(req.body.items, 'items');
  for (const item of items) {
    requireFields(item, ['variant_id', 'counted_qty']);
    if (!Number.isFinite(Number(item.counted_qty)) || Number(item.counted_qty) < 0) {
      throw ApiError.unprocessable('counted_qty must be 0 or more');
    }
  }
  const saved = await run(req, async (db) => {
    const count = await StockCount.findById(db, req.params.id);
    if (!count) throw ApiError.notFound('Stock count not found');
    if (count.status !== 'open') throw ApiError.conflict('This count is already closed');
    const out = [];
    for (const item of items) {
      out.push(await StockCount.recordCount(db, count.id, item.variant_id, Number(item.counted_qty), item.note));
    }
    return out;
  });
  return ok(res, saved);
});

// GET /stock-counts/:id/variances   counted items that differ from the system quantity
exports.variances = asyncHandler(async (req, res) => {
  const rows = await run(req, (db) => StockCount.variances(db, req.params.id));
  return ok(res, rows);
});

// POST /stock-counts/:id/complete   books an adjustment for every difference
exports.complete = asyncHandler(async (req, res) => {
  const result = await run(req, async (db) => {
    const outcome = await InventoryService.completeCount(db, req.user, req.params.id);
    await audit(db, req, 'stock_count.complete', 'stock_count', req.params.id, {
      adjusted: outcome.adjusted,
    });
    return outcome;
  });
  return ok(res, result);
});

// POST /stock-counts/:id/cancel
exports.cancel = asyncHandler(async (req, res) => {
  const count = await run(req, async (db) => {
    const record = await StockCount.cancel(db, req.params.id);
    if (!record) throw ApiError.conflict('Only an open count can be cancelled');
    await audit(db, req, 'stock_count.cancel', 'stock_count', record.id, null);
    return record;
  });
  return ok(res, count);
});
