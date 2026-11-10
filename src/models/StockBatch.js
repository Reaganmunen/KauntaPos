'use strict';

const BaseModel = require('./BaseModel');
const { round3 } = require('../utils/money');

/**
 * Batches with expiry dates (pharmacy and food). Quantities change only through
 * StockMovement rows that carry a batch_id (the trigger updates the batch).
 */
class StockBatch extends BaseModel {
  static table = 'stock_batches';
  static columns = [
    'branch_id', 'variant_id', 'batch_no', 'expiry_date', 'manufactured_date',
    'cost_price', 'supplier_id', 'is_active',
  ];
  static defaultOrder = 'expiry_date ASC NULLS LAST';

  /** Finds the batch for (branch, variant, batch_no) or creates it with quantity 0. */
  static async findOrCreate(db, data) {
    const { rows } = await db.query(
      `INSERT INTO stock_batches
         (tenant_id, branch_id, variant_id, batch_no, expiry_date, manufactured_date, cost_price, supplier_id)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, branch_id, variant_id, batch_no)
       DO UPDATE SET expiry_date = COALESCE(EXCLUDED.expiry_date, stock_batches.expiry_date),
                     cost_price = COALESCE(EXCLUDED.cost_price, stock_batches.cost_price)
       RETURNING *`,
      [
        data.branch_id,
        data.variant_id,
        data.batch_no,
        data.expiry_date || null,
        data.manufactured_date || null,
        data.cost_price ?? null,
        data.supplier_id || null,
      ]
    );
    return rows[0];
  }

  static async forVariant(db, branchId, variantId, { includeEmpty = false } = {}) {
    const { rows } = await db.query(
      `SELECT * FROM stock_batches
        WHERE branch_id = $1 AND variant_id = $2 AND is_active
          ${includeEmpty ? '' : 'AND quantity_on_hand > 0'}
        ORDER BY expiry_date ASC NULLS LAST, received_at ASC`,
      [branchId, variantId]
    );
    return rows;
  }

  /**
   * First-expiry-first-out allocation for a sale. Locks the batch rows. Skips expired batches.
   * Returns { allocations: [{ batch_id, batch_no, expiry_date, quantity }], shortfall }.
   * The caller records one stock movement per allocation.
   */
  static async allocateFefo(db, branchId, variantId, quantity) {
    const { rows } = await db.query(
      `SELECT id, batch_no, expiry_date, quantity_on_hand
         FROM stock_batches
        WHERE branch_id = $1 AND variant_id = $2 AND is_active AND quantity_on_hand > 0
          AND (expiry_date IS NULL OR expiry_date >= CURRENT_DATE)
        ORDER BY expiry_date ASC NULLS LAST, received_at ASC
        FOR UPDATE`,
      [branchId, variantId]
    );

    let remaining = Number(quantity);
    const allocations = [];
    for (const batch of rows) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, batch.quantity_on_hand);
      allocations.push({
        batch_id: batch.id,
        batch_no: batch.batch_no,
        expiry_date: batch.expiry_date,
        quantity: take,
      });
      remaining = round3(remaining - take);
    }
    return { allocations, shortfall: Math.max(remaining, 0) };
  }

  /** Batches that expire within `days` (and are still in stock). */
  static async expiringSoon(db, { days = 90, branchId } = {}) {
    const values = [days];
    let branchClause = '';
    if (branchId) {
      values.push(branchId);
      branchClause = `AND sb.branch_id = $${values.length}`;
    }
    const { rows } = await db.query(
      `SELECT sb.*, p.name AS product_name, v.name AS variant_name, v.sku
         FROM stock_batches sb
         JOIN product_variants v ON v.id = sb.variant_id
         JOIN products p ON p.id = v.product_id
        WHERE sb.is_active AND sb.quantity_on_hand > 0 AND sb.expiry_date IS NOT NULL
          AND sb.expiry_date <= CURRENT_DATE + $1::int
          ${branchClause}
        ORDER BY sb.expiry_date ASC`,
      values
    );
    return rows;
  }

  static async expired(db, { branchId } = {}) {
    const values = [];
    let branchClause = '';
    if (branchId) {
      values.push(branchId);
      branchClause = `AND sb.branch_id = $${values.length}`;
    }
    const { rows } = await db.query(
      `SELECT sb.*, p.name AS product_name, v.name AS variant_name, v.sku
         FROM stock_batches sb
         JOIN product_variants v ON v.id = sb.variant_id
         JOIN products p ON p.id = v.product_id
        WHERE sb.is_active AND sb.quantity_on_hand > 0 AND sb.expiry_date < CURRENT_DATE
          ${branchClause}
        ORDER BY sb.expiry_date ASC`,
      values
    );
    return rows;
  }
}

module.exports = StockBatch;
