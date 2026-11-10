'use strict';

/** Stock transfers between branches: draft -> in transit (stock leaves) -> received (stock arrives). */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/respond');
const { requireFields, nonEmptyArray, positive } = require('../utils/validate');
const { run, pageParams, toBool } = require('../utils/context');
const { audit } = require('../utils/audit');
const { StockTransfer } = require('../models');
const InventoryService = require('../services/InventoryService');

// GET /transfers?status=&branch_id=
exports.list = asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const result = await run(req, (db) =>
    StockTransfer.list(db, { status: req.query.status, branch_id: req.query.branch_id, page, limit })
  );
  return paginated(res, result);
});

// GET /transfers/:id
exports.get = asyncHandler(async (req, res) => {
  const transfer = await run(req, (db) => StockTransfer.getWithItems(db, req.params.id));
  if (!transfer) throw ApiError.notFound('Transfer not found');
  return ok(res, transfer);
});

// POST /transfers  { from_branch_id, to_branch_id, notes, items: [{ variant_id, quantity, batch_id }], send?: true }
exports.create = asyncHandler(async (req, res) => {
  requireFields(req.body, ['from_branch_id', 'to_branch_id']);
  const items = nonEmptyArray(req.body.items, 'items');
  if (req.body.from_branch_id === req.body.to_branch_id) {
    throw ApiError.unprocessable('Pick two different branches');
  }
  for (const item of items) {
    requireFields(item, ['variant_id']);
    positive(item.quantity ?? item.quantity_sent, 'item quantity');
  }

  const transfer = await run(req, async (db) => {
    const record = await StockTransfer.createWithItems(
      db,
      {
        from_branch_id: req.body.from_branch_id,
        to_branch_id: req.body.to_branch_id,
        notes: req.body.notes || null,
        created_by: req.user.id,
      },
      items
    );
    if (toBool(req.body.send) === true) await InventoryService.sendTransfer(db, req.user, record.id);
    await audit(db, req, 'transfer.create', 'stock_transfer', record.id, { number: record.transfer_number });
    return StockTransfer.getWithItems(db, record.id);
  });
  return created(res, transfer);
});

// POST /transfers/:id/send   stock leaves the source branch
exports.send = asyncHandler(async (req, res) => {
  const transfer = await run(req, async (db) => {
    await InventoryService.sendTransfer(db, req.user, req.params.id);
    await audit(db, req, 'transfer.send', 'stock_transfer', req.params.id, null);
    return StockTransfer.getWithItems(db, req.params.id);
  });
  return ok(res, transfer);
});

// POST /transfers/:id/receive  { items?: [{ item_id, quantity_received }] }  default: everything sent
exports.receive = asyncHandler(async (req, res) => {
  const transfer = await run(req, async (db) => {
    await InventoryService.receiveTransfer(db, req.user, req.params.id, req.body.items);
    await audit(db, req, 'transfer.receive', 'stock_transfer', req.params.id, { items: req.body.items || 'all' });
    return StockTransfer.getWithItems(db, req.params.id);
  });
  return ok(res, transfer);
});

// POST /transfers/:id/cancel  (stock already sent goes back to the source branch)
exports.cancel = asyncHandler(async (req, res) => {
  const transfer = await run(req, async (db) => {
    await InventoryService.cancelTransfer(db, req.user, req.params.id);
    await audit(db, req, 'transfer.cancel', 'stock_transfer', req.params.id, null);
    return StockTransfer.getWithItems(db, req.params.id);
  });
  return ok(res, transfer);
});
