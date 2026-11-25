'use strict';

const BaseModel = require('./BaseModel');

/** An offer the till applies by itself. The pricing rules live in public/js/promo-engine.js. */
class Promotion extends BaseModel {
  static table = 'promotions';
  static columns = [
    'name', 'type', 'buy_qty', 'get_qty', 'limit_per_sale', 'bundle_qty', 'bundle_price',
    'percent_off', 'amount_off', 'priority', 'starts_at', 'ends_at', 'branch_id', 'is_active', 'created_by',
  ];
  static defaultOrder = 'created_at DESC';

  /** Every offer with how many items it covers, newest first. */
  static async listWithCounts(db) {
    const { rows } = await db.query(
      `SELECT p.*, (SELECT COUNT(*)::int FROM promotion_items i WHERE i.promotion_id = p.id) AS item_count,
              COALESCE((SELECT json_agg(x.label ORDER BY x.label) FROM (
                 SELECT pr.name || CASE WHEN v.name <> 'Default' THEN ' - ' || v.name ELSE '' END AS label
                   FROM promotion_items i JOIN product_variants v ON v.id = i.variant_id
                   JOIN products pr ON pr.id = v.product_id
                  WHERE i.promotion_id = p.id LIMIT 3) x), '[]'::json) AS sample_items
         FROM promotions p ORDER BY p.created_at DESC`
    );
    return rows;
  }

  static async getWithItems(db, id) {
    const promo = await this.findById(db, id);
    if (!promo) return null;
    const { rows } = await db.query(
      `SELECT v.id AS variant_id, v.name AS variant_name, p.name AS product_name, v.selling_price
         FROM promotion_items i
         JOIN product_variants v ON v.id = i.variant_id
         JOIN products p ON p.id = v.product_id
        WHERE i.promotion_id = $1 ORDER BY p.name, v.name`,
      [id]
    );
    return { ...promo, items: rows, variant_ids: rows.map((r) => r.variant_id) };
  }

  /** Replaces the items an offer covers. Unknown or deleted variants are ignored. */
  static async setItems(db, id, variantIds) {
    await db.query('DELETE FROM promotion_items WHERE promotion_id = $1', [id]);
    if (!variantIds.length) return;
    await db.query(
      `INSERT INTO promotion_items (tenant_id, promotion_id, variant_id)
       SELECT current_tenant_id(), $1, v.id FROM product_variants v
        WHERE v.id = ANY($2::uuid[]) AND v.deleted_at IS NULL
       ON CONFLICT DO NOTHING`,
      [id, variantIds]
    );
  }

  static async touch(db, id) {
    await db.query('UPDATE promotions SET updated_at = now() WHERE id = $1', [id]);
  }

  /**
   * Offers the sale code and the till can use, each with variant_ids. By default only those live at `at`;
   * includeUpcoming also returns ones that start later (the till checks the clock itself, so it can sell offline).
   */
  static async activeFor(db, { branchId = null, at = new Date(), includeUpcoming = false } = {}) {
    const { rows } = await db.query(
      `SELECT p.id, p.name, p.type, p.buy_qty, p.get_qty, p.limit_per_sale, p.bundle_qty, p.bundle_price,
              p.percent_off, p.amount_off, p.priority, p.starts_at, p.ends_at, p.branch_id,
              COALESCE(array_agg(i.variant_id) FILTER (WHERE i.variant_id IS NOT NULL), '{}') AS variant_ids
         FROM promotions p
         LEFT JOIN promotion_items i ON i.promotion_id = p.id
        WHERE p.is_active
          AND ($3::boolean OR p.starts_at IS NULL OR p.starts_at <= $1)
          AND (p.ends_at IS NULL OR p.ends_at >= $1)
          AND (p.branch_id IS NULL OR p.branch_id = $2)
        GROUP BY p.id
        ORDER BY p.priority DESC, p.created_at ASC`,
      [at, branchId, includeUpcoming]
    );
    return rows;
  }
}

module.exports = Promotion;
