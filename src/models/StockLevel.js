'use strict';

const BaseModel = require('./BaseModel');

/**
 * Current stock per branch and variant. READ-ONLY here: quantities change only through
 * StockMovement (a database trigger applies each movement to this table).
 */
class StockLevel extends BaseModel {
  static table = 'stock_levels';
  static columns = [];
  static defaultOrder = 'updated_at DESC';

  static async create() {
    throw new Error('StockLevel is maintained by StockMovement; record a movement instead');
  }

  static async update() {
    throw new Error('StockLevel is maintained by StockMovement; record a movement instead');
  }

  static async remove() {
    throw new Error('StockLevel is maintained by StockMovement; record a movement instead');
  }

  static async getQuantity(db, branchId, variantId) {
    const { rows } = await db.query(
      'SELECT quantity_on_hand FROM stock_levels WHERE branch_id = $1 AND variant_id = $2',
      [branchId, variantId]
    );
    return rows[0] ? rows[0].quantity_on_hand : 0;
  }

  /**
   * Locks the stock rows for these variants until the transaction ends, so two cashiers
   * cannot both sell the last item. Call before checking availability in the sale flow.
   */
  static async lockForUpdate(db, branchId, variantIds) {
    if (!variantIds.length) return [];
    const { rows } = await db.query(
      `SELECT variant_id, quantity_on_hand
         FROM stock_levels
        WHERE branch_id = $1 AND variant_id = ANY($2::uuid[])
        ORDER BY variant_id
        FOR UPDATE`,
      [branchId, variantIds]
    );
    return rows;
  }

  /** On hand, reserved (online carts) and available for sale, from v_stock_available. */
  static async availability(db, branchId, variantIds) {
    if (!variantIds.length) return [];
    const { rows } = await db.query(
      `SELECT variant_id, quantity_on_hand, quantity_reserved, quantity_available
         FROM v_stock_available
        WHERE branch_id = $1 AND variant_id = ANY($2::uuid[])`,
      [branchId, variantIds]
    );
    return rows;
  }

  /** Stock list for one branch; includes variants that have never been stocked (qty 0). */
  static async forBranch(db, branchId, { q, low_only = false, page = 1, limit = 50 } = {}) {
    const where = [
      'v.deleted_at IS NULL',
      'p.deleted_at IS NULL',
      'p.track_stock',
      'p.is_active',
    ];
    const values = [branchId];

    if (q) {
      values.push(this.like(q));
      const like = `$${values.length}`;
      values.push(String(q));
      where.push(`(p.name ILIKE ${like} OR v.sku ILIKE ${like} OR v.barcode = $${values.length})`);
    }
    if (low_only) where.push('COALESCE(sl.quantity_on_hand, 0) <= v.reorder_level');

    return this.runPaged(db, {
      select: `v.id AS variant_id, p.id AS product_id, p.name AS product_name, v.name AS variant_name,
               v.sku, v.barcode, v.reorder_level, v.cost_price, v.selling_price,
               COALESCE(sl.quantity_on_hand, 0) AS quantity_on_hand`,
      from: `product_variants v
             JOIN products p ON p.id = v.product_id
             LEFT JOIN stock_levels sl ON sl.variant_id = v.id AND sl.branch_id = $1`,
      where,
      values,
      order: 'p.name ASC, v.name ASC',
      page,
      limit,
    });
  }

  /** Stock value at cost and at retail for a branch. */
  static async valuation(db, branchId) {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(sl.quantity_on_hand * v.cost_price), 0) AS cost_value,
              COALESCE(SUM(sl.quantity_on_hand * v.selling_price), 0) AS retail_value
         FROM stock_levels sl
         JOIN product_variants v ON v.id = sl.variant_id
        WHERE sl.branch_id = $1 AND sl.quantity_on_hand > 0`,
      [branchId]
    );
    return rows[0];
  }
}

module.exports = StockLevel;
