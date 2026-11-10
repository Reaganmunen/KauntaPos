'use strict';

/** The shop's view of online orders: queue, details and fulfilment status. */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, paginated } = require('../utils/respond');
const { requireFields, oneOf } = require('../utils/validate');
const { run, branchId, pageParams } = require('../utils/context');
const { audit } = require('../utils/audit');
const { OnlineOrder, Sale } = require('../models');
const StorefrontService = require('../services/StorefrontService');

const STATUSES = ['awaiting_payment', 'paid', 'processing', 'ready', 'out_for_delivery', 'completed', 'cancelled'];

// GET /online-orders?status=&q=&branch_id=
exports.list = asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const result = await run(req, (db) =>
    OnlineOrder.list(db, { status: req.query.status, branch_id: req.query.branch_id, q: req.query.q, page, limit })
  );
  return paginated(res, result);
});

// GET /online-orders/counts   badge numbers per status
exports.counts = asyncHandler(async (req, res) => {
  const branch = branchId(req, { required: false });
  const counts = await run(req, (db) => OnlineOrder.statusCounts(db, branch));
  return ok(res, counts);
});

// GET /online-orders/:id   the order plus its full sale (lines, payments, KRA details)
exports.get = asyncHandler(async (req, res) => {
  const data = await run(req, async (db) => {
    const order = await OnlineOrder.findById(db, req.params.id);
    if (!order) return null;
    return { ...order, sale: await Sale.getFull(db, order.sale_id) };
  });
  if (!data) throw ApiError.notFound('Order not found');
  return ok(res, data);
});

// PUT /online-orders/:id/status  { status, reason }   (reason is needed to cancel)
// Cancelling releases the held stock; completing a paid order closes it out.
exports.setStatus = asyncHandler(async (req, res) => {
  requireFields(req.body, ['status']);
  oneOf(req.body.status, STATUSES, 'status');
  if (req.body.status === 'cancelled') requireFields(req.body, ['reason']);

  const order = await run(req, async (db) => {
    const updated = await StorefrontService.updateStatus(db, req.user, req.params.id, req.body.status, {
      reason: req.body.reason,
    });
    await audit(db, req, 'online_order.status', 'online_order', req.params.id, {
      status: req.body.status,
      reason: req.body.reason,
    });
    return updated;
  });
  return ok(res, order);
});
