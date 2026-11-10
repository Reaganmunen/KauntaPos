'use strict';

const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { withTransaction } = require('../config/database');
const { Tenant } = require('../models');
const { getTenantContext } = require('../utils/contextCache');

/**
 * Works out WHICH SHOP a request is for when there is no login token yet:
 *   - the storefront (acme.kaunta.co.ke, or a verified custom domain)
 *   - login / forgot password (the shop comes from the host, X-Tenant header or body.shop)
 * Logged-in requests take the shop from the JWT instead (see auth.js).
 *
 * Needs ROOT_DOMAIN (default kaunta.co.ke) and, behind a proxy/load balancer, app.set('trust proxy', ...)
 * so that req.hostname is the public host.
 */
const POSITIVE_TTL_MS = 60000;
const NEGATIVE_TTL_MS = 15000;
const cache = new Map(); // key -> { value, expires }

const rootDomain = () => (process.env.ROOT_DOMAIN || 'kaunta.co.ke').toLowerCase();

/** Hosts that belong to Kaunta itself, not to a shop. */
function isPlatformHost(host) {
  const root = rootDomain();
  return (
    host === root ||
    host === `www.${root}` ||
    host === `app.${root}` ||
    host === `api.${root}` ||
    host === `admin.${root}` ||
    host === 'localhost' ||
    host.startsWith('[') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  );
}

/** host or slug -> { tenant_id, slug, status, business_type } | null, cached briefly. */
async function lookupTenant(hostOrSlug) {
  const key = String(hostOrSlug).toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const value = await withTransaction((db) => Tenant.resolve(db, key));
  if (cache.size > 5000) cache.clear();
  cache.set(key, { value, expires: Date.now() + (value ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
  return value;
}

/**
 * Sets req.tenantId / req.tenantSlug when the shop can be determined.
 *   required       404/400 if no shop can be determined (storefront routes)
 *   blockInactive  404 when the shop is suspended, cancelled or its trial has ended (public store)
 */
function resolveTenant({ required = false, blockInactive = false } = {}) {
  return asyncHandler(async (req, res, next) => {
    if (!req.tenantId) {
      const host = (req.hostname || '').toLowerCase();
      let key = null;
      if (host && !isPlatformHost(host)) key = host;
      else if (req.get('x-tenant')) key = req.get('x-tenant').trim().toLowerCase();

      if (key) {
        if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(key)) throw ApiError.badRequest('Invalid shop');
        const tenant = await lookupTenant(key);
        if (tenant) {
          req.tenantId = tenant.tenant_id;
          req.tenantSlug = tenant.slug;
        }
      }
    }

    if (required && !req.tenantId) {
      throw ApiError.notFound('Shop not found', undefined, 'shop_not_found');
    }

    if (blockInactive && req.tenantId) {
      const ctx = await getTenantContext(req.tenantId);
      if (!ctx || !Tenant.canOperate(ctx)) {
        throw ApiError.notFound('This store is not available right now', undefined, 'store_unavailable');
      }
      req.tenantCtx = ctx;
    }
    next();
  });
}

module.exports = { resolveTenant, lookupTenant, isPlatformHost };
