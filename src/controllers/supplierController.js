'use strict';

const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/respond');
const { requireFields } = require('../utils/validate');
const { run, pageParams, toBool } = require('../utils/context');
const { audit } = require('../utils/audit');
const { Supplier } = require('../models');

// GET /suppliers?q=&is_active=
exports.list = asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const result = await run(req, (db) =>
    Supplier.search(db, { q: req.query.q, is_active: toBool(req.query.is_active), page, limit })
  );
  return paginated(res, result);
});

// GET /suppliers/:id  (includes what we still owe them)
exports.get = asyncHandler(async (req, res) => {
  const supplier = await run(req, async (db) => {
    const found = await Supplier.findById(db, req.params.id);
    if (!found) return null;
    return { ...found, outstanding: await Supplier.outstanding(db, found.id) };
  });
  if (!supplier) throw ApiError.notFound('Supplier not found');
  return ok(res, supplier);
});

// POST /suppliers
exports.create = asyncHandler(async (req, res) => {
  requireFields(req.body, ['name']);
  const supplier = await run(req, async (db) => {
    const record = await Supplier.create(db, req.body);
    await audit(db, req, 'supplier.create', 'supplier', record.id, { name: record.name });
    return record;
  });
  return created(res, supplier);
});

// PATCH /suppliers/:id
exports.update = asyncHandler(async (req, res) => {
  const supplier = await run(req, async (db) => {
    const record = await Supplier.update(db, req.params.id, req.body);
    if (!record) throw ApiError.notFound('Supplier not found');
    await audit(db, req, 'supplier.update', 'supplier', record.id, { after: req.body });
    return record;
  });
  return ok(res, supplier);
});

// DELETE /suppliers/:id  (suppliers with purchase history are deactivated instead of deleted)
exports.remove = asyncHandler(async (req, res) => {
  const result = await run(req, async (db) => {
    const found = await Supplier.findById(db, req.params.id);
    if (!found) throw ApiError.notFound('Supplier not found');

    const { rows } = await db.query(
      `SELECT (SELECT COUNT(*) FROM purchase_orders WHERE supplier_id = $1)
            + (SELECT COUNT(*) FROM expenses WHERE supplier_id = $1) AS uses`,
      [found.id]
    );
    if (Number(rows[0].uses) > 0) {
      await Supplier.update(db, found.id, { is_active: false });
      await audit(db, req, 'supplier.deactivate', 'supplier', found.id, null);
      return { deleted: false, deactivated: true };
    }
    await Supplier.remove(db, found.id);
    await audit(db, req, 'supplier.delete', 'supplier', found.id, { name: found.name });
    return { deleted: true };
  });
  return ok(res, result);
});
