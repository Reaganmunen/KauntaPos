'use strict';

const BaseModel = require('./BaseModel');

/**
 * Append-only stock ledger. The ONLY way to change stock: a database trigger applies each
 * movement to stock_levels (and stock_batches when batch_id is set).
 * quantity_change is positive for stock in, negative for stock out.
 */
class StockMovement extends BaseModel {
  static table = 'stock_movements';
  static columns = [
    'branch_id', 'variant_id', 'batch_id', 'movement_type', 'quantity_change',
    'unit_cost', 'reference_type', 'reference_id', 'note', 'created_by',
  ];
  static defaultOrder = 'created_at DESC';

  static async update() {
    throw new Error('Stock movements are append-only; record a correcting movement instead');
  }

  static async remove() {
    throw new Error('Stock movements are append-only; record a correcting movement instead');
  }

  static async record(db, movement) {
    return this.create(db, movement);
  }

  static async recordMany(db, movements = []) {
    return this.createMany(db, movements);
  }

  static async forVariant(db, variantId, { branchId, limit = 100 } = {}) {
    const values = [variantId];
    let branchClause = '';
    if (branchId) {
      values.push(branchId);
      branchClause = `AND m.branch_id = $${values.length}`;
    }
    values.push(limit);
    const { rows } = await db.query(
      `SELECT m.*, b.name AS branch_name, u.full_name AS created_by_name, sb.batch_no
         FROM stock_movements m
         JOIN branches b ON b.id = m.branch_id
         LEFT JOIN users u ON u.id = m.created_by
         LEFT JOIN stock_batches sb ON sb.id = m.batch_id
        WHERE m.variant_id = $1 ${branchClause}
        ORDER BY m.created_at DESC
        LIMIT $${values.length}`,
      values
    );
    return rows;
  }

  static async forReference(db, referenceType, referenceId) {
    const { rows } = await db.query(
      'SELECT * FROM stock_movements WHERE reference_type = $1 AND reference_id = $2 ORDER BY created_at',
      [referenceType, referenceId]
    );
    return rows;
  }
}

module.exports = StockMovement;
