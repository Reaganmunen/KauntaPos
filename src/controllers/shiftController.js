'use strict';

/** Cashier shifts: open with a float, pay-ins / pay-outs / drops, close with a cash count. */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/respond');
const { requireFields, oneOf, positive } = require('../utils/validate');
const { run, branchId, pageParams } = require('../utils/context');
const { audit } = require('../utils/audit');
const { Shift, Role } = require('../models');

const isManager = (req) => req.user.is_owner || Role.hasPermission(req.user.permissions, 'reports.view');

// Cashiers can only touch their own shift; managers can touch any.
function assertShiftAccess(req, shift) {
  if (!shift) throw ApiError.notFound('Shift not found');
  if (shift.user_id !== req.user.id && !isManager(req)) {
    throw ApiError.forbidden('This shift belongs to another cashier');
  }
}

// GET /shifts/current   my open shift, with cash movements, totals and expected cash (or null)
exports.current = asyncHandler(async (req, res) => {
  const data = await run(req, async (db) => {
    const shift = await Shift.findOpenForUser(db, req.user.id);
    if (!shift) return null;
    return {
      ...shift,
      cash_movements: await Shift.cashMovements(db, shift.id),
      summary: await Shift.summary(db, shift.id),
      expected_cash: await Shift.expectedCash(db, shift),
    };
  });
  return ok(res, data);
});

// POST /shifts/open  { opening_float, terminal_id }
exports.open = asyncHandler(async (req, res) => {
  const branch = branchId(req);
  const openingFloat = req.body.opening_float === undefined ? 0 : Number(req.body.opening_float);
  if (!Number.isFinite(openingFloat) || openingFloat < 0) {
    throw ApiError.unprocessable('opening_float must be 0 or more');
  }

  const shift = await run(req, async (db) => {
    if (await Shift.findOpenForUser(db, req.user.id)) {
      throw ApiError.conflict('You already have an open shift. Close it first.');
    }
    if (req.body.terminal_id && (await Shift.findOpenForTerminal(db, req.body.terminal_id))) {
      throw ApiError.conflict('Another cashier has an open shift on this till.');
    }
    const record = await Shift.open(db, {
      branch_id: branch,
      terminal_id: req.body.terminal_id || null,
      user_id: req.user.id,
      opening_float: openingFloat,
    });
    await audit(db, req, 'shift.open', 'shift', record.id, { opening_float: openingFloat });
    return record;
  });
  return created(res, shift);
});

// POST /shifts/:id/cash  { movement_type: 'pay_in'|'pay_out'|'drop', amount, reason }
exports.cashMovement = asyncHandler(async (req, res) => {
  requireFields(req.body, ['movement_type', 'amount', 'reason']);
  oneOf(req.body.movement_type, ['pay_in', 'pay_out', 'drop'], 'movement_type');
  const amount = positive(req.body.amount, 'amount');

  const movement = await run(req, async (db) => {
    const shift = await Shift.findById(db, req.params.id);
    assertShiftAccess(req, shift);
    if (shift.status !== 'open') throw ApiError.conflict('This shift is already closed');

    const record = await Shift.addCashMovement(db, shift.id, {
      movement_type: req.body.movement_type,
      amount,
      reason: req.body.reason,
      created_by: req.user.id,
    });
    await audit(db, req, 'shift.cash_movement', 'shift', shift.id, { type: req.body.movement_type, amount });
    return record;
  });
  return created(res, movement);
});

// POST /shifts/:id/close  { counted_cash, notes }
exports.close = asyncHandler(async (req, res) => {
  requireFields(req.body, ['counted_cash']);
  const counted = Number(req.body.counted_cash);
  if (!Number.isFinite(counted) || counted < 0) throw ApiError.unprocessable('counted_cash must be 0 or more');

  const data = await run(req, async (db) => {
    const existing = await Shift.findById(db, req.params.id);
    assertShiftAccess(req, existing);

    const closed = await Shift.close(db, existing.id, { counted_cash: counted, notes: req.body.notes });
    if (!closed) throw ApiError.conflict('This shift is already closed');
    await audit(db, req, 'shift.close', 'shift', closed.id, {
      expected_cash: closed.expected_cash,
      counted_cash: closed.counted_cash,
      variance: closed.variance,
    });
    return { ...closed, summary: await Shift.summary(db, closed.id) };
  });
  return ok(res, data);
});

// GET /shifts/:id
exports.get = asyncHandler(async (req, res) => {
  const data = await run(req, async (db) => {
    const shift = await Shift.findById(db, req.params.id);
    assertShiftAccess(req, shift);
    return {
      ...shift,
      cash_movements: await Shift.cashMovements(db, shift.id),
      summary: await Shift.summary(db, shift.id),
      expected_cash: shift.status === 'open' ? await Shift.expectedCash(db, shift) : shift.expected_cash,
    };
  });
  return ok(res, data);
});

// GET /shifts?branch_id=&user_id=&status=
exports.list = asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const result = await run(req, (db) =>
    Shift.listForBranch(db, {
      branch_id: req.query.branch_id,
      user_id: isManager(req) ? req.query.user_id : req.user.id,
      status: req.query.status,
      page,
      limit,
    })
  );
  return paginated(res, result);
});
