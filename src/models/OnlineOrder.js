'use strict';

const BaseModel = require('./BaseModel');

/**
 * Fulfilment details for an online order. The order itself is a normal sale
 * (channel = 'online'), so stock, M-Pesa and eTIMS behave exactly like in-store sales.
 */
class OnlineOrder extends BaseModel {
  static table = 'online_orders';
  static columns = [
    'sale_id', 'branch_id', 'customer_name', 'customer_phone', 'customer_email',
    'fulfilment_type', 'delivery_zone_id', 'delivery_address', 'delivery_notes', 'delivery_fee',
    'customer_note', 'fulfilment_status', 'paid_at', 'completed_at', 'cancelled_at', 'cancel_reason',
  ];

  static async findBySaleId(db, saleId) {
    return this.findOne(db, { sale_id: saleId });
  }

  /** Public order tracking by token (no login), with a customer-safe view of the sale. */
  static async findByTrackingToken(db, token) {
    const { rows } = await db.query(
      `SELECT o.id, o.tracking_token, o.fulfilment_type, o.fulfilment_status, o.delivery_address,
              o.delivery_fee, o.customer_name, o.created_at, o.paid_at, o.completed_at,
              s.id AS sale_id, s.sale_number, s.total, s.payment_status
         FROM online_orders o
         JOIN sales s ON s.id = o.sale_id
        WHERE o.tracking_token = $1`,
      [token]
    );
    if (!rows[0]) return null;
    const items = await db.query(
      'SELECT product_name, variant_name, quantity, unit_price, line_total FROM sale_items WHERE sale_id = $1 ORDER BY line_no',
      [rows[0].sale_id]
    );
    return { ...rows[0], items: items.rows };
  }

  static async list(db, { status, branch_id, q, page = 1, limit = 25 } = {}) {
    const where = [];
    const values = [];
    const add = (sql, v) => {
      values.push(v);
      where.push(sql.replace('?', `$${values.length}`));
    };
    if (status) add('o.fulfilment_status = ?', status);
    if (branch_id) add('o.branch_id = ?', branch_id);
    if (q) {
      values.push(this.like(q));
      where.push(`(o.customer_name ILIKE $${values.length} OR o.customer_phone ILIKE $${values.length} OR s.sale_number ILIKE $${values.length})`);
    }

    return this.runPaged(db, {
      select: 'o.*, s.sale_number, s.total, s.payment_status',
      from: 'online_orders o JOIN sales s ON s.id = o.sale_id',
      where,
      values,
      order: 'o.created_at DESC',
      page,
      limit,
    });
  }

  /** Updates fulfilment status and stamps the matching timestamp. */
  static async setStatus(db, id, status, { cancel_reason } = {}) {
    const { rows } = await db.query(
      `UPDATE online_orders
          SET fulfilment_status = $2,
              paid_at = CASE WHEN $2 = 'paid' AND paid_at IS NULL THEN now() ELSE paid_at END,
              completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END,
              cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE cancelled_at END,
              cancel_reason = CASE WHEN $2 = 'cancelled' THEN $3 ELSE cancel_reason END
        WHERE id = $1
        RETURNING *`,
      [id, status, cancel_reason || null]
    );
    return rows[0] || null;
  }

  static async statusCounts(db, branchId) {
    const values = [];
    let clause = '';
    if (branchId) {
      values.push(branchId);
      clause = 'WHERE branch_id = $1';
    }
    const { rows } = await db.query(
      `SELECT fulfilment_status, COUNT(*)::int AS count FROM online_orders ${clause} GROUP BY fulfilment_status`,
      values
    );
    return rows.reduce((acc, r) => {
      acc[r.fulfilment_status] = r.count;
      return acc;
    }, {});
  }
}

module.exports = OnlineOrder;
