'use strict';

const BaseModel = require('./BaseModel');

class ProductImage extends BaseModel {
  static table = 'product_images';
  static columns = ['product_id', 'variant_id', 'url', 'alt_text', 'sort_order', 'is_primary'];
  static defaultOrder = 'is_primary DESC, sort_order ASC';

  static async forProduct(db, productId) {
    return this.findAll(db, { filters: { product_id: productId } });
  }

  static async setPrimary(db, productId, imageId) {
    await db.query('UPDATE product_images SET is_primary = false WHERE product_id = $1', [productId]);
    const { rows } = await db.query(
      'UPDATE product_images SET is_primary = true WHERE id = $1 AND product_id = $2 RETURNING *',
      [imageId, productId]
    );
    return rows[0] || null;
  }
}

module.exports = ProductImage;
