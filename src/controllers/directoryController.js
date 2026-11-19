'use strict';

/**
 * Public shop directory: every shop whose online store is live, so shoppers can browse without
 * logging in. A shop is listed only when ALL of these hold:
 *   - its store is published and has a branch that fulfils orders
 *   - its subscription lets it operate (trial, paid, or grace) and the storefront module is on
 *     and included in its plan (the same rules as the public store itself, utils/entitlements)
 *   - it has not opted out: PATCH /tenant/settings { "hide_from_directory": true }
 *
 * Only public branding is returned: name, tagline, logo, kind of business and county. No phone,
 * email or street address. Reads on the admin connection (the list spans every tenant, which tenant
 * row-level security does not allow) and is cached briefly.
 *
 *   GET /directory?q=&type=&county=&limit=
 */
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/respond');
const { withAdmin } = require('../config/database');
const { accessState, canOperate, planAllows } = require('../utils/entitlements');

const TTL_MS = parseInt(process.env.DIRECTORY_CACHE_MS || '60000', 10);
let cache = { at: 0, rows: [] };

async function loadShops() {
  if (cache.rows.length && Date.now() - cache.at < TTL_MS) return cache.rows;
  const { rows } = await withAdmin((db) =>
    db.query(
      `SELECT t.slug, t.name, t.business_type, t.county, t.status, t.trial_ends_at, t.current_period_end,
              s.store_name, s.tagline, s.logo_url,
              pl.features AS plan_features
         FROM tenants t
         JOIN storefront_settings s ON s.tenant_id = t.id
         JOIN tenant_features f ON f.tenant_id = t.id AND f.feature_key = 'storefront' AND f.enabled
         LEFT JOIN plans pl ON pl.id = t.plan_id
        WHERE s.is_published AND s.fulfilment_branch_id IS NOT NULL
          AND t.status IN ('trial', 'active', 'past_due')
          AND COALESCE(t.settings ->> 'hide_from_directory', 'false') <> 'true'
        ORDER BY COALESCE(NULLIF(s.store_name, ''), t.name)
        LIMIT 1000`
    )
  );
  const shops = rows
    .filter((r) => canOperate(accessState(r)) && planAllows({ features: r.plan_features }, 'storefront'))
    .map((r) => ({
      slug: r.slug,
      name: r.store_name || r.name,
      tagline: r.tagline || null,
      logo_url: r.logo_url || null,
      business_type: r.business_type || 'general',
      county: r.county || null,
    }));
  cache = { at: Date.now(), rows: shops };
  return shops;
}

exports.list = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 60);
  const type = String(req.query.type || '').trim().toLowerCase();
  const county = String(req.query.county || '').trim().toLowerCase();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 60, 1), 200);

  let shops = await loadShops();
  const types = [...new Set(shops.map((s) => s.business_type))].sort();
  const counties = [...new Set(shops.map((s) => s.county).filter(Boolean))].sort();

  if (type) shops = shops.filter((s) => s.business_type === type);
  if (county) shops = shops.filter((s) => (s.county || '').toLowerCase() === county);
  if (q) shops = shops.filter((s) => `${s.name} ${s.tagline || ''} ${s.county || ''}`.toLowerCase().includes(q));

  res.setHeader('Cache-Control', 'public, max-age=30');
  return ok(res, shops.slice(0, limit), { total: shops.length, types, counties });
});
