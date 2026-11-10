'use strict';

const BaseModel = require('./BaseModel');

class Branch extends BaseModel {
  static table = 'branches';
  static columns = ['code', 'name', 'phone', 'address', 'county', 'is_main', 'is_active', 'etims_branch_id'];
  static defaultOrder = 'is_main DESC, name ASC';

  static async listActive(db) {
    return this.findAll(db, { filters: { is_active: true } });
  }

  static async getMain(db) {
    return this.findOne(db, { is_main: true });
  }

  /** Makes this branch the main one (the unique index allows only one). */
  static async setMain(db, id) {
    await db.query('UPDATE branches SET is_main = false WHERE is_main = true AND id <> $1', [id]);
    const { rows } = await db.query('UPDATE branches SET is_main = true WHERE id = $1 RETURNING *', [id]);
    return rows[0] || null;
  }

  /** Branches a user may work in: everything for owners / all_branches users, else their assignments. */
  static async listForUser(db, user) {
    if (user.is_owner || user.all_branches) return this.listActive(db);
    const { rows } = await db.query(
      `SELECT b.*
         FROM branches b
         JOIN user_branches ub ON ub.branch_id = b.id
        WHERE ub.user_id = $1 AND b.is_active
        ORDER BY b.is_main DESC, b.name ASC`,
      [user.id]
    );
    return rows;
  }
}

module.exports = Branch;
