'use strict';

const BaseModel = require('./BaseModel');

class PriceList extends BaseModel {
  static table = 'price_lists';
  static columns = ['name', 'description', 'is_default', 'is_active'];
  static defaultOrder = 'is_default DESC, name ASC';

  static async getDefault(db) {
    return this.findOne(db, { is_default: true });
  }

  static async getItems(db, priceListId) {
    const { rows } = await db.query(
      `SELECT pli.*, v.sku, v.name AS variant_name, p.name AS product_name
         FROM price_list_items pli
         JOIN product_variants v ON v.id = pli.variant_id
         JOIN products p ON p.id = v.product_id
        WHERE pli.price_list_id = $1
        ORDER BY p.name, v.name, pli.min_quantity`,
      [priceListId]
    );
    return rows;
  }

  /** items: [{ variant_id, price, min_quantity = 1 }] (insert or update) */
  static async setItems(db, priceListId, items = []) {
    for (const item of items) {
      await db.query(
        `INSERT INTO price_list_items (tenant_id, price_list_id, variant_id, min_quantity, price)
         VALUES (current_tenant_id(), $1, $2, $3, $4)
         ON CONFLICT (price_list_id, variant_id, min_quantity) DO UPDATE SET price = EXCLUDED.price`,
        [priceListId, item.variant_id, item.min_quantity ?? 1, item.price]
      );
    }
    return this.getItems(db, priceListId);
  }

  static async removeItem(db, priceListId, variantId, minQuantity = 1) {
    await db.query(
      'DELETE FROM price_list_items WHERE price_list_id = $1 AND variant_id = $2 AND min_quantity = $3',
      [priceListId, variantId, minQuantity]
    );
  }

  /** Best price for this quantity, or null when the list has no entry (use the variant's selling_price). */
  static async getPrice(db, priceListId, variantId, quantity = 1) {
    const { rows } = await db.query(
      `SELECT price FROM price_list_items
        WHERE price_list_id = $1 AND variant_id = $2 AND min_quantity <= $3
        ORDER BY min_quantity DESC
        LIMIT 1`,
      [priceListId, variantId, quantity]
    );
    return rows[0] ? rows[0].price : null;
  }

  static async setDefault(db, id) {
    await db.query('UPDATE price_lists SET is_default = false WHERE id <> $1', [id]);
    const { rows } = await db.query('UPDATE price_lists SET is_default = true WHERE id = $1 RETURNING *', [id]);
    return rows[0] || null;
  }
}

module.exports = PriceList;
