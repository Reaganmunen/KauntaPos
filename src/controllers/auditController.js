'use strict';

const asyncHandler = require('../utils/asyncHandler');
const { ok, paginated } = require('../utils/respond');
const { run, pageParams } = require('../utils/context');
const { AuditLog } = require('../models');

// GET /audit?user_id=&action=&entity_type=&from=&to=
exports.list = asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const result = await run(req, (db) =>
    AuditLog.search(db, {
      user_id: req.query.user_id,
      action: req.query.action,
      entity_type: req.query.entity_type,
      from: req.query.from,
      to: req.query.to,
      page,
      limit: Math.min(limit, 100),
    })
  );
  return paginated(res, result);
});

// GET /audit/:entityType/:entityId   history of one record (a product's price changes, a sale's void...)
exports.history = asyncHandler(async (req, res) => {
  const rows = await run(req, (db) =>
    AuditLog.forEntity(db, req.params.entityType, req.params.entityId, {
      limit: Math.min(parseInt(req.query.limit, 10) || 50, 200),
    })
  );
  return ok(res, rows);
});
