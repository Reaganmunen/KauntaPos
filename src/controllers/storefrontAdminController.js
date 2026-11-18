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

// ---------- picture upload ----------
// Pictures live in the database (storefront_media), not on disk, so they survive redeploys and work on
// hosts without a persistent disk. The page shrinks the picture in the browser and sends it as a data URL.
// mediaController.serve hands it back at /media/<tenant>/<id>.
const MAX_IMAGE_BYTES = 1024 * 1024;
const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// Decide the real type from the first bytes. The declared type and file name are never trusted.
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// POST /storefront/upload   { kind: 'logo' | 'banner', data: 'data:image/webp;base64,...' }  returns { url }
exports.uploadImage = asyncHandler(async (req, res) => {
  const data = req.body && req.body.data;
  const comma = typeof data === 'string' ? data.indexOf(',') : -1;
  if (comma < 0 || !/^data:image\/(png|jpeg|webp|gif);base64$/.test(data.slice(0, comma))) {
    throw ApiError.unprocessable('Upload a PNG, JPG, WebP or GIF picture');
  }
  const buf = Buffer.from(data.slice(comma + 1), 'base64');
  if (!buf.length) throw ApiError.unprocessable('That picture is empty');
  if (buf.length > MAX_IMAGE_BYTES) throw ApiError.unprocessable('That picture is too large. Keep it under 1 MB.');
  const ext = sniffImage(buf);
  if (!ext) throw ApiError.unprocessable('That file is not a picture we can use');

  const kind = ['logo', 'banner'].includes(req.body.kind) ? req.body.kind : 'image';
  const row = await run(req, async (db) => {
    const { rows } = await db.query(
      'INSERT INTO storefront_media (tenant_id, kind, mime_type, byte_size, data) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [req.tenantId, kind, MIME[ext], buf.length, buf]
    );
    return rows[0];
  });
  return ok(res, { url: `/media/${req.tenantId}/${row.id}`, bytes: buf.length });
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