'use strict';

const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { withTenant } = require('../config/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Checks the branch a request names (body.branch_id, ?branch_id= or the X-Branch-Id header, same
 * order the controllers read it) and any extra body fields listed in `also`, e.g. a transfer's
 * from_branch_id. Run after authenticate.
 *
 *   - the branch must exist and be active in this shop
 *   - staff who are not owners / "all branches" may only use branches they are assigned to
 *   - sets req.branchId; when none is named it defaults to the user's only branch, or the shop's
 *     only active branch
 *
 *   resolveBranch()                        optional
 *   resolveBranch({ required: true })      400 when no branch can be determined
 *   resolveBranch({ also: ['from_branch_id'] })      body fields that must ALSO be branches the user may use
 *   resolveBranch({ exists: ['to_branch_id'] })      body fields that only need to be active branches
 *                                                    (e.g. the receiving branch of a transfer)
 */
function resolveBranch({ required = false, also = [], exists = [] } = {}) {
  return asyncHandler(async (req, res, next) => {
    const user = req.user;
    if (!user) throw ApiError.unauthorized();

    const primary =
      (req.body && req.body.branch_id) || (req.query && req.query.branch_id) || req.get('x-branch-id') || null;
    const extra = also.map((field) => req.body && req.body[field]).filter(Boolean);
    const ids = [...new Set([primary, ...extra].filter(Boolean).map(String))];
    const existOnly = exists.map((field) => req.body && req.body[field]).filter(Boolean).map(String);
    const mustExist = [...new Set([...ids, ...existOnly])];

    for (const id of mustExist) {
      if (!UUID_RE.test(id)) throw ApiError.badRequest('Invalid branch id');
    }

    const restricted = !(user.is_owner || user.all_branches);

    if (mustExist.length) {
      if (restricted) {
        const mine = new Set(user.branch_ids.map(String));
        if (ids.some((id) => !mine.has(id))) {
          throw ApiError.forbidden('You do not have access to that branch', undefined, 'branch_forbidden');
        }
      }
      const { rows } = await withTenant(req.tenantId, (db) =>
        db.query('SELECT id FROM branches WHERE id = ANY($1::uuid[]) AND is_active', [mustExist])
      );
      if (rows.length !== mustExist.length) throw ApiError.unprocessable('Branch not found or no longer active');
    }

    if (primary) {
      req.branchId = String(primary);
    } else if (restricted && user.branch_ids.length === 1) {
      req.branchId = String(user.branch_ids[0]);
    } else if (!restricted && req.tenantCtx && req.tenantCtx.single_branch_id) {
      req.branchId = String(req.tenantCtx.single_branch_id);
    }

    if (required && !req.branchId) {
      throw ApiError.badRequest('Select a branch first (send the X-Branch-Id header)', undefined, 'branch_required');
    }
    next();
  });
}

module.exports = { resolveBranch };
