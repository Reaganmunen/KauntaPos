'use strict';

const BaseModel = require('./BaseModel');

class PlatformAdmin extends BaseModel {
  static table = 'platform_admins';
  static tenantScoped = false;
  static columns = ['email', 'full_name', 'password_hash', 'is_active', 'last_login_at'];
  static filterable = ['id', 'email', 'is_active'];

  static async findByEmail(db, email) {
    const { rows } = await db.query(
      'SELECT * FROM platform_admins WHERE email = $1 AND is_active = true LIMIT 1',
      [email]
    );
    return rows[0] || null;
  }

  static async touchLogin(db, id) {
    await db.query('UPDATE platform_admins SET last_login_at = now() WHERE id = $1', [id]);
  }

  static sanitize(admin) {
    if (!admin) return null;
    const { password_hash, ...rest } = admin;
    return rest;
  }
}

module.exports = PlatformAdmin;
