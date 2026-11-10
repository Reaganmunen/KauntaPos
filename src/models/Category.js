'use strict';

const BaseModel = require('./BaseModel');

class Category extends BaseModel {
  static table = 'categories';
  static columns = [
    'parent_id', 'name', 'slug', 'image_url', 'sort_order', 'show_online',
    'etims_item_class_code', 'is_active',
  ];
  static defaultOrder = 'sort_order ASC, name ASC';

  static async findBySlug(db, slug) {
    return this.findOne(db, { slug });
  }

  static async createWithSlug(db, data) {
    const slug = data.slug || (await this.uniqueSlug(db, data.name));
    return this.create(db, { ...data, slug });
  }

  /** Nested tree: [{ ...category, children: [...] }] */
  static async tree(db, { onlineOnly = false } = {}) {
    const filters = { is_active: true };
    if (onlineOnly) filters.show_online = true;
    const rows = await this.findAll(db, { filters });

    const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
    const roots = [];
    for (const node of byId.values()) {
      if (node.parent_id && byId.has(node.parent_id)) byId.get(node.parent_id).children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  static async withProductCounts(db) {
    const { rows } = await db.query(
      `SELECT c.*, COUNT(p.id)::int AS product_count
         FROM categories c
         LEFT JOIN products p ON p.category_id = c.id AND p.deleted_at IS NULL
        GROUP BY c.id
        ORDER BY c.sort_order ASC, c.name ASC`
    );
    return rows;
  }
}

module.exports = Category;
