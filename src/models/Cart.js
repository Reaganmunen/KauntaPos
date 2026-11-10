'use strict';

const BaseModel = require('./BaseModel');

/** Anonymous storefront shopping cart, identified by an unguessable token (kept in the browser). */
class Cart extends BaseModel {
  static table = 'carts';
  static columns = ['customer_id', 'expires_at'];

  static async findByToken(db, token) {
    const { rows } = await db.query(
      'SELECT * FROM carts WHERE token = $1 AND expires_at > now() LIMIT 1',
      [token]
    );
    return rows[0] || null;
  }

  /** Cart with current prices, tax and availability for the online fulfilment branch. */
  static async getWithItems(db, cartId, branchId) {
    const { rows } = await db.query(
      `SELECT ci.id AS item_id, ci.variant_id, ci.quantity,
              v.name AS variant_name, v.sku, v.selling_price,
              p.id AS product_id, p.name AS product_name, p.slug AS product_slug, p.track_stock,
              (SELECT i.url FROM product_images i WHERE i.product_id = p.id
                ORDER BY i.is_primary DESC, i.sort_order ASC LIMIT 1) AS image_url,
              COALESCE(a.quantity_available, 0) AS quantity_available,
              (ci.quantity * v.selling_price) AS line_total
         FROM cart_items ci
         JOIN product_variants v ON v.id = ci.variant_id AND v.deleted_at IS NULL
         JOIN products p ON p.id = v.product_id AND p.deleted_at IS NULL
         LEFT JOIN v_stock_available a ON a.variant_id = v.id AND a.branch_id = $2
        WHERE ci.cart_id = $1
        ORDER BY ci.created_at`,
      [cartId, branchId]
    );
    const total = rows.reduce((sum, r) => sum + Number(r.line_total), 0);
    return { items: rows, total: Math.round((total + Number.EPSILON) * 100) / 100 };
  }

  /** Adds to the cart, or increases the quantity if the variant is already there. */
  static async addItem(db, cartId, variantId, quantity = 1) {
    const { rows } = await db.query(
      `INSERT INTO cart_items (tenant_id, cart_id, variant_id, quantity)
       VALUES (current_tenant_id(), $1, $2, $3)
       ON CONFLICT (cart_id, variant_id) DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity
       RETURNING *`,
      [cartId, variantId, quantity]
    );
    await this.touch(db, cartId);
    return rows[0];
  }

  /** Sets an exact quantity; zero or less removes the line. */
  static async setItemQuantity(db, cartId, variantId, quantity) {
    if (Number(quantity) <= 0) {
      await db.query('DELETE FROM cart_items WHERE cart_id = $1 AND variant_id = $2', [cartId, variantId]);
      await this.touch(db, cartId);
      return null;
    }
    const { rows } = await db.query(
      'UPDATE cart_items SET quantity = $3 WHERE cart_id = $1 AND variant_id = $2 RETURNING *',
      [cartId, variantId, quantity]
    );
    await this.touch(db, cartId);
    return rows[0] || null;
  }

  static async removeItem(db, cartId, variantId) {
    await db.query('DELETE FROM cart_items WHERE cart_id = $1 AND variant_id = $2', [cartId, variantId]);
    await this.touch(db, cartId);
  }

  static async clear(db, cartId) {
    await db.query('DELETE FROM cart_items WHERE cart_id = $1', [cartId]);
  }

  /** Pushes expiry out another 7 days on activity. */
  static async touch(db, cartId) {
    await db.query(`UPDATE carts SET expires_at = now() + interval '7 days' WHERE id = $1`, [cartId]);
  }

  static async deleteExpired(db) {
    const { rowCount } = await db.query('DELETE FROM carts WHERE expires_at < now()');
    return rowCount;
  }
}

module.exports = Cart;
