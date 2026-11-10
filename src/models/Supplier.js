'use strict';

const BaseModel = require('./BaseModel');

class Supplier extends BaseModel {
  static table = 'suppliers';
  static columns = [
    'name', 'contact_person', 'phone', 'email', 'kra_pin', 'address',
    'payment_terms_days', 'notes', 'is_active',
  ];
  static defaultOrder = 'name ASC';

  static async search(db, { q, is_active, page = 1, limit = 25 } = {}) {
    const where = [];
    const values = [];
    if (q) {
      values.push(this.like(q));
      where.push(`(name ILIKE $${values.length} OR phone ILIKE $${values.length} OR contact_person ILIKE $${values.length})`);
    }
    if (is_active !== undefined && is_active !== null) {
      values.push(Boolean(is_active));
      where.push(`is_active = $${values.length}`);
    }
    return this.runPaged(db, { select: '*', from: 'suppliers', where, values, order: 'name ASC', page, limit });
  }

  /** What we still owe a supplier, from unpaid / part-paid purchase orders. */
  static async outstanding(db, supplierId) {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(total - amount_paid), 0) AS owed
         FROM purchase_orders
        WHERE supplier_id = $1 AND status <> 'cancelled' AND payment_status <> 'paid'`,
      [supplierId]
    );
    return rows[0].owed;
  }
}

module.exports = Supplier;
