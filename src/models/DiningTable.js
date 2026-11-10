'use strict';

const BaseModel = require('./BaseModel');

class DiningTable extends BaseModel {
  static table = 'dining_tables';
  static columns = ['branch_id', 'name', 'section', 'seats', 'status', 'is_active'];
  static defaultOrder = 'section ASC NULLS LAST, name ASC';

  static async forBranch(db, branchId) {
    return this.findAll(db, { filters: { branch_id: branchId, is_active: true } });
  }

  static async setStatus(db, id, status) {
    return this.update(db, id, { status });
  }

  /** Tables with their open tab (if any): sale id, number and running total. */
  static async floorPlan(db, branchId) {
    const { rows } = await db.query(
      `SELECT t.*, s.id AS open_sale_id, s.sale_number AS open_sale_number, s.total AS open_total
         FROM dining_tables t
         LEFT JOIN sales s ON s.table_id = t.id AND s.status = 'open'
        WHERE t.branch_id = $1 AND t.is_active
        ORDER BY t.section ASC NULLS LAST, t.name ASC`,
      [branchId]
    );
    return rows;
  }
}

module.exports = DiningTable;
