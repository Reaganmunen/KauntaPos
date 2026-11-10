'use strict';

const BaseModel = require('./BaseModel');

class User extends BaseModel {
  static table = 'users';
  static columns = [
    'email', 'phone', 'full_name', 'password_hash', 'pin_hash', 'role_id',
    'is_owner', 'all_branches', 'is_active', 'last_login_at',
  ];
  static defaultOrder = 'full_name ASC';

  /** Login lookup by email or phone, with role name and permissions. */
  static async findByIdentifier(db, identifier) {
    const { rows } = await db.query(
      `SELECT u.*, r.name AS role_name, r.permissions
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE (u.email = $1 OR u.phone = $2) AND u.is_active
        LIMIT 1`,
      [identifier, identifier]
    );
    return rows[0] || null;
  }

  static async findWithRole(db, id) {
    const { rows } = await db.query(
      `SELECT u.*, r.name AS role_name, r.permissions
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1`,
      [id]
    );
    return rows[0] || null;
  }

  static async search(db, { q, role_id, is_active, page = 1, limit = 25 } = {}) {
    const where = [];
    const values = [];
    if (q) {
      values.push(this.like(q));
      where.push(`(u.full_name ILIKE $${values.length} OR u.email ILIKE $${values.length} OR u.phone ILIKE $${values.length})`);
    }
    if (role_id) {
      values.push(role_id);
      where.push(`u.role_id = $${values.length}`);
    }
    if (is_active !== undefined && is_active !== null) {
      values.push(Boolean(is_active));
      where.push(`u.is_active = $${values.length}`);
    }
    return this.runPaged(db, {
      select: 'u.*, r.name AS role_name',
      from: 'users u LEFT JOIN roles r ON r.id = u.role_id',
      where,
      values,
      order: 'u.full_name ASC',
      page,
      limit,
    });
  }

  static async touchLogin(db, id) {
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
  }

  static async countActive(db) {
    const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM users WHERE is_active');
    return rows[0].count;
  }

  static async getBranchIds(db, userId) {
    const { rows } = await db.query('SELECT branch_id FROM user_branches WHERE user_id = $1', [userId]);
    return rows.map((r) => r.branch_id);
  }

  /** Replaces the user's branch assignments. */
  static async setBranches(db, userId, branchIds = []) {
    await db.query('DELETE FROM user_branches WHERE user_id = $1', [userId]);
    if (!branchIds.length) return [];
    await db.query(
      `INSERT INTO user_branches (tenant_id, user_id, branch_id)
       SELECT current_tenant_id(), $1::uuid, b FROM UNNEST($2::uuid[]) AS b`,
      [userId, branchIds]
    );
    return branchIds;
  }

  /** Never send password or PIN hashes to the client. */
  static sanitize(user) {
    if (!user) return null;
    const { password_hash, pin_hash, ...rest } = user;
    return rest;
  }
}

module.exports = User;
