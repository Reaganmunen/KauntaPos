'use strict';

const crypto = require('crypto');
const BaseModel = require('./BaseModel');

class TenantDomain extends BaseModel {
  static table = 'tenant_domains';
  static columns = ['domain', 'kind', 'is_primary', 'verification_token', 'verified_at'];
  static defaultOrder = 'is_primary DESC, created_at ASC';

  /** Adds a custom domain (unverified) with a token the tenant must publish in DNS. */
  static async addCustom(db, domain) {
    return this.create(db, {
      domain: String(domain).trim().toLowerCase(),
      kind: 'custom',
      is_primary: false,
      verification_token: crypto.randomBytes(16).toString('hex'),
    });
  }

  static async markVerified(db, id) {
    return this.update(db, id, { verified_at: new Date() });
  }

  static async setPrimary(db, id) {
    await db.query('UPDATE tenant_domains SET is_primary = false WHERE is_primary = true AND id <> $1', [id]);
    const { rows } = await db.query(
      'UPDATE tenant_domains SET is_primary = true WHERE id = $1 AND verified_at IS NOT NULL RETURNING *',
      [id]
    );
    return rows[0] || null;
  }
}

module.exports = TenantDomain;
