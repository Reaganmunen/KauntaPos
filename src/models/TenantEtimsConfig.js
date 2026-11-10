'use strict';

const BaseModel = require('./BaseModel');

/** One eTIMS (Digitax) connection per tenant. api_key_enc is encrypted by the app. */
class TenantEtimsConfig extends BaseModel {
  static table = 'tenant_etims_config';
  static columns = [
    'provider', 'environment', 'api_key_enc', 'provider_business_id', 'auto_submit',
    'is_active', 'last_verified_at',
  ];

  static async get(db) {
    const { rows } = await db.query('SELECT * FROM tenant_etims_config LIMIT 1');
    return rows[0] || null;
  }

  /** Create or update the tenant's single config row. */
  static async save(db, data) {
    const existing = await this.get(db);
    return existing ? this.update(db, existing.id, data) : this.create(db, data);
  }

  static async isActive(db) {
    const config = await this.get(db);
    return Boolean(config && config.is_active && config.api_key_enc);
  }

  static async markVerified(db, id) {
    return this.update(db, id, { last_verified_at: new Date(), is_active: true });
  }

  static sanitize(config) {
    if (!config) return null;
    const { api_key_enc, ...rest } = config;
    return { ...rest, has_api_key: Boolean(api_key_enc) };
  }
}

module.exports = TenantEtimsConfig;
