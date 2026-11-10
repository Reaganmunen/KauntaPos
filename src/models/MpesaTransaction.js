'use strict';

const BaseModel = require('./BaseModel');

/** STK Push requests and C2B payments to a till / paybill. */
class MpesaTransaction extends BaseModel {
  static table = 'mpesa_transactions';
  static columns = [
    'config_id', 'direction', 'status', 'sale_id', 'phone', 'amount', 'account_reference',
    'bill_ref_number', 'transaction_desc', 'merchant_request_id', 'checkout_request_id',
    'mpesa_receipt', 'transaction_time', 'payer_name', 'result_code', 'result_desc',
    'request_payload', 'callback_payload', 'initiated_by',
  ];
  static jsonColumns = ['request_payload', 'callback_payload'];

  static async findByCheckoutRequestId(db, configId, checkoutRequestId) {
    const { rows } = await db.query(
      'SELECT * FROM mpesa_transactions WHERE config_id = $1 AND checkout_request_id = $2 LIMIT 1',
      [configId, checkoutRequestId]
    );
    return rows[0] || null;
  }

  static async findByReceipt(db, receipt) {
    return this.findOne(db, { mpesa_receipt: receipt });
  }

  /**
   * Applies a callback result to a pending STK Push. Only a PENDING row can be settled, so
   * Safaricom's retried callbacks never apply twice. Returns null for a duplicate.
   */
  static async settleStk(db, id, { status, result_code, result_desc, mpesa_receipt, transaction_time, callback_payload }) {
    const { rows } = await db.query(
      `UPDATE mpesa_transactions
          SET status = $2, result_code = $3, result_desc = $4, mpesa_receipt = $5,
              transaction_time = $6, callback_payload = $7::jsonb
        WHERE id = $1 AND status = 'pending'
        RETURNING *`,
      [
        id, status, result_code ?? null, result_desc || null, mpesa_receipt || null,
        transaction_time || null, callback_payload ? JSON.stringify(callback_payload) : null,
      ]
    );
    return rows[0] || null;
  }

  /**
   * Stores a C2B payment (customer paid to the till/paybill). Safe to call twice: the unique
   * receipt index means a duplicate callback returns null instead of creating a second row.
   */
  static async recordC2b(db, data) {
    const { rows } = await db.query(
      `INSERT INTO mpesa_transactions
         (tenant_id, config_id, direction, status, phone, amount, bill_ref_number, mpesa_receipt,
          transaction_time, payer_name, callback_payload)
       VALUES (current_tenant_id(), $1, 'c2b', 'success', $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (tenant_id, mpesa_receipt) WHERE mpesa_receipt IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        data.config_id, data.phone || null, data.amount, data.bill_ref_number || null,
        data.mpesa_receipt, data.transaction_time || null, data.payer_name || null,
        data.callback_payload ? JSON.stringify(data.callback_payload) : null,
      ]
    );
    return rows[0] || null;
  }

  /** Successful payments not yet linked to a sale: staff can claim them at the till. */
  static async unmatched(db, { limit = 50 } = {}) {
    const { rows } = await db.query(
      `SELECT * FROM mpesa_transactions
        WHERE sale_id IS NULL AND status = 'success'
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit]
    );
    return rows;
  }

  /** Links an unmatched payment to a sale. Fails (null) if it was already claimed. */
  static async attachToSale(db, id, saleId) {
    const { rows } = await db.query(
      `UPDATE mpesa_transactions SET sale_id = $2 WHERE id = $1 AND sale_id IS NULL RETURNING *`,
      [id, saleId]
    );
    return rows[0] || null;
  }

  /** STK requests still pending after N minutes, for the timeout sweeper. */
  static async stalePending(db, minutes = 3) {
    const { rows } = await db.query(
      `SELECT * FROM mpesa_transactions
        WHERE status = 'pending' AND direction = 'stk_push'
          AND created_at < now() - ($1::int * interval '1 minute')`,
      [minutes]
    );
    return rows;
  }

  static async markTimeout(db, id) {
    const { rows } = await db.query(
      `UPDATE mpesa_transactions SET status = 'timeout' WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id]
    );
    return rows[0] || null;
  }

  static async forSale(db, saleId) {
    const { rows } = await db.query(
      'SELECT * FROM mpesa_transactions WHERE sale_id = $1 ORDER BY created_at DESC',
      [saleId]
    );
    return rows;
  }
}

module.exports = MpesaTransaction;
