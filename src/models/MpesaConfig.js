'use strict';

const BaseModel = require('./BaseModel');

/**
 * Per-tenant M-Pesa credentials. Columns ending in _enc hold values ENCRYPTED by the app
 * (encrypt before create/update, decrypt only where the Daraja call is made).
 */
class MpesaConfig extends BaseModel {
  static table = 'mpesa_configs';
  static columns = [
    'branch_id', 'label', 'provider', 'environment', 'shortcode', 'shortcode_type',
    'consumer_key_enc', 'consumer_secret_enc', 'passkey_enc', 'initiator_name',
    'initiator_credential_enc', 'provider_settings', 'c2b_registered_at', 'is_default', 'is_active',
  ];
  static jsonColumns = ['provider_settings'];
  static defaultOrder = 'is_default DESC, label ASC';

  /** The config to use for a branch: its own, else the tenant default, else any active one. */
  static async forBranch(db, branchId) {
    const { rows } = await db.query(
      `SELECT * FROM mpesa_configs
        WHERE is_active AND (branch_id = $1 OR branch_id IS NULL)
        ORDER BY (branch_id = $1) DESC NULLS LAST, is_default DESC
        LIMIT 1`,
      [branchId]
    );
    return rows[0] || null;
  }

  static async getDefault(db) {
    const { rows } = await db.query(
      'SELECT * FROM mpesa_configs WHERE is_active ORDER BY is_default DESC, created_at ASC LIMIT 1'
    );
    return rows[0] || null;
  }

  static async setDefault(db, id) {
    await db.query('UPDATE mpesa_configs SET is_default = false WHERE id <> $1', [id]);
    const { rows } = await db.query('UPDATE mpesa_configs SET is_default = true WHERE id = $1 RETURNING *', [id]);
    return rows[0] || null;
  }

  /**
   * Webhook entry point (Safaricom sends no auth): callback token from the URL -> tenant + config.
   * Run on a db WITHOUT tenant context; then continue inside withTenant(tenant_id).
   */
  static async resolveCallback(db, token) {
    const { rows } = await db.query('SELECT * FROM resolve_mpesa_callback($1)', [token]);
    return rows[0] || null;
  }

  /** Safe for API responses: secrets removed. */
  static sanitize(config) {
    if (!config) return null;
    const {
      consumer_key_enc, consumer_secret_enc, passkey_enc, initiator_credential_enc, ...rest
    } = config;
    return {
      ...rest,
      has_consumer_key: Boolean(consumer_key_enc),
      has_consumer_secret: Boolean(consumer_secret_enc),
      has_passkey: Boolean(passkey_enc),
    };
  }
}

module.exports = MpesaConfig;
