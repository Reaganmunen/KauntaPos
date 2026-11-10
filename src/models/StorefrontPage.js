'use strict';

const BaseModel = require('./BaseModel');

/** Simple content pages (About, Delivery info, Returns, ...). Plain text/markdown, never custom code. */
class StorefrontPage extends BaseModel {
  static table = 'storefront_pages';
  static columns = ['slug', 'title', 'content', 'is_published', 'sort_order'];
  static defaultOrder = 'sort_order ASC, title ASC';

  static async findBySlug(db, slug, { publishedOnly = false } = {}) {
    const filters = { slug };
    if (publishedOnly) filters.is_published = true;
    return this.findOne(db, filters);
  }
}

module.exports = StorefrontPage;
