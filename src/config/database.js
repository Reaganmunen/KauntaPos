'use strict';

const { Pool, types } = require('pg');

// numeric(14,2) / numeric(14,3) -> JS numbers (values fit safely in a double)
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
// bigint (COUNT, audit_logs.id) -> JS numbers
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));
// DATE -> 'YYYY-MM-DD' string (avoids timezone shifts on expiry dates etc.)
types.setTypeParser(1082, (v) => v);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs fn(client) inside a transaction with the tenant set, so Row Level Security
 * applies to every query. Use this for ALL tenant data access.
 */
async function withTenant(tenantId, fn) {
  if (!tenantId || !UUID_RE.test(tenantId)) {
    throw new Error('withTenant: a valid tenant id is required');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback failed:', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Transaction with NO tenant context. Only for SECURITY DEFINER lookups
 * (register_tenant, resolve_tenant, resolve_mpesa_callback, claim_etims_jobs).
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback failed:', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Single query without tenant context (same restrictions as withTransaction). */
function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, withTenant, withTransaction, query };
