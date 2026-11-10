'use strict';

const BaseModel = require('./BaseModel');

class Customer extends BaseModel {
  static table = 'customers';
  static softDelete = true;
  // balance is NOT writable: it is maintained by customer_ledger entries (database trigger)
  static columns = [
    'name', 'phone', 'email', 'kra_pin', 'address', 'price_list_id',
    'credit_limit', 'loyalty_points', 'notes', 'is_active',
  ];
  static defaultOrder = 'name ASC';

  static async findByPhone(db, phone) {
    return this.findOne(db, { phone });
  }

  static async search(db, { q, only_owing = false, page = 1, limit = 25 } = {}) {
    const where = ['deleted_at IS NULL'];
    const values = [];
    if (q) {
      values.push(this.like(q));
      where.push(`(name ILIKE $${values.length} OR phone ILIKE $${values.length})`);
    }
    if (only_owing) where.push('balance > 0');
    return this.runPaged(db, {
      select: '*',
      from: 'customers',
      where,
      values,
      order: 'name ASC',
      page,
      limit,
    });
  }

  /** Can this customer take `amount` more on credit? */
  static canExtendCredit(customer, amount) {
    if (!customer) return false;
    return Number(customer.balance) + Number(amount) <= Number(customer.credit_limit);
  }

  static async totalOwed(db) {
    const { rows } = await db.query(
      'SELECT COALESCE(SUM(balance), 0) AS total FROM customers WHERE balance > 0 AND deleted_at IS NULL'
    );
    return rows[0].total;
  }
}

module.exports = Customer;
