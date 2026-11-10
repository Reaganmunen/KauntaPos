'use strict';

/**
 * Stock levels, movements, adjustments and batches. Quantities only ever change through
 * stock movements recorded by InventoryService (the database keeps stock_levels in sync).
 */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/respond');
const { requireFields, oneOf, positive } = require('../utils/validate');
const { run, branchId, pageParams, toBool } = require('../utils/context');
const { audit } = require('../utils/audit');
const { StockLevel, StockMovement, StockBatch, Branch } = require('../models');
const InventoryService = require('../services/InventoryService');

// GET /inventory?q=&low_only=true     (branch from X-Branch-Id / branch_id)
exports.levels = asyncHandler(async (req, res) => {
  const branch = branchId(req);
  const { page, limit } = pageParams(req);
  const result = await run(req, (db) =>
    StockLevel.forBranch(db, branch, {
      q: req.query.q,
      low_only: toBool(req.query.low_only) === true,
      page,
      limit,
    })
  );
  return paginated(res, result);
});

// GET /inventory/availability?variant_ids=a,b,c   on hand / reserved / available
exports.availability = asyncHandler(async (req, res) => {
  requireFields(req.query, ['variant_ids']);
  const ids = String(req.query.variant_ids).split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length > 200) throw ApiError.unprocessable('Ask for at most 200 variants at a time');
  const branch = branchId(req);
  const rows = await run(req, (db) => StockLevel.availability(db, branch, ids));
  return ok(res, rows);
});

// GET /inventory/valuation   stock value at cost and retail (one branch, or every branch + total)
exports.valuation = asyncHandler(async (req, res) => {
  const branch = branchId(req, { required: false });
  const data = await run(req, async (db) => {
    if (branch) return { branches: [{ branch_id: branch, ...(await StockLevel.valuation(db, branch)) }] };

    const branches = await Branch.findAll(db, { filters: { is_active: true } });
    const rows = [];
    for (const b of branches) rows.push({ branch_id: b.id, branch_name: b.name, ...(await StockLevel.valuation(db, b.id)) });
    const total = rows.reduce(
      (acc, r) => ({
        cost_value: acc.cost_value + Number(r.cost_value),
        retail_value: acc.retail_value + Number(r.retail_value),
      }),
      { cost_value: 0, retail_value: 0 }
    );
    return { branches: rows, total };
  });
  return ok(res, data);
});

// GET /inventory/variants/:variantId/movements?branch_id=
exports.movements = asyncHandler(async (req, res) => {
  const branch = branchId(req, { required: false });
  const rows = await run(req, (db) =>
    StockMovement.forVariant(db, req.params.variantId, {
      branchId: branch,
      limit: Math.min(parseInt(req.query.limit, 10) || 100, 500),
    })
  );
  return ok(res, rows);
});

// GET /inventory/variants/:variantId/batches?include_empty=true
exports.batches = asyncHandler(async (req, res) => {
  const branch = branchId(req);
  const rows = await run(req, (db) =>
    StockBatch.forVariant(db, branch, req.params.variantId, { includeEmpty: toBool(req.query.include_empty) === true })
  );
  return ok(res, rows);
});

// POST /inventory/adjust
// { variant_id, type: 'adjustment' | 'damage' | 'expiry', note,
//   quantity_change (+/-)  OR  new_quantity (set the count),
//   batch_id | batch_no + expiry_date (for batch-tracked stock coming in), unit_cost }
exports.adjust = asyncHandler(async (req, res) => {
  requireFields(req.body, ['variant_id', 'note']);
  if (req.body.quantity_change === undefined && req.body.new_quantity === undefined) {
    throw ApiError.unprocessable('Send quantity_change or new_quantity');
  }
  const type = req.body.type ? oneOf(req.body.type, ['adjustment', 'damage', 'expiry'], 'type') : 'adjustment';
  const branch = branchId(req);

  const movement = await run(req, async (db) => {
    const result = await InventoryService.adjust(db, req.user, { ...req.body, type, branch_id: branch });
    await audit(db, req, 'inventory.adjust', 'product_variant', req.body.variant_id, {
      type,
      branch_id: branch,
      quantity_change: req.body.quantity_change,
      new_quantity: req.body.new_quantity,
      note: req.body.note,
    });
    return result;
  });
  return created(res, movement);
});

// POST /inventory/opening-stock  { variant_id, quantity, unit_cost }
exports.openingStock = asyncHandler(async (req, res) => {
  requireFields(req.body, ['variant_id', 'quantity']);
  const quantity = positive(req.body.quantity, 'quantity');
  const branch = branchId(req);

  const movement = await run(req, async (db) => {
    const result = await InventoryService.openingStock(db, req.user, {
      branch_id: branch,
      variant_id: req.body.variant_id,
      quantity,
      unit_cost: req.body.unit_cost,
    });
    await audit(db, req, 'inventory.opening', 'product_variant', req.body.variant_id, { branch_id: branch, quantity });
    return result;
  });
  return created(res, movement);
});
