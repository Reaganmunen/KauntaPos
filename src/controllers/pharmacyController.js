'use strict';

/** Pharmacy extras: expiry watch-list, expired stock write-off and the dispensing register. */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, paginated } = require('../utils/respond');
const { nonEmptyArray } = require('../utils/validate');
const { run, branchId, pageParams } = require('../utils/context');
const { audit } = require('../utils/audit');
const { StockBatch, PrescriptionRecord } = require('../models');
const InventoryService = require('../services/InventoryService');

// GET /pharmacy/expiring?days=90&branch_id=
exports.expiringSoon = asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 730);
  const branch = branchId(req, { required: false });
  const rows = await run(req, (db) => StockBatch.expiringSoon(db, { days, branchId: branch }));
  return ok(res, rows);
});

// GET /pharmacy/expired?branch_id=
exports.expired = asyncHandler(async (req, res) => {
  const branch = branchId(req, { required: false });
  const rows = await run(req, (db) => StockBatch.expired(db, { branchId: branch }));
  return ok(res, rows);
});

// POST /pharmacy/write-off  { batch_ids: [], note }   removes expired stock (booked as 'expiry' movements)
exports.writeOffExpired = asyncHandler(async (req, res) => {
  const batchIds = nonEmptyArray(req.body.batch_ids, 'batch_ids');
  const result = await run(req, async (db) => {
    const outcome = await InventoryService.writeOffExpired(db, req.user, { batch_ids: batchIds, note: req.body.note });
    await audit(db, req, 'pharmacy.write_off', 'stock_batch', null, { batches: batchIds.length, note: req.body.note });
    return outcome;
  });
  return ok(res, result);
});

// GET /pharmacy/prescriptions?from=&to=&drug_schedule=pom|controlled
exports.register = asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const result = await run(req, (db) =>
    PrescriptionRecord.register(db, {
      from: req.query.from,
      to: req.query.to,
      drug_schedule: req.query.drug_schedule,
      page,
      limit,
    })
  );
  return paginated(res, result);
});

// GET /pharmacy/prescriptions/sale/:saleId
exports.forSale = asyncHandler(async (req, res) => {
  const rows = await run(req, (db) => PrescriptionRecord.forSale(db, req.params.saleId));
  if (!rows) throw ApiError.notFound('Not found');
  return ok(res, rows);
});
