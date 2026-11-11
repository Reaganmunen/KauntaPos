'use strict';

/** Purchase orders: draft -> ordered -> received (stock booked in) and supplier payments. */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/respond');
const { requireFields, nonEmptyArray, positive } = require('../utils/validate');
const { run, listBranch, pageParams } = require('../utils/context');
const { audit } = require('../utils/audit');
const { PurchaseOrder } = require('../models');
const InventoryService = require('../services/InventoryService');

// GET /purchases?status=&supplier_id=&branch_id=
exports.list = asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const result = await run(req, (db) =>
    PurchaseOrder.list(db, {
      status: req.query.status,
      supplier_id: req.query.supplier_id,
      branch_id: listBranch(req),
      page,
      limit,
    })
  );
  return paginated(res, result);
});

// GET /purchases/:id
exports.get = asyncHandler(async (req, res) => {
  const order = await run(req, (db) => PurchaseOrder.getWithItems(db, req.params.id));
  if (!order) throw ApiError.notFound('Purchase order not found');
  return ok(res, order);
});

// POST /purchases
// { supplier_id, branch_id, expected_date, supplier_invoice_no, notes, status: 'draft'|'ordered',
//   items: [{ variant_id, quantity_ordered, unit_cost, tax_rate, batch_no, expiry_date }] }
exports.create = asyncHandler(async (req, res) => {
  requireFields(req.body, ['supplier_id', 'branch_id']);
  const items = nonEmptyArray(req.body.items, 'items');
  for (const item of items) {
    requireFields(item, ['variant_id', 'unit_cost']);
    positive(item.quantity_ordered ?? item.quantity, 'item quantity');
  }

  const order = await run(req, async (db) => {
    const record = await PurchaseOrder.createWithItems(
      db,
      {
        supplier_id: req.body.supplier_id,
        branch_id: req.body.branch_id,
        expected_date: req.body.expected_date || null,
        supplier_invoice_no: req.body.supplier_invoice_no || null,
        notes: req.body.notes || null,
        status: req.body.status === 'ordered' ? 'ordered' : 'draft',
        created_by: req.user.id,
      },
      items
    );
    await audit(db, req, 'purchase.create', 'purchase_order', record.id, { number: record.po_number, total: record.total });
    return PurchaseOrder.getWithItems(db, record.id);
  });
  return created(res, order);
});

// POST /purchases/:id/order   draft -> ordered
exports.markOrdered = asyncHandler(async (req, res) => {
  const order = await run(req, async (db) => {
    const existing = await PurchaseOrder.findById(db, req.params.id);
    if (!existing) throw ApiError.notFound('Purchase order not found');
    if (existing.status !== 'draft') throw ApiError.conflict('Only a draft order can be marked as ordered');
    const record = await PurchaseOrder.update(db, existing.id, { status: 'ordered' });
    await audit(db, req, 'purchase.ordered', 'purchase_order', existing.id, null);
    return record;
  });
  return ok(res, order);
});

// POST /purchases/:id/receive  { receipts?: [{ item_id, quantity, batch_no, expiry_date }] }
// With no receipts, everything still outstanding is received. Stock is booked into the order's branch.
exports.receive = asyncHandler(async (req, res) => {
  const order = await run(req, async (db) => {
    await InventoryService.receivePurchase(db, req.user, req.params.id, req.body.receipts);
    await audit(db, req, 'purchase.receive', 'purchase_order', req.params.id, { receipts: req.body.receipts || 'all' });
    return PurchaseOrder.getWithItems(db, req.params.id);
  });
  return ok(res, order);
});

// POST /purchases/:id/payments  { amount }
exports.pay = asyncHandler(async (req, res) => {
  requireFields(req.body, ['amount']);
  const amount = positive(req.body.amount, 'amount');
  const order = await run(req, async (db) => {
    const existing = await PurchaseOrder.findById(db, req.params.id);
    if (!existing) throw ApiError.notFound('Purchase order not found');
    if (existing.status === 'cancelled') throw ApiError.conflict('This order was cancelled');
    const owed = Number(existing.total) - Number(existing.amount_paid);
    if (amount > owed + 0.001) throw ApiError.unprocessable(`Only ${owed.toFixed(2)} is still owed on this order`);
    const record = await PurchaseOrder.recordPayment(db, existing.id, amount);
    await audit(db, req, 'purchase.payment', 'purchase_order', existing.id, { amount });
    return record;
  });
  return ok(res, order);
});

// POST /purchases/:id/cancel   (draft or ordered only)
exports.cancel = asyncHandler(async (req, res) => {
  const order = await run(req, async (db) => {
    const record = await PurchaseOrder.cancel(db, req.params.id);
    if (!record) throw ApiError.conflict('Only a draft or ordered purchase order can be cancelled');
    await audit(db, req, 'purchase.cancel', 'purchase_order', record.id, null);
    return record;
  });
  return ok(res, order);
});
