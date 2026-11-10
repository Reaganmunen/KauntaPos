'use strict';

const BaseModel = require('./BaseModel');

/** One storefront configuration per tenant: branding, theme options, delivery and pickup switches. */
class StorefrontSettings extends BaseModel {
  static table = 'storefront_settings';
  static columns = [
    'is_published', 'store_name', 'tagline', 'logo_url', 'favicon_url', 'theme_key', 'theme',
    'contact_phone', 'contact_email', 'whatsapp_number', 'address', 'social_links',
    'announcement', 'seo_title', 'seo_description', 'enable_delivery', 'enable_pickup',
    'min_order_amount', 'fulfilment_branch_id',
  ];
  static jsonColumns = ['theme', 'social_links'];

  static async get(db) {
    const { rows } = await db.query('SELECT * FROM storefront_settings LIMIT 1');
    return rows[0] || null;
  }

  static async save(db, data) {
    const existing = await this.get(db);
    return existing ? this.update(db, existing.id, data) : this.create(db, data);
  }

  /** Everything the public storefront needs in one call: settings, banners, pages, delivery zones. */
  static async getPublicBundle(db) {
    const settings = await this.get(db);
    if (!settings || !settings.is_published) return null;

    const [banners, pages, zones] = await Promise.all([
      db.query(
        `SELECT id, image_url, title, subtitle, link_url
           FROM storefront_banners
          WHERE is_active AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())
          ORDER BY sort_order, created_at`
      ),
      db.query(
        `SELECT slug, title FROM storefront_pages WHERE is_published ORDER BY sort_order, title`
      ),
      db.query(
        `SELECT id, name, fee, min_order_amount, estimated_minutes
           FROM delivery_zones WHERE is_active ORDER BY name`
      ),
    ]);

    return { settings, banners: banners.rows, pages: pages.rows, delivery_zones: zones.rows };
  }
}

module.exports = StorefrontSettings;
