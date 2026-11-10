'use strict';

const BaseModel = require('./BaseModel');

class AuditLog extends BaseModel {
  static table = 'audit_logs';
  static columns = ['user_id', 'action', 'entity_type', 'entity_id', 'changes', 'ip', 'user_agent'];
  static jsonColumns = ['changes'];
  static defaultOrder = 'id DESC';

  /** record(db, { user_id, action: 'product.update', entity_type: 'product', entity_id, changes, ip, user_agent }) */
  static async record(db, entry) {
    return this.create(db, entry);
  }

  static async forEntity(db, entityType, entityId, { limit = 50 } = {}) {
    const { rows } = await db.query(
      `SELECT a.*, u.full_name AS user_name
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE a.entity_type = $1 AND a.entity_id = $2
        ORDER BY a.id DESC
        LIMIT $3`,
      [entityType, entityId, limit]
    );
    return rows;
  }

  static async search(db, { user_id, action, entity_type, from, to, page = 1, limit = 50 } = {}) {
    const where = [];
    const values = [];
    const add = (sql, v) => {
      values.push(v);
      where.push(sql.replace('?', `$${values.length}`));
    };
    if (user_id) add('a.user_id = ?', user_id);
    if (action) add('a.action = ?', action);
    if (entity_type) add('a.entity_type = ?', entity_type);
    if (from) add('a.created_at >= ?::timestamptz', from);
    if (to) add('a.created_at < ?::timestamptz', to);

    return this.runPaged(db, {
      select: 'a.*, u.full_name AS user_name',
      from: 'audit_logs a LEFT JOIN users u ON u.id = a.user_id',
      where,
      values,
      order: 'a.id DESC',
      page,
      limit,
    });
  }
}

module.exports = AuditLog;
