'use strict';

const { lookupTenant } = require('./tenant');

/**
 * CORS options for the `cors` package. The API is called from:
 *   - the dashboard / POS app (app.kaunta.co.ke, localhost while developing)
 *   - every shop's storefront on its own subdomain or verified custom domain
 * so the check is: configured origins, anything under ROOT_DOMAIN, localhost outside production,
 * or any host that resolves to a real shop. Requests with no Origin (mobile apps, Safaricom
 * webhooks, curl) are not browser requests and are let through.
 *
 *   CORS_ORIGINS   optional comma-separated extra origins, e.g. https://app.kaunta.co.ke
 */
const root = () => (process.env.ROOT_DOMAIN || 'kaunta.co.ke').toLowerCase();
const extraOrigins = () =>
  (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

async function isAllowedOrigin(origin) {
  if (!origin) return true;
  let url;
  try {
    url = new URL(origin);
  } catch (err) {
    return false;
  }
  const host = url.hostname.toLowerCase();

  if (extraOrigins().includes(origin.toLowerCase())) return true;
  if (host === root() || host.endsWith(`.${root()}`)) return true;
  if (process.env.NODE_ENV !== 'production' && (host === 'localhost' || host === '127.0.0.1')) return true;
  return Boolean(await lookupTenant(host)); // a shop's verified custom domain
}

const corsOptions = {
  origin(origin, callback) {
    isAllowedOrigin(origin).then(
      (allowed) => callback(null, allowed),
      (err) => callback(err)
    );
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Branch-Id', 'X-Cart-Token', 'X-Tenant', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id', 'X-Subscription-Status', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
  maxAge: 600,
};

module.exports = { corsOptions };
