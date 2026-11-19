'use strict';

const ApiError = require('./ApiError');
const { Tenant, Plan, Branch, User, Product } = require('../models');

const COUNTERS = {
  branches: (db) => Branch.count(db, { is_active: true }),
  users: (db) => User.count(db, { is_active: true }),
  products: (db) => Product.count(db),
};

const PLAN_FIELDS = { branches: 'max_branches', users: 'max_users', products: 'max_products' };
const LABELS = { branches: 'branches', users: 'team members', products: 'products' };

/** The shop's plan row, or null when it has none (older shops: nothing is held back). */
async function planFor(db, tenantId) {
  const tenant = await Tenant.findById(db, tenantId);
  if (!tenant || !tenant.plan_id) return null;
  return Plan.findById(db, tenant.plan_id);
}

/** { limit, used } for one resource. limit is null when the plan sets none. */
async function quota(db, plan, resource) {
  const max = plan ? plan[PLAN_FIELDS[resource]] : null;
  const limit = max === null || max === undefined ? null : Number(max);
  return { limit, used: await COUNTERS[resource](db) };
}

/** How many more of `resource` the tenant's plan allows. Infinity when unlimited. */
async function remainingQuota(db, tenantId, resource) {
  const plan = await planFor(db, tenantId);
  const { limit, used } = await quota(db, plan, resource);
  if (limit === null) return Infinity;
  return Math.max(limit - used, 0);
}

/**
 * Throws 403 plan_limit_reached when the plan's limit for `resource` is already reached.
 * Call it inside the same transaction that creates the row: it takes a lock per shop and resource
 * first, so two requests made at the same moment cannot both slip under the limit.
 */
async function assertWithinLimit(db, tenantId, resource, adding = 1) {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`limit:${tenantId}:${resource}`]);
  const plan = await planFor(db, tenantId);
  const { limit, used } = await quota(db, plan, resource);
  if (limit !== null && limit - used < adding) {
    throw ApiError.forbidden(
      `Your ${plan.name} plan allows up to ${limit} ${LABELS[resource]}. Upgrade your plan to add more.`,
      { resource, limit, used },
      'plan_limit_reached'
    );
  }
}

/** { branches: { used, limit }, users: {...}, products: {...} } for the billing screen. */
async function usage(db, tenantId) {
  const plan = await planFor(db, tenantId);
  const out = {};
  for (const resource of Object.keys(COUNTERS)) out[resource] = await quota(db, plan, resource);
  return out;
}

module.exports = { planFor, remainingQuota, assertWithinLimit, usage };
