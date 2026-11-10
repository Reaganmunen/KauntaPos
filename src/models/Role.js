'use strict';

const BaseModel = require('./BaseModel');

class Role extends BaseModel {
  static table = 'roles';
  static columns = ['name', 'description', 'permissions'];   // permissions is text[] (plain JS array)
  static defaultOrder = 'is_system DESC, name ASC';

  static async findByName(db, name) {
    return this.findOne(db, { name });
  }

  /** System roles (Owner, Manager, ...) cannot be deleted. */
  static async remove(db, id) {
    const { rows } = await db.query('DELETE FROM roles WHERE id = $1 AND is_system = false RETURNING *', [id]);
    return rows[0] || null;
  }

  /**
   * '*' grants everything; 'pos.*' grants every 'pos.xxx'; otherwise exact match.
   */
  static hasPermission(permissions = [], needed) {
    if (!Array.isArray(permissions)) return false;
    if (permissions.includes('*') || permissions.includes(needed)) return true;
    const group = String(needed).split('.')[0];
    return permissions.includes(`${group}.*`);
  }
}

module.exports = Role;
