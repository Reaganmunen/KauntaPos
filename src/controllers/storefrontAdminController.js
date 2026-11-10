'use strict';

/**
 * The shop owner's storefront settings: branding, theme options, banners, pages and delivery zones.
 * Owners choose from prebuilt themes and fill in settings; they never upload custom code.
 */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/respond');
const { pick } = require('../utils/validate');
const { run } = require('../utils/context');
const { audit } = require('../utils/audit');
const { makeCrud } = require('../utils/crud');
const { slugify } = require('../utils/slugify');
const {
  StorefrontSettings, StorefrontBanner, StorefrontPage, DeliveryZone, Branch, MpesaConfig, TenantFeature,
} = require('../models');

const SETTINGS_FIELDS = [
  'store_name', 'tagline', 'logo_url', 'favicon_url', 'theme_key', 'theme', 'contact_phone',
  'contact_email', 'whatsapp_number', 'address', 'social_links', 'announcement', 'seo_title',
  'seo_description', 'enable_delivery', 'enable_pickup', 'min_order_amount', 'fulfilment_branch_id',
];

function checkTheme(data) {
  if (data.theme !== undefined && (data.theme === null || typeof data.theme !== 'object' || Array.isArray(data.theme))) {
    throw ApiError.unprocessable('theme must be an object of colours, fonts and layout options');
  }
  if (data.social_links !== undefined && (typeof data.social_links !== 'object' || Array.isArray(data.social_links))) {
    throw ApiError.unprocessable('social_links must be an object');
  }
}

// GET /storefront/settings
exports.getSettings = asyncHandler(async (req, res) => {
  const settings = await run(req, (db) => StorefrontSettings.get(db));
  return ok(res, settings);
});

// PUT /storefront/settings
exports.saveSettings = asyncHandler(async (req, res) => {
  const data = pick(req.body, SETTINGS_FIELDS);
  checkTheme(data);

  const settings = await run(req, async (db) => {
    if (data.fulfilment_branch_id) {
      const branch = await Branch.findById(db, data.fulfilment_branch_id);
      if (!branch || !branch.is_active) throw ApiError.unprocessable('Choose an active branch to fulfil online orders');
    }
    const record = await StorefrontSettings.save(db, data);
    await audit(db, req, 'storefront.settings', 'storefront_settings', record.id, { fields: Object.keys(data) });
    return record;
  });
  return ok(res, settings);
});

// POST /storefront/publish   the store goes live (needs a fulfilment branch and a way to be paid)
exports.publish = asyncHandler(async (req, res) => {
  const settings = await run(req, async (db) => {
    if (!(await TenantFeature.isEnabled(db, 'storefront'))) {
      throw ApiError.forbidden('The online storefront is not enabled for your shop');
    }
    const current = await StorefrontSettings.get(db);
    if (!current || !current.fulfilment_branch_id) {
      throw ApiError.unprocessable('Choose the branch that fulfils online orders before publishing');
    }
    if (!(await MpesaConfig.getDefault(db))) {
      throw ApiError.unprocessable('Set up M-Pesa first so customers can pay online');
    }
    if (!current.enable_delivery && !current.enable_pickup) {
      throw ApiError.unprocessable('Enable delivery, pickup or both');
    }
    const record = await StorefrontSettings.update(db, current.id, { is_published: true });
    await audit(db, req, 'storefront.publish', 'storefront_settings', current.id, null);
    return record;
  });
  return ok(res, settings);
});

// POST /storefront/unpublish
exports.unpublish = asyncHandler(async (req, res) => {
  const settings = await run(req, async (db) => {
    const current = await StorefrontSettings.get(db);
    if (!current) throw ApiError.notFound('Storefront is not set up yet');
    const record = await StorefrontSettings.update(db, current.id, { is_published: false });
    await audit(db, req, 'storefront.unpublish', 'storefront_settings', current.id, null);
    return record;
  });
  return ok(res, settings);
});

// Banners, pages and delivery zones: list / get / create / update / remove
exports.banners = makeCrud(StorefrontBanner, { label: 'Banner' });

exports.pages = makeCrud(StorefrontPage, {
  label: 'Page',
  beforeCreate: async (db, req, data) => {
    data.slug = slugify(data.slug || data.title);
    if (!data.slug) throw ApiError.unprocessable('A page needs a title');
    if (data.content && data.content.length > 20000) throw ApiError.unprocessable('Page content is too long');
    return data;
  },
  beforeUpdate: async (db, req, data) => {
    if (data.slug) data.slug = slugify(data.slug);
    if (data.content && data.content.length > 20000) throw ApiError.unprocessable('Page content is too long');
    return data;
  },
});

exports.zones = makeCrud(DeliveryZone, { label: 'Delivery zone' });
