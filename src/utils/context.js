'use strict';

const { withTenant } = require('../config/database');
const ApiError = require('./ApiError');

/**
 * Runs fn(db) in a transaction with the request's tenant set (Row Level Security applies).
 * req.tenantId is set by the auth middleware (from the JWT) or the tenant-resolution
 * middleware (from the subdomain, for public storefront and login routes).
 */
const run = (req, fn) => withTenant(req.tenantId, fn);

const isRestricted = (user) => Boolean(user) && !(user.is_owner || user.all_branches);

/**
 * Branch for this request: body, query, X-Branch-Id header, or req.branchId from middleware.
 * Staff who are limited to certain branches can NEVER fall through to "all branches": with no
 * branch named they get their only branch, or a 400 asking them to pick one. (Whether the named
 * branch is one they may use is checked by the resolveBranch middleware.)
 */
function branchId(req, { required = true } = {}) {
  const id =
    (req.body && req.body.branch_id) ||
    (req.query && req.query.branch_id) ||
    req.get('x-branch-id') ||
    req.branchId ||
    null;
  if (id) return id;

  if (isRestricted(req.user)) {
    const mine = req.user.branch_ids || [];
    if (mine.length === 1) return String(mine[0]);
    throw ApiError.badRequest('Select a branch first (send the X-Branch-Id header)', undefined, 'branch_required');
  }
  if (required) throw ApiError.badRequest('branch_id is required');
  return null;
}

/**
 * Branch filter for LIST screens. Owners and all-branch staff see every branch unless they pass
 * ?branch_id=; limited staff are always held to one of their own branches.
 */
function listBranch(req) {
  const named = (req.query && req.query.branch_id) || null;
  if (named) return named;
  return isRestricted(req.user) ? branchId(req) : null;
}

function pageParams(req) {
  return {
    page: Math.max(parseInt(req.query.page, 10) || 1, 1),
    limit: Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200),
  };
}

/** Query-string booleans: 'true' / '1' -> true, 'false' / '0' -> false, missing -> undefined. */
function toBool(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return value === true || value === 'true' || value === '1' || value === 1;
}

const clientMeta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

module.exports = { run, branchId, listBranch, isRestricted, pageParams, toBool, clientMeta };
