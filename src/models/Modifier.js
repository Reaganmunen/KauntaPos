'use strict';

const BaseModel = require('./BaseModel');

class Modifier extends BaseModel {
  static table = 'modifiers';
  static columns = ['group_id', 'name', 'price_delta', 'ingredient_variant_id', 'is_active', 'sort_order'];
  static defaultOrder = 'sort_order ASC, name ASC';

  static async forGroup(db, groupId) {
    return this.findAll(db, { filters: { group_id: groupId } });
  }

  /** Looks up modifiers by id (used to price and snapshot them on a sale line). */
  static async findByIds(db, ids) {
    if (!ids.length) return [];
    const { rows } = await db.query('SELECT * FROM modifiers WHERE id = ANY($1::uuid[])', [ids]);
    return rows;
  }
}

module.exports = Modifier;
