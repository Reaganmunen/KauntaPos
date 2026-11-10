'use strict';

/** Staff accounts for a shop. Hashing is delegated to AuthService so there is one place for it. */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/respond');
const { requireFields, pick } = require('../utils/validate');
const { run, pageParams, toBool } = require('../utils/context');
const { audit } = require('../utils/audit');
const { assertWithinLimit } = require('../utils/limits');
const { User, Role, RefreshToken } = require('../models');
const AuthService = require('../services/AuthService');

const UPDATABLE = ['full_name', 'email', 'phone', 'role_id', 'all_branches', 'is_active'];

function assertCanTouchOwner(req, target) {
  if (target.is_owner && !req.user.is_owner) {
    throw ApiError.forbidden('Only the shop owner can change the owner account');
  }
}

// GET /users?q=&role_id=&is_active=
exports.list = asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const result = await run(req, (db) =>
    User.search(db, {
      q: req.query.q,
      role_id: req.query.role_id,
      is_active: toBool(req.query.is_active),
      page,
      limit,
    })
  );
  return paginated(res, { ...result, rows: result.rows.map(User.sanitize) });
});

// GET /users/:id
exports.get = asyncHandler(async (req, res) => {
  const user = await run(req, async (db) => {
    const found = await User.findWithRole(db, req.params.id);
    if (!found) return null;
    return { ...User.sanitize(found), branch_ids: await User.getBranchIds(db, found.id) };
  });
  if (!user) throw ApiError.notFound('User not found');
  return ok(res, user);
});

// POST /users  { full_name, email|phone, role_id, password, pin?, all_branches?, branch_ids? }
exports.create = asyncHandler(async (req, res) => {
  requireFields(req.body, ['full_name', 'role_id', 'password']);
  if (!req.body.email && !req.body.phone) throw ApiError.unprocessable('Email or phone is required');

  // hash before opening the transaction so the connection is held for less time
  const password_hash = await AuthService.hashPassword(req.body.password);
  const pin_hash = req.body.pin ? await AuthService.hashPassword(String(req.body.pin)) : null;

  const user = await run(req, async (db) => {
    await assertWithinLimit(db, req.tenantId, 'users');

    const role = await Role.findById(db, req.body.role_id);
    if (!role) throw ApiError.unprocessable('That role does not exist');
    if (role.name === 'Owner' && !req.user.is_owner) {
      throw ApiError.forbidden('Only the shop owner can create another owner');
    }

    const record = await User.create(db, {
      full_name: req.body.full_name,
      email: req.body.email || null,
      phone: req.body.phone || null,
      role_id: role.id,
      password_hash,
      pin_hash,
      all_branches: Boolean(req.body.all_branches),
      is_owner: false,
      is_active: true,
    });
    if (Array.isArray(req.body.branch_ids)) await User.setBranches(db, record.id, req.body.branch_ids);
    await audit(db, req, 'user.create', 'user', record.id, { full_name: record.full_name, role: role.name });
    return User.sanitize(record);
  });
  return created(res, user);
});

// PATCH /users/:id
exports.update = asyncHandler(async (req, res) => {
  const user = await run(req, async (db) => {
    const target = await User.findById(db, req.params.id);
    if (!target) throw ApiError.notFound('User not found');
    assertCanTouchOwner(req, target);

    const data = pick(req.body, UPDATABLE);
    if (target.is_owner) {
      delete data.role_id;
      delete data.is_active;
    }
    if (data.role_id) {
      const role = await Role.findById(db, data.role_id);
      if (!role) throw ApiError.unprocessable('That role does not exist');
      if (role.name === 'Owner' && !req.user.is_owner) {
        throw ApiError.forbidden('Only the shop owner can make someone an owner');
      }
    }
    if (data.is_active === true && !target.is_active) {
      await assertWithinLimit(db, req.tenantId, 'users');
    }

    const record = await User.update(db, target.id, data);
    if (Array.isArray(req.body.branch_ids)) await User.setBranches(db, target.id, req.body.branch_ids);
    if (data.is_active === false) await RefreshToken.revokeAllForUser(db, target.id);
    await audit(db, req, 'user.update', 'user', target.id, { after: data });
    return User.sanitize(record);
  });
  return ok(res, user);
});

// POST /users/:id/reset-password  { password }  (manager sets a new password for a staff member)
exports.resetPassword = asyncHandler(async (req, res) => {
  requireFields(req.body, ['password']);
  const password_hash = await AuthService.hashPassword(req.body.password);
  await run(req, async (db) => {
    const target = await User.findById(db, req.params.id);
    if (!target) throw ApiError.notFound('User not found');
    assertCanTouchOwner(req, target);
    await User.update(db, target.id, { password_hash });
    await RefreshToken.revokeAllForUser(db, target.id);
    await audit(db, req, 'user.reset_password', 'user', target.id, null);
  });
  return ok(res, { message: 'Password reset. The user has been signed out everywhere.' });
});

// PUT /users/:id/pin  { pin }
exports.setPin = asyncHandler(async (req, res) => {
  requireFields(req.body, ['pin']);
  if (!/^\d{4,8}$/.test(String(req.body.pin))) throw ApiError.unprocessable('PIN must be 4 to 8 digits');
  const pin_hash = await AuthService.hashPassword(String(req.body.pin));
  await run(req, async (db) => {
    const target = await User.findById(db, req.params.id);
    if (!target) throw ApiError.notFound('User not found');
    assertCanTouchOwner(req, target);
    await User.update(db, target.id, { pin_hash });
    await audit(db, req, 'user.set_pin', 'user', target.id, null);
  });
  return ok(res, { message: 'PIN updated.' });
});

// POST /users/:id/deactivate
exports.deactivate = asyncHandler(async (req, res) => {
  await run(req, async (db) => {
    const target = await User.findById(db, req.params.id);
    if (!target) throw ApiError.notFound('User not found');
    if (target.is_owner) throw ApiError.unprocessable('The owner account cannot be deactivated');
    if (target.id === req.user.id) throw ApiError.unprocessable('You cannot deactivate your own account');
    await User.update(db, target.id, { is_active: false });
    await RefreshToken.revokeAllForUser(db, target.id);
    await audit(db, req, 'user.deactivate', 'user', target.id, null);
  });
  return ok(res, { deactivated: true });
});
