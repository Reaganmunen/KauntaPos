'use strict';

const BaseModel = require('./BaseModel');

/** Restaurant recipes: which ingredient variants (and how much) one dish uses. */
class RecipeItem extends BaseModel {
  static table = 'recipe_items';
  static columns = ['dish_variant_id', 'ingredient_variant_id', 'quantity'];
  static defaultOrder = 'id';

  static async forDish(db, dishVariantId) {
    const { rows } = await db.query(
      `SELECT r.*, v.sku, v.name AS ingredient_variant_name, p.name AS ingredient_name
         FROM recipe_items r
         JOIN product_variants v ON v.id = r.ingredient_variant_id
         JOIN products p ON p.id = v.product_id
        WHERE r.dish_variant_id = $1
        ORDER BY p.name`,
      [dishVariantId]
    );
    return rows;
  }

  /** items: [{ ingredient_variant_id, quantity }] */
  static async replaceForDish(db, dishVariantId, items = []) {
    await db.query('DELETE FROM recipe_items WHERE dish_variant_id = $1', [dishVariantId]);
    for (const item of items) {
      await this.create(db, {
        dish_variant_id: dishVariantId,
        ingredient_variant_id: item.ingredient_variant_id,
        quantity: item.quantity,
      });
    }
    return this.forDish(db, dishVariantId);
  }

  /** Ingredient quantities to deduct for N portions of the given dishes. */
  static async consumptionFor(db, dishVariantIds) {
    if (!dishVariantIds.length) return [];
    const { rows } = await db.query(
      'SELECT dish_variant_id, ingredient_variant_id, quantity FROM recipe_items WHERE dish_variant_id = ANY($1::uuid[])',
      [dishVariantIds]
    );
    return rows;
  }
}

module.exports = RecipeItem;
