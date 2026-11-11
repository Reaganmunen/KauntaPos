'use strict';

const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { verifyAccessToken, verifyPlatformToken } = require('../utils/jwt');
const { getTenantContext, getUserContext } = require('../utils/contextCache');
const { withAdmin } = require('../config/database');
const { PlatformAdmin } = require('../models');

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Shop staff authentication. Verifies the access token, loads the user and the shop (cached for a
 * few seconds), and sets:
 *   req.tenantId   the shop, from the token
 *   req.tenantCtx  { status, features, single_branch_id, ... }
 *   req.user       { id, full_name, email, is_owner, all_branches, role_name, permissions, branch_ids }
 * Rejects a token used on another shop's subdomain, and deactivated users within one cache TTL.
 */
const authenticate = asyncHandler(async (req, res, next) => {
  const token = bearerToken(req);
  if (!token) throw ApiError.unauthorized();

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw ApiError.unauthorized('Your session has expired', undefined, 'token_expired');
    }
    throw ApiError.unauthorized('Your session is not valid. Please log in again.', undefined, 'invalid_token');
  }

  const tenantId = payload.tid;
  const userId = payload.sub;
  if (req.tenantId && req.tenantId !== tenantId) {
    throw ApiError.forbidden('This session belongs to a different shop', undefined, 'wrong_shop');
  }

  const [tenantCtx, user] = await Promise.all([getTenantContext(tenantId), getUserContext(tenantId, userId)]);
  if (!tenantCtx) throw ApiError.unauthorized('This shop no longer exists', undefined, 'invalid_token');
  if (!user || !user.is_active) {
    throw ApiError.unauthorized('This account is no longer active', undefined, 'account_inactive');
  }

  req.tenantId = tenantId;
  req.tenantSlug = tenantCtx.slug;
  req.tenantCtx = tenantCtx;
  req.user = {
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    phone: user.phone,
    is_owner: user.is_owner,
    all_branches: user.all_branches,
    role_id: user.role_id,
    role_name: user.role_name,
    permissions: user.permissions || [],
    branch_ids: user.branch_ids || [],
  };
  next();
});

/**
 * For logout: an expired access token must still be able to sign the user out, so the signature
 * is checked but expiry is ignored, and only the shop id is taken from it. Never rejects.
 */
function tenantFromToken(req, res, next) {
  if (!req.tenantId) {
    const token = bearerToken(req);
    if (token) {
      try {
        req.tenantId = verifyAccessToken(token, { ignoreExpiration: true }).tid;
      } catch (err) {
        // bad token: leave the shop unset, logout just reports success
      }
    }
  }
  next();
}

/** Only the shop owner (e.g. billing, transferring ownership). */
function requireOwner(req, res, next) {
  if (!req.user) return next(ApiError.unauthorized());
  if (!req.user.is_owner) return next(ApiError.forbidden('Only the shop owner can do that'));
  return next();
}

/**
 * Kaunta platform staff authentication (separate secret and audience from shop tokens).
 * Optionally restricted to office IPs with PLATFORM_ALLOWED_IPS="1.2.3.4,5.6.7.8".
 * Sets req.admin = { id, email, full_name }.
 */
const authenticatePlatform = asyncHandler(async (req, res, next) => {
  const allowed = (process.env.PLATFORM_ALLOWED_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length) {
    const ip = String(req.ip || '').replace(/^::ffff:/, '');
    if (!allowed.includes(ip)) throw ApiError.forbidden('Not allowed from this network', undefined, 'ip_not_allowed');
  }

  const token = bearerToken(req);
  if (!token) throw ApiError.unauthorized();

  let payload;
  try {
    payload = verifyPlatformToken(token);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw ApiError.unauthorized('Your session has expired', undefined, 'token_expired');
    }
    throw ApiError.unauthorized('Your session is not valid. Please log in again.', undefined, 'invalid_token');
  }

  const admin = await withAdmin((db) => PlatformAdmin.findById(db, payload.sub));
  if (!admin || !admin.is_active) {
    throw ApiError.unauthorized('This account is no longer active', undefined, 'account_inactive');
  }
  req.admin = { id: admin.id, email: admin.email, full_name: admin.full_name };
  next();
});

module.exports = { authenticate, tenantFromToken, requireOwner, authenticatePlatform };
