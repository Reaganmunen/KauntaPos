'use strict';

const BaseModel = require('./BaseModel');

/** Money received against a sale (on a credit note: money paid out). */
class Payment extends BaseModel {
  static table = 'payments';
  static columns = [
    'sale_id', 'client_uuid', 'method', 'amount', 'tendered', 'change_given', 'reference',
    'mpesa_transaction_id', 'status', 'shift_id', 'received_by', 'paid_at',
  ];
  static defaultOrder = 'paid_at DESC';

  static async findByClientUuid(db, clientUuid) {
    return this.findOne(db, { client_uuid: clientUuid });
  }

  static async forSale(db, saleId) {
    const { rows } = await db.query('SELECT * FROM payments WHERE sale_id = $1 ORDER BY paid_at', [saleId]);
    return rows;
  }

  static async markReversed(db, id) {
    const { rows } = await db.query(
      `UPDATE payments SET status = 'reversed' WHERE id = $1 AND status = 'completed' RETURNING *`,
      [id]
    );
    return rows[0] || null;
  }
}

module.exports = Payment;
