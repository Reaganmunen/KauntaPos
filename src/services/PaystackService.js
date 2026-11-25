'use strict';

/**
 * Paystack for Kaunta subscriptions. Shops pay Kaunta (YOUR Paystack account, set by
 * PAYSTACK_SECRET_KEY); Paystack takes M-Pesa or card, then tells us two ways:
 *   1. the shop is sent back to /renew.html?reference=...  -> GET /tenant/subscription/paystack/verify
 *   2. Paystack calls POST /api/hooks/paystack (charge.success)    -> the safety net if the browser never returns
 * Both end in settle(), which asks Paystack itself whether the money arrived (never trusts the
 * browser or the webhook body), checks amount and currency, and activates the shop once.
 *
 *   PAYSTACK_SECRET_KEY    sk_test_... or sk_live_...   (required)
 *   PAYSTACK_CALLBACK_URL  optional full URL the shop returns to; default <this host>/renew.html
 */
const crypto = require('crypto');
const { withAdmin } = require('../config/database');
const { SubscriptionPayment } = require('../models');
const { invalidateTenant } = require('../utils/contextCache');
const { periodDays } = require('../utils/entitlements');

const API = 'https://api.paystack.co';
const YEAR_DAYS = 365;

const secret = () => (process.env.PAYSTACK_SECRET_KEY || '').trim();
const isConfigured = () => /^sk_(test|live)_/.test(secret());

const log = (level, msg, extra) =>
  console[level === 'error' ? 'error' : 'log'](JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  let json = null;
  try { json = await res.json(); } catch (err) { /* not JSON */ }
  if (!res.ok || !json || json.status !== true) {
    const e = new Error((json && json.message) || `Paystack error ${res.status}`);
    e.paystackStatus = res.status;
    throw e;
  }
  return json.data;
}

const toSubunit = (amount) => Math.round(Number(amount) * 100);
const toDate = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const daysFor = (cycle) => (cycle === 'yearly' ? YEAR_DAYS : periodDays());

function newReference(tenantId) {
  return `KNT-${tenantId.slice(0, 8)}-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`.toUpperCase();
}

/** Starts a checkout. Returns { authorization_url, access_code, reference }. */
function initialize({ email, amount, currency, reference, callbackUrl, metadata }) {
  return call('POST', '/transaction/initialize', {
    email,
    amount: toSubunit(amount),
    currency,
    reference,
    callback_url: callbackUrl,
    metadata,
  });
}

const verifyTransaction = (reference) => call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);

/** HMAC-SHA512 of the RAW request body with the secret key, compared in constant time. */
function validSignature(rawBody, signature) {
  if (!rawBody || !signature || !isConfigured()) return false;
  const expected = crypto.createHmac('sha512', secret()).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Confirms a payment by its Paystack reference. Safe to call many times and from the webhook and the
 * browser at once: the row is locked and a payment that is already confirmed is returned untouched.
 *   { result: 'unknown' }                  not one of ours
 *   { result: 'confirmed', payment }       paid and the shop is active (now or already)
 *   { result: 'pending' }                  customer has not finished paying yet
 *   { result: 'failed' }                   Paystack says the charge failed
 *   { result: 'mismatch' }                 paid, but amount/currency is not what we asked for: NOT activated
 */
async function settle(reference) {
  const row = await withAdmin(async (db) => {
    const { rows } = await db.query('SELECT * FROM subscription_payments WHERE paystack_reference = $1', [reference]);
    return rows[0] || null;
  });
  if (!row) return { result: 'unknown' };
  if (row.status === 'confirmed') return { result: 'confirmed', payment: row };

  const tx = await verifyTransaction(reference);

  if (tx.status === 'failed' || tx.status === 'reversed') {
    await withAdmin(
      (db) => db.query("UPDATE subscription_payments SET status = 'failed', notes = COALESCE(notes, $2) WHERE id = $1 AND status = 'pending'", [row.id, String(tx.gateway_response || tx.status).slice(0, 200)]),
      { tenantId: row.tenant_id }
    );
    return { result: 'failed' };
  }
  if (tx.status !== 'success') return { result: 'pending' };

  const expectedCurrency = (row.currency || process.env.PAYSTACK_CURRENCY || 'KES').toUpperCase();
  if (Number(tx.amount) !== toSubunit(row.amount) || String(tx.currency).toUpperCase() !== expectedCurrency) {
    log('error', 'paystack amount mismatch, not activating', { reference, paid: tx.amount, currency: tx.currency, expected: toSubunit(row.amount) });
    return { result: 'mismatch' };
  }

  const payment = await withAdmin(
    async (db) => {
      const { rows: [p] } = await db.query('SELECT * FROM subscription_payments WHERE id = $1 FOR UPDATE', [row.id]);
      if (p.status === 'confirmed') return p;

      const { rows: [tenant] } = await db.query('SELECT current_period_end FROM tenants WHERE id = $1', [p.tenant_id]);
      const today = toDate(new Date());
      const currentEnd = tenant && tenant.current_period_end ? toDate(tenant.current_period_end) : null;
      const start = currentEnd && currentEnd > today ? currentEnd : today; // renewing early extends, never loses days
      const end = addDays(start, daysFor(p.billing_cycle));

      await db.query(
        `UPDATE subscription_payments
            SET period_start = $2, period_end = $3, channel = $4, paid_at = $5,
                reference = COALESCE(reference, $6)
          WHERE id = $1`,
        [p.id, start, end, tx.channel || null, tx.paid_at || new Date(), String(tx.id || '')]
      );
      return SubscriptionPayment.confirmAndActivate(db, p.id, null);
    },
    { tenantId: row.tenant_id }
  );
  invalidateTenant(row.tenant_id); // the shop is unlocked right away
  return { result: 'confirmed', payment };
}

module.exports = { isConfigured, newReference, initialize, verifyTransaction, validSignature, settle };
