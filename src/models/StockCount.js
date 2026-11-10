'use strict';

const BaseModel = require('./BaseModel');
const DocumentSequence = require('./DocumentSequence');

/**
 * Stocktakes. start() snapshots the expected quantities; staff enter counted quantities;
 * the service then records adjustment movements for the differences and completes the count.
 */
class StockCount extends BaseModel {
  static table = 'stock_counts';
  static columns = ['branch_id', 'count_number', 'status', 'notes', 'started_by', 'completed_at'];

  /** Starts a count for a branch, snapshotting what the system thinks is on hand. */
  static async start(db, { branch_id, started_by, notes }) {
    const count_number = await DocumentSequence.next(db, 'stock_count', 'all', 'SC-');
    const count = await this.create(db, { branch_id, started_by, notes, count_number, status: 'open' });
    await db.query(
      `INSERT INTO stock_count_items (tenant_id, count_id, variant_id, expected_qty)
       SELECT current_tenant_id(), $1, sl.variant_id, sl.quantity_on_hand
         FROM stock_levels sl
        WHERE sl.branch_id = $2`,
      [count.id, branch_id]
    );
    return count;
  }

  static async getItems(db, countId, { onlyCounted = false } = {}) {
    const { rows } = await db.query(
      `SELECT i.*, (i.counted_qty - i.expected_qty) AS variance,
              v.sku, v.name AS variant_name, v.cost_price, p.name AS product_name
         FROM stock_count_items i
         JOIN product_variants v ON v.id = i.variant_id
         JOIN products p ON p.id = v.product_id
        WHERE i.count_id = $1 ${onlyCounted ? 'AND i.counted_qty IS NOT NULL' : ''}
        ORDER BY p.name, v.name`,
      [countId]
    );
    return rows;
  }

  /** Records what staff counted for one variant (adds the row if it was not in the snapshot). */
  static async recordCount(db, countId, variantId, countedQty, note) {
    const { rows } = await db.query(
      `UPDATE stock_count_items SET counted_qty = $3, note = COALESCE($4, note)
        WHERE count_id = $1 AND variant_id = $2
        RETURNING *`,
      [countId, variantId, countedQty, note || null]
    );
    if (rows[0]) return rows[0];

    const inserted = await db.query(
      `INSERT INTO stock_count_items (tenant_id, count_id, variant_id, expected_qty, counted_qty, note)
       VALUES (current_tenant_id(), $1, $2, 0, $3, $4)
       RETURNING *`,
      [countId, variantId, countedQty, note || null]
    );
    return inserted.rows[0];
  }

  /** Counted items whose quantity differs from the system quantity. */
  static async variances(db, countId) {
    const items = await this.getItems(db, countId, { onlyCounted: true });
    return items.filter((i) => Number(i.variance) !== 0);
  }

  static async complete(db, id) {
    const { rows } = await db.query(
      `UPDATE stock_counts SET status = 'completed', completed_at = now()
        WHERE id = $1 AND status = 'open' RETURNING *`,
      [id]
    );
    return rows[0] || null;
  }

  static async cancel(db, id) {
    const { rows } = await db.query(
      `UPDATE stock_counts SET status = 'cancelled' WHERE id = $1 AND status = 'open' RETURNING *`,
      [id]
    );
    return rows[0] || null;
  }
}

module.exports = StockCount;
