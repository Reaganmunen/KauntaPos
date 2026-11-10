'use strict';

const BaseModel = require('./BaseModel');
const ProductVariant = require('./ProductVariant');
const ProductImage = require('./ProductImage');
const ProductPharma = require('./ProductPharma');

class Product extends BaseModel {
  static table = 'products';
  static softDelete = true;
  static columns = [
    'category_id', 'brand_id', 'unit_id', 'tax_class_id', 'name', 'slug', 'description',
    'product_type', 'track_stock', 'has_variants', 'kitchen_station', 'tags', 'attributes',
    'is_online', 'online_description', 'seo_title', 'seo_description',
    'etims_item_class_code', 'etims_pkg_unit_code', 'origin_country', 'is_active', 'created_by',
  ];
  static jsonColumns = ['attributes'];   // tags is text[] (plain JS array)
  static defaultOrder = 'name ASC';

  static async findBySlug(db, slug) {
    return this.findOne(db, { slug });
  }

  /**
   * Creates a product and its variants together. The first variant becomes the default one.
   * With no variants given, a single "Default" variant is created.
   */
  static async createWithVariants(db, data, variants = []) {
    const list = variants.length ? variants : [{ name: 'Default' }];
    const slug = data.slug || (await this.uniqueSlug(db, data.name));
    const product = await this.create(db, { ...data, slug, has_variants: list.length > 1 });

    const created = [];
    for (let i = 0; i < list.length; i++) {
      created.push(await ProductVariant.create(db, { ...list[i], product_id: product.id, is_default: i === 0 }));
    }
    return { ...product, variants: created };
  }

  static async getWithVariants(db, id) {
    const product = await this.findById(db, id);
    if (!product) return null;
    const variants = await ProductVariant.forProduct(db, id);
    const images = await ProductImage.forProduct(db, id);
    const pharma = await ProductPharma.findByProduct(db, id);
    return { ...product, variants, images, pharma };
  }

  /** Soft-deletes the product and its variants. */
  static async remove(db, id) {
    const product = await super.remove(db, id);
    if (product) {
      await db.query('UPDATE product_variants SET deleted_at = now() WHERE product_id = $1 AND deleted_at IS NULL', [id]);
    }
    return product;
  }

  /** Back-office product list with category name and price range. */
  static async search(db, { q, category_id, is_online, is_active, product_type, page = 1, limit = 25, orderBy } = {}) {
    const where = ['p.deleted_at IS NULL'];
    const values = [];

    if (q) {
      values.push(this.like(q));
      const like = `$${values.length}`;
      values.push(String(q));
      const exact = `$${values.length}`;
      where.push(
        `(p.name ILIKE ${like} OR EXISTS (
            SELECT 1 FROM product_variants x
             WHERE x.product_id = p.id AND x.deleted_at IS NULL
               AND (x.sku ILIKE ${like} OR x.barcode = ${exact})))`
      );
    }
    if (category_id) {
      values.push(category_id);
      where.push(`p.category_id = $${values.length}`);
    }
    if (is_online !== undefined && is_online !== null) {
      values.push(Boolean(is_online));
      where.push(`p.is_online = $${values.length}`);
    }
    if (is_active !== undefined && is_active !== null) {
      values.push(Boolean(is_active));
      where.push(`p.is_active = $${values.length}`);
    }
    if (product_type) {
      values.push(product_type);
      where.push(`p.product_type = $${values.length}`);
    }

    const sortable = { name: 'p.name', created_at: 'p.created_at', updated_at: 'p.updated_at' };
    const [col, dir] = String(orderBy || 'name:asc').split(':');
    const order = `${sortable[col] || 'p.name'} ${String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`;

    return this.runPaged(db, {
      select: `p.*, c.name AS category_name,
               MIN(v.selling_price) AS min_price, MAX(v.selling_price) AS max_price,
               COUNT(v.id)::int AS variant_count`,
      from: `products p
             LEFT JOIN categories c ON c.id = p.category_id
             LEFT JOIN product_variants v ON v.product_id = p.id AND v.deleted_at IS NULL AND v.is_active`,
      countFrom: 'products p',
      where,
      values,
      groupBy: 'GROUP BY p.id, c.name',
      order,
      page,
      limit,
    });
  }

  /**
   * Public storefront listing: online-enabled products with primary image, price range,
   * and in-stock flag for the branch that fulfils online orders.
   */
  static async listOnline(db, { branchId, category_id, q, page = 1, limit = 24 } = {}) {
    const where = ['p.is_online', 'p.is_active', 'p.deleted_at IS NULL'];
    const values = [branchId];

    if (category_id) {
      values.push(category_id);
      where.push(`p.category_id = $${values.length}`);
    }
    if (q) {
      values.push(this.like(q));
      where.push(`p.name ILIKE $${values.length}`);
    }

    return this.runPaged(db, {
      select: `p.id, p.name, p.slug, p.online_description, p.category_id,
               MIN(v.selling_price) AS min_price,
               MAX(v.selling_price) AS max_price,
               (SELECT i.url FROM product_images i WHERE i.product_id = p.id
                 ORDER BY i.is_primary DESC, i.sort_order ASC LIMIT 1) AS image_url,
               COALESCE(BOOL_OR(NOT p.track_stock OR COALESCE(a.quantity_available, 0) > 0), false) AS in_stock`,
      from: `products p
             JOIN product_variants v ON v.product_id = p.id AND v.deleted_at IS NULL AND v.is_active
             LEFT JOIN v_stock_available a ON a.variant_id = v.id AND a.branch_id = $1`,
      countFrom: 'products p',
      where,
      values,
      groupBy: 'GROUP BY p.id',
      order: 'p.name ASC',
      page,
      limit,
    });
  }
}

module.exports = Product;
