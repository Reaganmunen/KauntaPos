'use strict';

/**
 * Feature flags per tenant. Composite primary key (tenant_id, feature_key),
 * so this model does not extend BaseModel.
 */
class TenantFeature {
  static async list(db) {
    const { rows } = await db.query('SELECT feature_key, enabled FROM tenant_features ORDER BY feature_key');
    return rows;
  }

  /** { storefront: true, restaurant: false, ... } */
  static async asMap(db) {
    const rows = await this.list(db);
    return rows.reduce((acc, r) => {
      acc[r.feature_key] = r.enabled;
      return acc;
    }, {});
  }

  static async isEnabled(db, key) {
    const { rows } = await db.query('SELECT enabled FROM tenant_features WHERE feature_key = $1', [key]);
    return rows[0] ? rows[0].enabled === true : false;
  }

  static async set(db, key, enabled) {
    const { rows } = await db.query(
      `INSERT INTO tenant_features (tenant_id, feature_key, enabled)
       VALUES (current_tenant_id(), $1, $2)
       ON CONFLICT (tenant_id, feature_key)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
       RETURNING *`,
      [key, Boolean(enabled)]
    );
    return rows[0];
  }

  static async setMany(db, map) {
    const out = [];
    for (const [key, enabled] of Object.entries(map)) {
      out.push(await this.set(db, key, enabled));
    }
    return out;
  }
}

module.exports = TenantFeature;
