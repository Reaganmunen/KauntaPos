'use strict';

const BaseModel = require('./BaseModel');

/**
 * Customer credit ("deni") ledger. Positive amount = customer owes more,
 * negative = they owe less. A database trigger keeps customers.balance in sync.
 */
class CustomerLedger extends BaseModel {
  static table = 'customer_ledger';
  static columns = ['customer_id', 'entry_type', 'amount', 'sale_id', 'payment_id', 'note', 'created_by'];
  static defaultOrder = 'created_at DESC';

  static async recordCreditSale(db, { customer_id, sale_id, amount, created_by, note }) {
    return this.create(db, {
      customer_id, sale_id, created_by, note,
      entry_type: 'credit_sale',
      amount: Math.abs(amount),
    });
  }

  /** Customer pays off (part of) what they owe. */
  static async recordPayment(db, { customer_id, payment_id, amount, created_by, note }) {
    return this.create(db, {
      customer_id, payment_id, created_by, note,
      entry_type: 'payment',
      amount: -Math.abs(amount),
    });
  }

  /** Credit note against a credit sale reduces the debt. */
  static async recordRefund(db, { customer_id, sale_id, amount, created_by, note }) {
    return this.create(db, {
      customer_id, sale_id, created_by, note,
      entry_type: 'refund',
      amount: -Math.abs(amount),
    });
  }

  static async recordAdjustment(db, { customer_id, amount, created_by, note }) {
    return this.create(db, { customer_id, amount, created_by, note, entry_type: 'adjustment' });
  }

  /** Statement with a running balance (oldest first). */
  static async statement(db, customerId, { limit = 200 } = {}) {
    const { rows } = await db.query(
      `SELECT l.*, s.sale_number,
              SUM(l.amount) OVER (ORDER BY l.created_at, l.id) AS running_balance
         FROM customer_ledger l
         LEFT JOIN sales s ON s.id = l.sale_id
        WHERE l.customer_id = $1
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT $2`,
      [customerId, limit]
    );
    return rows;
  }
}

module.exports = CustomerLedger;
