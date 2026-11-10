'use strict';

const BaseModel = require('./BaseModel');

/** Pharmacy details, one row per product (primary key = product_id). */
class ProductPharma extends BaseModel {
  static table = 'product_pharma';
  static columns = [
    'generic_name', 'strength', 'dosage_form', 'drug_schedule',
    'requires_prescription', 'ppb_registration_no', 'manufacturer', 'storage_conditions',
  ];

  static async findByProduct(db, productId) {
    const { rows } = await db.query('SELECT * FROM product_pharma WHERE product_id = $1', [productId]);
    return rows[0] || null;
  }

  static async upsert(db, productId, data) {
    const picked = this.pick(data);
    const names = Object.keys(picked);
    const values = Object.values(picked);

    const insertCols = ['product_id', ...names, 'tenant_id'];
    const insertVals = ['$1', ...names.map((_, i) => `$${i + 2}`), 'current_tenant_id()'];
    const updates = names.map((n) => `${n} = EXCLUDED.${n}`);

    const sql = `INSERT INTO product_pharma (${insertCols.join(', ')})
                 VALUES (${insertVals.join(', ')})
                 ON CONFLICT (product_id) DO ${updates.length ? `UPDATE SET ${updates.join(', ')}, updated_at = now()` : 'NOTHING'}
                 RETURNING *`;
    const { rows } = await db.query(sql, [productId, ...values]);
    return rows[0] || this.findByProduct(db, productId);
  }
}

module.exports = ProductPharma;
