'use strict';

const BaseModel = require('./BaseModel');
const entitlements = require('../utils/entitlements');

class Tenant extends BaseModel {
  static table = 'tenants';
  static tenantScoped = false;
  static columns = [
    'name', 'legal_name', 'business_type', 'kra_pin', 'vat_registered', 'email', 'phone',
    'address', 'county', 'country', 'currency', 'timezone', 'logo_url', 'plan_id', 'status',
    'trial_ends_at', 'current_period_start', 'current_period_end', 'settings',
  ];
  static jsonColumns = ['settings'];
  static filterable = ['id', 'slug', 'status', 'business_type', 'plan_id'];

  /**
   * Signup: creates tenant, subdomain, main branch, default roles/tax classes/units,
   * owner user and storefront row in one call. Use a db WITHOUT tenant context
   * (withTransaction). passwordHash must already be hashed.
   */
  static async register(db, input) {
    const { rows } = await db.query(
      'SELECT register_tenant($1, $2, $3, $4, $5, $6, $7, $8, $9) AS id',
      [
        input.slug,
        input.name,
        input.businessType || 'general',
        input.ownerName,
        input.ownerEmail || null,
        input.ownerPhone || null,
        input.passwordHash,
        input.rootDomain || process.env.ROOT_DOMAIN || 'kaunta.co.ke',
        input.trialDays ?? 14,
      ]
    );
    return rows[0].id;
  }

  /** Hostname or slug -> { tenant_id, slug, status, business_type } (no tenant context needed). */
  static async resolve(db, hostOrSlug) {
    const { rows } = await db.query('SELECT * FROM resolve_tenant($1)', [String(hostOrSlug).toLowerCase()]);
    return rows[0] || null;
  }

  /** Merges a partial object into tenants.settings. */
  static async mergeSettings(db, id, patch) {
    const { rows } = await db.query(
      'UPDATE tenants SET settings = settings || $2::jsonb WHERE id = $1 RETURNING *',
      [id, JSON.stringify(patch)]
    );
    return rows[0] || null;
  }

  static async setStatus(db, id, status) {
    return this.update(db, id, { status });
  }

  /**
   * Can this tenant make changes right now? Trial running, paid period running, or inside the grace
   * days after it. Worked out from the dates too, so a period that has ended stops counting even
   * when nobody has changed the status. See utils/entitlements.
   */
  static canOperate(tenant) {
    return entitlements.canOperate(entitlements.accessState(tenant));
  }
}

module.exports = Tenant;
