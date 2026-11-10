'use strict';

const BaseModel = require('./BaseModel');

/**
 * Stock held for online orders awaiting payment. v_stock_available subtracts active
 * (unexpired) reservations from on-hand, so a held item cannot be sold twice.
 */
class StockReservation extends BaseModel {
  static table = 'stock_reservations';
  static columns = ['branch_id', 'variant_id', 'online_order_id', 'quantity', 'status', 'expires_at'];

  /** items: [{ variant_id, quantity }]; holds default to 30 minutes (checkout + STK Push window). */
  static async reserve(db, { branch_id, online_order_id, items, minutes = 30 }) {
    const out = [];
    for (const it of items) {
      const { rows } = await db.query(
        `INSERT INTO stock_reservations (tenant_id, branch_id, variant_id, online_order_id, quantity, expires_at)
         VALUES (current_tenant_id(), $1, $2, $3, $4, now() + ($5::int * interval '1 minute'))
         RETURNING *`,
        [branch_id, it.variant_id, online_order_id, it.quantity, minutes]
      );
      out.push(rows[0]);
    }
    return out;
  }

  static async forOrder(db, onlineOrderId) {
    return this.findAll(db, { filters: { online_order_id: onlineOrderId } });
  }

  /** Payment succeeded: the stock movement takes over from the reservation. */
  static async commitForOrder(db, onlineOrderId) {
    const { rows } = await db.query(
      `UPDATE stock_reservations SET status = 'committed'
        WHERE online_order_id = $1 AND status = 'active' RETURNING *`,
      [onlineOrderId]
    );
    return rows;
  }

  /** Payment failed or order cancelled: free the stock. */
  static async releaseForOrder(db, onlineOrderId) {
    const { rows } = await db.query(
      `UPDATE stock_reservations SET status = 'released'
        WHERE online_order_id = $1 AND status = 'active' RETURNING *`,
      [onlineOrderId]
    );
    return rows;
  }

  /** Housekeeping for a scheduled job: mark overdue holds as expired. */
  static async expireOverdue(db) {
    const { rowCount } = await db.query(
      `UPDATE stock_reservations SET status = 'expired' WHERE status = 'active' AND expires_at <= now()`
    );
    return rowCount;
  }
}

module.exports = StockReservation;
