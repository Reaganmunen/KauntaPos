'use strict';

const BaseModel = require('./BaseModel');

class ProductVariant extends BaseModel {
  static table = 'product_variants';
  static softDelete = true;
  static columns = [
    'product_id', 'name', 'sku', 'barcode', 'option_values', 'cost_price', 'selling_price',
    'wholesale_price', 'reorder_level', 'is_default', 'is_active',
    'etims_item_code', 'etims_sync_status', 'etims_synced_at',
  ];
  static jsonColumns = ['option_values'];
  static defaultOrder = 'is_default DESC, name ASC';

  static async forProduct(db, productId) {
    return this.findAll(db, { filters: { product_id: productId } });
  }

  static async findByBarcode(db, barcode) {
    return this.findOne(db, { barcode });
  }

  static async findBySku(db, sku) {
    return this.findOne(db, { sku });
  }

  /**
   * Everything the sale flow needs to snapshot onto sale lines: product name, tax code and
   * rate, eTIMS item class (falls back to the category's), unit code, stock tracking flag.
   */
  static async findForSale(db, ids) {
    const { rows } = await db.query(
      `SELECT v.*,
              p.name AS product_name,
              p.track_stock,
              p.product_type,
              p.kitchen_station,
              t.code AS tax_code,
              COALESCE(t.rate, 0) AS tax_rate,
              COALESCE(p.etims_item_class_code, c.etims_item_class_code) AS etims_item_class_code,
              u.etims_unit_code
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
         LEFT JOIN tax_classes t ON t.id = p.tax_class_id
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN units u ON u.id = p.unit_id
        WHERE v.id = ANY($1::uuid[]) AND v.deleted_at IS NULL`,
      [ids]
    );
    return rows;
  }

  /** Fast POS lookup: exact barcode first, then name / SKU matches, with stock for the branch. */
  static async posSearch(db, q, branchId, { limit = 30 } = {}) {
    const { rows } = await db.query(
      `SELECT v.id,
              v.product_id,
              v.name AS variant_name,
              v.sku,
              v.barcode,
              v.selling_price,
              v.cost_price,
              p.name AS product_name,
              p.track_stock,
              p.product_type,
              t.code AS tax_code,
              COALESCE(t.rate, 0) AS tax_rate,
              COALESCE(sl.quantity_on_hand, 0) AS quantity_on_hand
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
         LEFT JOIN tax_classes t ON t.id = p.tax_class_id
         LEFT JOIN stock_levels sl ON sl.variant_id = v.id AND sl.branch_id = $2
        WHERE v.deleted_at IS NULL AND v.is_active
          AND p.deleted_at IS NULL AND p.is_active
          AND (v.barcode = $1 OR v.sku ILIKE $3 OR p.name ILIKE $3)
        ORDER BY COALESCE(v.barcode = $1, false) DESC, p.name ASC, v.name ASC
        LIMIT $4`,
      [q, branchId, this.like(q), limit]
    );
    return rows;
  }

  /** Variants at or below their reorder level for one branch. */
  static async lowStock(db, branchId) {
    const { rows } = await db.query(
      `SELECT v.id, v.sku, v.name AS variant_name, v.reorder_level, p.name AS product_name,
              COALESCE(sl.quantity_on_hand, 0) AS quantity_on_hand
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
         LEFT JOIN stock_levels sl ON sl.variant_id = v.id AND sl.branch_id = $1
        WHERE v.deleted_at IS NULL AND v.is_active AND p.deleted_at IS NULL AND p.is_active
          AND p.track_stock AND COALESCE(sl.quantity_on_hand, 0) <= v.reorder_level
        ORDER BY COALESCE(sl.quantity_on_hand, 0) ASC, p.name ASC`,
      [branchId]
    );
    return rows;
  }

  static async markEtimsSynced(db, id, etimsItemCode) {
    return this.update(db, id, {
      etims_item_code: etimsItemCode || null,
      etims_sync_status: 'synced',
      etims_synced_at: new Date(),
    });
  }

  static async markEtimsFailed(db, id) {
    return this.update(db, id, { etims_sync_status: 'failed' });
  }
}

module.exports = ProductVariant;
