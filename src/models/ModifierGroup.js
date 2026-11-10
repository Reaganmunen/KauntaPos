'use strict';

const BaseModel = require('./BaseModel');

/** Restaurant: groups like "Spice level" or "Extras", each holding modifiers. */
class ModifierGroup extends BaseModel {
  static table = 'modifier_groups';
  static columns = ['name', 'min_select', 'max_select', 'sort_order'];
  static defaultOrder = 'sort_order ASC, name ASC';

  static async listWithModifiers(db) {
    const { rows } = await db.query(
      `SELECT g.*,
              COALESCE(json_agg(m ORDER BY m.sort_order, m.name) FILTER (WHERE m.id IS NOT NULL), '[]'::json) AS modifiers
         FROM modifier_groups g
         LEFT JOIN modifiers m ON m.group_id = g.id AND m.is_active
        GROUP BY g.id
        ORDER BY g.sort_order, g.name`
    );
    return rows;
  }

  /** Groups (with modifiers) attached to one product, in the order configured. */
  static async forProduct(db, productId) {
    const { rows } = await db.query(
      `SELECT g.*,
              COALESCE(json_agg(m ORDER BY m.sort_order, m.name) FILTER (WHERE m.id IS NOT NULL), '[]'::json) AS modifiers
         FROM product_modifier_groups pmg
         JOIN modifier_groups g ON g.id = pmg.group_id
         LEFT JOIN modifiers m ON m.group_id = g.id AND m.is_active
        WHERE pmg.product_id = $1
        GROUP BY g.id, pmg.sort_order
        ORDER BY pmg.sort_order, g.name`,
      [productId]
    );
    return rows;
  }

  /** Replaces which groups apply to a product. */
  static async attachToProduct(db, productId, groupIds = []) {
    await db.query('DELETE FROM product_modifier_groups WHERE product_id = $1', [productId]);
    for (let i = 0; i < groupIds.length; i++) {
      await db.query(
        `INSERT INTO product_modifier_groups (tenant_id, product_id, group_id, sort_order)
         VALUES (current_tenant_id(), $1, $2, $3)`,
        [productId, groupIds[i], i]
      );
    }
    return this.forProduct(db, productId);
  }
}

module.exports = ModifierGroup;
