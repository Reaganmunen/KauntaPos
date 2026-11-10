'use strict';

/**
 * Auth for shop staff. Logic (hashing, JWTs, token rotation) lives in services/AuthService.
 * The shop is identified by the subdomain (req.tenantId from the tenant-resolution middleware)
 * or by a `shop` slug in the body/query, so login works from the main app domain too.
 */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/respond');
const { requireFields } = require('../utils/validate');
const { run, clientMeta } = require('../utils/context');
const { withTransaction } = require('../config/database');
const { Tenant, User, Branch, TenantFeature } = require('../models');
const AuthService = require('../services/AuthService');

async function resolveTenantId(req) {
  if (req.tenantId) return req.tenantId;
  const slug = (req.body && req.body.shop) || (req.query && req.query.shop);
  if (!slug) throw ApiError.badRequest('shop is required (your shop name or domain)');
  const tenant = await withTransaction((db) => Tenant.resolve(db, slug));
  if (!tenant) throw ApiError.notFound('Shop not found');
  return tenant.tenant_id;
}

// POST /auth/register  { slug, name, business_type, owner_name, owner_email|owner_phone, password }
exports.register = asyncHandler(async (req, res) => {
  requireFields(req.body, ['slug', 'name', 'owner_name', 'password']);
  if (!req.body.owner_email && !req.body.owner_phone) {
    throw ApiError.unprocessable('Owner email or phone is required');
  }
  const result = await AuthService.register(req.body, clientMeta(req));
  return created(res, result);
});

// POST /auth/login  { shop?, identifier (email or phone), password }
exports.login = asyncHandler(async (req, res) => {
  requireFields(req.body, ['identifier', 'password']);
  const tenantId = await resolveTenantId(req);
  const result = await AuthService.login({
    tenantId,
    identifier: req.body.identifier,
    password: req.body.password,
    ...clientMeta(req),
  });
  return ok(res, result);
});

// POST /auth/pin-login  { shop?, user_id, pin }  (fast cashier switch on a shared till)
exports.pinLogin = asyncHandler(async (req, res) => {
  requireFields(req.body, ['user_id', 'pin']);
  const tenantId = await resolveTenantId(req);
  const result = await AuthService.pinLogin({
    tenantId,
    userId: req.body.user_id,
    pin: String(req.body.pin),
    ...clientMeta(req),
  });
  return ok(res, result);
});

// POST /auth/refresh  { shop?, refresh_token }
exports.refresh = asyncHandler(async (req, res) => {
  requireFields(req.body, ['refresh_token']);
  const tenantId = await resolveTenantId(req);
  const result = await AuthService.refresh({
    tenantId,
    refreshToken: req.body.refresh_token,
    ...clientMeta(req),
  });
  return ok(res, result);
});

// POST /auth/logout  { refresh_token }
exports.logout = asyncHandler(async (req, res) => {
  await AuthService.logout({ tenantId: req.tenantId, refreshToken: req.body && req.body.refresh_token });
  return ok(res, { logged_out: true });
});

// GET /auth/me  -> user, shop, branches the user can work in, enabled features
exports.me = asyncHandler(async (req, res) => {
  const data = await run(req, async (db) => {
    const user = await User.findWithRole(db, req.user.id);
    if (!user) throw ApiError.unauthorized('This account no longer exists');
    const tenant = await Tenant.findById(db, req.tenantId);
    const branches = await Branch.listForUser(db, user);
    const features = await TenantFeature.asMap(db);
    return { user: User.sanitize(user), tenant, branches, features };
  });
  return ok(res, data);
});

// POST /auth/forgot-password  { shop?, identifier }
// Always answers the same way so nobody can probe which accounts exist.
exports.forgotPassword = asyncHandler(async (req, res) => {
  requireFields(req.body, ['identifier']);
  const tenantId = await resolveTenantId(req);
  await AuthService.forgotPassword({ tenantId, identifier: req.body.identifier });
  return ok(res, { message: 'If that account exists, a reset link has been sent.' });
});

// POST /auth/reset-password  { shop?, token, password }
exports.resetPassword = asyncHandler(async (req, res) => {
  requireFields(req.body, ['token', 'password']);
  const tenantId = await resolveTenantId(req);
  await AuthService.resetPassword({ tenantId, token: req.body.token, password: req.body.password });
  return ok(res, { message: 'Password updated. You can now log in.' });
});

// POST /auth/change-password  { current_password, new_password }
exports.changePassword = asyncHandler(async (req, res) => {
  requireFields(req.body, ['current_password', 'new_password']);
  await AuthService.changePassword({
    tenantId: req.tenantId,
    userId: req.user.id,
    currentPassword: req.body.current_password,
    newPassword: req.body.new_password,
  });
  return ok(res, { message: 'Password changed.' });
});
