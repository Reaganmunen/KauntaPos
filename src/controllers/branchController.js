'use strict';

/** Branches and the POS terminals inside them. */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/respond');
const { requireFields, pick } = require('../utils/validate');
const { run, toBool } = require('../utils/context');
const { audit } = require('../utils/audit');
const { assertWithinLimit } = require('../utils/limits');
const { Branch, PosTerminal } = require('../models');

const BRANCH_FIELDS = ['code', 'name', 'phone', 'address', 'county', 'etims_branch_id', 'is_active'];

// GET /branches  -> branches the current user may work in (?all=true for management screens)
exports.list = asyncHandler(async (req, res) => {
  const rows = await run(req, (db) =>
    toBool(req.query.all) ? Branch.findAll(db) : Branch.listForUser(db, req.user)
  );
  return ok(res, rows);
});

// GET /branches/:id
exports.get = asyncHandler(async (req, res) => {
  const row = await run(req, (db) => Branch.findById(db, req.params.id));
  if (!row) throw ApiError.notFound('Branch not found');
  return ok(res, row);
});

// POST /branches  { code, name, phone, address, county, etims_branch_id, is_main }
exports.create = asyncHandler(async (req, res) => {
  requireFields(req.body, ['code', 'name']);
  const branch = await run(req, async (db) => {
    await assertWithinLimit(db, req.tenantId, 'branches');
    const record = await Branch.create(db, { ...pick(req.body, BRANCH_FIELDS), is_main: false });
    if (req.body.is_main) await Branch.setMain(db, record.id);
    await audit(db, req, 'branch.create', 'branch', record.id, { after: req.body });
    return Branch.findById(db, record.id);
  });
  return created(res, branch);
});

// PATCH /branches/:id
exports.update = asyncHandler(async (req, res) => {
  const branch = await run(req, async (db) => {
    const existing = await Branch.findById(db, req.params.id);
    if (!existing) throw ApiError.notFound('Branch not found');

    const data = pick(req.body, BRANCH_FIELDS);
    if (existing.is_main && data.is_active === false) {
      throw ApiError.unprocessable('The main branch cannot be deactivated. Make another branch the main one first.');
    }
    if (data.is_active === true && !existing.is_active) {
      await assertWithinLimit(db, req.tenantId, 'branches');
    }
    const record = await Branch.update(db, existing.id, data);
    if (req.body.is_main === true && !existing.is_main) await Branch.setMain(db, existing.id);
    await audit(db, req, 'branch.update', 'branch', existing.id, { after: data });
    return Branch.findById(db, record.id);
  });
  return ok(res, branch);
});

// POST /branches/:id/main
exports.setMain = asyncHandler(async (req, res) => {
  const branch = await run(req, async (db) => {
    const record = await Branch.setMain(db, req.params.id);
    if (!record) throw ApiError.notFound('Branch not found');
    await audit(db, req, 'branch.set_main', 'branch', record.id, null);
    return record;
  });
  return ok(res, branch);
});

// ---------- terminals ----------

// GET /branches/:id/terminals
exports.listTerminals = asyncHandler(async (req, res) => {
  const rows = await run(req, (db) =>
    PosTerminal.findAll(db, { filters: { branch_id: req.params.id } })
  );
  return ok(res, rows);
});

// POST /branches/:id/terminals  { name, device_id }
exports.createTerminal = asyncHandler(async (req, res) => {
  requireFields(req.body, ['name']);
  const terminal = await run(req, async (db) => {
    const branch = await Branch.findById(db, req.params.id);
    if (!branch) throw ApiError.notFound('Branch not found');
    return PosTerminal.create(db, {
      branch_id: branch.id,
      name: req.body.name,
      device_id: req.body.device_id || null,
    });
  });
  return created(res, terminal);
});

// PATCH /terminals/:id
exports.updateTerminal = asyncHandler(async (req, res) => {
  const terminal = await run(req, (db) =>
    PosTerminal.update(db, req.params.id, pick(req.body, ['name', 'device_id', 'is_active']))
  );
  if (!terminal) throw ApiError.notFound('Terminal not found');
  return ok(res, terminal);
});

// POST /terminals/heartbeat  { device_id }  called by the till so staff can see it is online
exports.terminalHeartbeat = asyncHandler(async (req, res) => {
  requireFields(req.body, ['device_id']);
  const terminal = await run(req, async (db) => {
    const found = await PosTerminal.findByDevice(db, req.body.device_id);
    if (found) await PosTerminal.touch(db, found.id);
    return found;
  });
  if (!terminal) throw ApiError.notFound('This device is not registered as a terminal');
  return ok(res, { id: terminal.id, branch_id: terminal.branch_id, name: terminal.name });
});
