'use strict';

const { withTenant } = require('../config/database');

/**
 * Every authenticated request needs the user (role, permissions, branches) and the shop
 * (status, enabled modules). Hitting the database for both on every call would double the load,
 * so they are cached in memory for a few seconds (default 15s, CONTEXT_CACHE_TTL_MS).
 *
 * Changes made through the API call invalidate*() so they apply at once on this server. With
 * several server instances, other instances pick the change up when their cache entry expires,
 * so deactivating a user or changing a role takes effect everywhere within one TTL.
 */
const TTL_MS = parseInt(process.env.CONTEXT_CACHE_TTL_MS || '15000', 10);
const MAX_ENTRIES = 10000;

const tenants = new Map(); // tenantId -> { value, expires }
const users = new Map();   // `${tenantId}:${userId}` -> { value, expires }

const isFresh = (entry) => entry && entry.expires > Date.now();

function store(map, key, value) {
  if (map.size >= MAX_ENTRIES) sweep(map);
  map.set(key, { value, expires: Date.now() + TTL_MS });
}

function sweep(map) {
  const now = Date.now();
  for (const [key, entry] of map) if (entry.expires <= now) map.delete(key);
  if (map.size >= MAX_ENTRIES) map.clear(); // safety valve
}

setInterval(() => {
  sweep(tenants);
  sweep(users);
}, 60000).unref();

/** { id, slug, name, status, business_type, trial_ends_at, current_period_end, plan_id, features, single_branch_id } */
async function getTenantContext(tenantId) {
  const hit = tenants.get(tenantId);
  if (isFresh(hit)) return hit.value;

  const value = await withTenant(tenantId, async (db) => {
    const t = await db.query(
      `SELECT id, slug, name, status, business_type, trial_ends_at, current_period_end, plan_id
         FROM tenants WHERE id = $1`,
      [tenantId]
    );
    if (!t.rows[0]) return null;
    const features = await db.query('SELECT feature_key, enabled FROM tenant_features');
    const branches = await db.query('SELECT id FROM branches WHERE is_active ORDER BY is_main DESC LIMIT 2');
    return {
      ...t.rows[0],
      features: Object.fromEntries(features.rows.map((r) => [r.feature_key, r.enabled])),
      // when the shop has exactly one active branch, requests need not name it
      single_branch_id: branches.rows.length === 1 ? branches.rows[0].id : null,
    };
  });
  if (value) store(tenants, tenantId, value);
  return value;
}

/** { id, full_name, email, phone, is_owner, all_branches, is_active, role_id, role_name, permissions, branch_ids } */
async function getUserContext(tenantId, userId) {
  const key = `${tenantId}:${userId}`;
  const hit = users.get(key);
  if (isFresh(hit)) return hit.value;

  const value = await withTenant(tenantId, async (db) => {
    const { rows } = await db.query(
      `SELECT u.id, u.full_name, u.email, u.phone, u.is_owner, u.all_branches, u.is_active, u.role_id,
              r.name AS role_name,
              COALESCE(r.permissions, '{}') AS permissions,
              COALESCE((SELECT array_agg(ub.branch_id) FROM user_branches ub WHERE ub.user_id = u.id), '{}') AS branch_ids
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1`,
      [userId]
    );
    return rows[0] || null;
  });
  if (value) store(users, key, value);
  return value;
}

function invalidateTenant(tenantId) {
  tenants.delete(tenantId);
}

function invalidateUser(tenantId, userId) {
  users.delete(`${tenantId}:${userId}`);
}

/** After a role's permissions change: every user of the shop may be affected. */
function invalidateTenantUsers(tenantId) {
  const prefix = `${tenantId}:`;
  for (const key of users.keys()) if (key.startsWith(prefix)) users.delete(key);
}

module.exports = {
  getTenantContext,
  getUserContext,
  invalidateTenant,
  invalidateUser,
  invalidateTenantUsers,
};
