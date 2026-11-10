'use strict';

/** Roles and their permissions. The "Owner" role is fixed; other roles can be edited freely. */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/respond');
const { requireFields, nonEmptyArray } = require('../utils/validate');
const { run } = require('../utils/context');
const { audit } = require('../utils/audit');
const { PERMISSION_GROUPS, isValidPermission } = require('../utils/permissions');
const { Role, User } = require('../models');

function checkPermissions(req, permissions) {
  nonEmptyArray(permissions, 'permissions');
  const invalid = permissions.filter((p) => typeof p !== 'string' || !isValidPermission(p));
  if (invalid.length) throw ApiError.unprocessable(`Unknown permission(s): ${invalid.join(', ')}`);
  if (permissions.includes('*') && !req.user.is_owner) {
    throw ApiError.forbidden('Only the shop owner can grant full access');
  }
  return [...new Set(permissions)];
}

// GET /roles
exports.list = asyncHandler(async (req, res) => {
  const rows = await run(req, (db) => Role.findAll(db));
  return ok(res, rows);
});

// GET /roles/permissions  -> grouped catalogue for the role editor
exports.permissionCatalog = asyncHandler(async (req, res) => ok(res, PERMISSION_GROUPS));

// GET /roles/:id
exports.get = asyncHandler(async (req, res) => {
  const row = await run(req, (db) => Role.findById(db, req.params.id));
  if (!row) throw ApiError.notFound('Role not found');
  return ok(res, row);
});

// POST /roles  { name, description, permissions: [] }
exports.create = asyncHandler(async (req, res) => {
  requireFields(req.body, ['name', 'permissions']);
  const permissions = checkPermissions(req, req.body.permissions);
  const role = await run(req, async (db) => {
    const record = await Role.create(db, {
      name: String(req.body.name).trim(),
      description: req.body.description || null,
      permissions,
    });
    await audit(db, req, 'role.create', 'role', record.id, { name: record.name, permissions });
    return record;
  });
  return created(res, role);
});

// PATCH /roles/:id
exports.update = asyncHandler(async (req, res) => {
  const role = await run(req, async (db) => {
    const existing = await Role.findById(db, req.params.id);
    if (!existing) throw ApiError.notFound('Role not found');
    if (existing.name === 'Owner') throw ApiError.forbidden('The Owner role cannot be changed');

    const data = {};
    if (req.body.description !== undefined) data.description = req.body.description;
    if (req.body.permissions !== undefined) data.permissions = checkPermissions(req, req.body.permissions);
    if (req.body.name !== undefined) {
      if (existing.is_system) throw ApiError.unprocessable('Built-in roles cannot be renamed');
      data.name = String(req.body.name).trim();
    }

    const record = await Role.update(db, existing.id, data);
    await audit(db, req, 'role.update', 'role', existing.id, { after: data });
    return record;
  });
  return ok(res, role);
});

// DELETE /roles/:id  (custom roles with no users only)
exports.remove = asyncHandler(async (req, res) => {
  await run(req, async (db) => {
    const existing = await Role.findById(db, req.params.id);
    if (!existing) throw ApiError.notFound('Role not found');
    if (existing.is_system) throw ApiError.unprocessable('Built-in roles cannot be deleted');
    const inUse = await User.count(db, { role_id: existing.id });
    if (inUse > 0) {
      throw ApiError.conflict(`${inUse} user(s) still have this role. Move them to another role first.`);
    }
    await Role.remove(db, existing.id);
    await audit(db, req, 'role.delete', 'role', existing.id, { name: existing.name });
  });
  return ok(res, { deleted: true });
});
