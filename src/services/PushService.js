'use strict';

/**
 * Web Push for shop staff: an operating-system notification when a shopper messages the shop, even when
 * Kaunta is not open. Staff turn it on from the Customer chats page; each browser/phone that does so is one
 * row in push_subscriptions.
 *
 *   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY   create once:  npx web-push generate-vapid-keys
 *   VAPID_SUBJECT                          mailto:you@yourdomain  (optional)
 *
 * Without the keys everything here quietly does nothing and the app behaves as before.
 */
const webpush = require('web-push');
const { withTenant, withAdmin } = require('../config/database');
const ApiError = require('../utils/ApiError');

const MAX_PER_USER = 8;
let ready = null;

function configure() {
  if (ready !== null) return ready;
  const pub = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const priv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  if (!pub || !priv) { ready = false; return ready; }
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:support@kaunta.co.ke', pub, priv);
    ready = true;
  } catch (err) {
    console.error('Web push keys are not valid:', err.message);
    ready = false;
  }
  return ready;
}

const publicKey = () => (configure() ? process.env.VAPID_PUBLIC_KEY.trim() : null);

/** Saves this device for the signed-in person. subscription = PushSubscription.toJSON() from the browser. */
async function subscribe(tenantId, user, subscription, userAgent) {
  if (!configure()) throw new ApiError(503, 'Phone alerts are not switched on yet.', undefined, 'push_not_configured');
  const endpoint = subscription && subscription.endpoint;
  const keys = (subscription && subscription.keys) || {};
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 1000
      || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || keys.p256dh.length > 200 || keys.auth.length > 100) {
    throw ApiError.unprocessable('That device could not be registered for alerts', undefined, 'invalid_subscription');
  }
  await withAdmin(async (db) => {
    // a device belongs to one signed-in person at a time: drop it from any other shop or user first
    await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND (tenant_id <> $2 OR user_id <> $3)', [endpoint, tenantId, user.id]);
    await db.query(
      `INSERT INTO push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
      [tenantId, user.id, endpoint, keys.p256dh, keys.auth, String(userAgent || '').slice(0, 300)]
    );
    // keep only the newest few devices per person
    await db.query(
      `DELETE FROM push_subscriptions WHERE id IN (
         SELECT id FROM push_subscriptions WHERE tenant_id = $1 AND user_id = $2
          ORDER BY created_at DESC OFFSET $3)`,
      [tenantId, user.id, MAX_PER_USER]
    );
  }, { tenantId });
}

async function unsubscribe(tenantId, user, endpoint) {
  if (typeof endpoint !== 'string') return;
  await withTenant(tenantId, (db) => db.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, user.id]));
}

async function isSubscribed(tenantId, user, endpoint) {
  if (typeof endpoint !== 'string') return false;
  const { rows } = await withTenant(tenantId, (db) => db.query('SELECT 1 FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, user.id]));
  return rows.length > 0;
}

/**
 * Tells every device of this shop's staff about a new chat message. Fire and forget: a failed alert must
 * never fail the shopper's message, so errors are only logged. Dead devices (browser says gone) are removed.
 */
async function notifyShop(tenantId, { threadId, name, preview }) {
  try {
    if (!configure()) return;
    const { rows: subs } = await withTenant(tenantId, (db) => db.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions'));
    if (!subs.length) return;
    const payload = JSON.stringify({
      title: String(name || 'New message').slice(0, 60),
      body: String(preview || '').replace(/\s+/g, ' ').slice(0, 110),
      tag: `chat-${threadId}`,
      url: `/chat.html?open=${threadId}`,
    });
    const dead = [];
    await Promise.all(subs.map((s) =>
      webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400, urgency: 'high' })
        .catch((err) => {
          if (err && (err.statusCode === 404 || err.statusCode === 410)) dead.push(s.id);
          else console.error('Push send failed:', err && (err.statusCode || err.message));
        })
    ));
    if (dead.length) await withTenant(tenantId, (db) => db.query('DELETE FROM push_subscriptions WHERE id = ANY($1::uuid[])', [dead]));
  } catch (err) {
    console.error('notifyShop failed:', err.message);
  }
}

module.exports = { configure, publicKey, subscribe, unsubscribe, isSubscribed, notifyShop };
