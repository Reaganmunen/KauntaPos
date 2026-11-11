'use strict';

const ApiError = require('./ApiError');
const { Tenant, Plan, Branch, User, Product } = require('../models');

const COUNTERS = {
  branches: (db) => Branch.count(db, { is_active: true }),
  users: (db) => User.count(db, { is_active: true }),
  products: (db) => Product.count(db),
};

const PLAN_FIELDS = { branches: 'max_branches', users: 'max_users', products: 'max_products' };

/** How many more of `resource` the tenant's plan allows. Infinity when unlimited. */
async function remainingQuota(db, tenantId, resource) {
  const tenant = await Tenant.findById(db, tenantId);
  if (!tenant || !tenant.plan_id) return Infinity;
  const plan = await Plan.findById(db, tenant.plan_id);
  if (!plan) return Infinity;
  const max = plan[PLAN_FIELDS[resource]];
  if (max === null || max === undefined) return Infinity;
  const used = await COUNTERS[resource](db);
  return Math.max(max - used, 0);
}

/** Throws 403 when the plan's limit for `resource` is already reached. */
async function assertWithinLimit(db, tenantId, resource, adding = 1) {
  const remaining = await remainingQuota(db, tenantId, resource);
  if (remaining < adding) {
    throw ApiError.forbidden(`Your plan's limit for ${resource} has been reached. Upgrade your plan to add more.`);
  }
}

module.exports = { remainingQuota, assertWithinLimit };
