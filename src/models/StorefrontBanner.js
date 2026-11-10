'use strict';

const BaseModel = require('./BaseModel');

class StorefrontBanner extends BaseModel {
  static table = 'storefront_banners';
  static columns = ['image_url', 'title', 'subtitle', 'link_url', 'sort_order', 'is_active', 'starts_at', 'ends_at'];
  static defaultOrder = 'sort_order ASC, created_at ASC';
}

module.exports = StorefrontBanner;
