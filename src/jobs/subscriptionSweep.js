'use strict';

/**
 * Keeps tenants.status honest. Access never depends on this job (utils/entitlements works from the
 * dates), it only makes the Kaunta staff panel and its numbers match what the shops experience:
 * a shop whose paid period has ended moves from 'active' to 'past_due'. Paying again sets it back to
 * 'active' (see SubscriptionPayment.confirmAndActivate).
 *
 *   SUBSCRIPTION_SWEEP_MS   how often to run, default one hour; 0 switches the job off
 *
 * Safe to run on several servers at once: it is one idempotent UPDATE.
 */
const { withAdmin } = require('../config/database');
const { invalidateAllTenants } = require('../utils/contextCache');

const EVERY_MS = parseInt(process.env.SUBSCRIPTION_SWEEP_MS || String(60 * 60 * 1000), 10);

const log = (level, msg, extra) =>
  console[level === 'error' ? 'error' : 'log'](JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

async function sweep() {
  const moved = await withAdmin(async (db) => {
    const result = await db.query(
      `UPDATE tenants
          SET status = 'past_due'
        WHERE status = 'active'
          AND current_period_end IS NOT NULL
          AND current_period_end < now()`
    );
    return result.rowCount;
  });
  if (moved) {
    invalidateAllTenants();
    log('info', 'subscription sweep: shops moved to past_due', { count: moved });
  }
  return moved;
}

function start() {
  if (!Number.isFinite(EVERY_MS) || EVERY_MS <= 0) return null;
  const run = () => sweep().catch((err) => log('error', 'subscription sweep failed', { error: err && err.message }));
  setTimeout(run, 30 * 1000).unref(); // shortly after start-up, then on the interval
  return setInterval(run, EVERY_MS).unref();
}

module.exports = { start, sweep };
