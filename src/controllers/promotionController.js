'use strict';

/** Promotions: offers the till applies automatically (multi-buy, bundle price, percent or amount off). */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/respond');
const { run } = require('../utils/context');
const { audit } = require('../utils/audit');
const { Promotion } = require('../models');
const KPromo = require('../../public/js/promo-engine');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARAMS = ['buy_qty', 'get_qty', 'limit_per_sale', 'bundle_qty', 'bundle_price', 'percent_off', 'amount_off'];

const blank = (v) => v === undefined || v === null || v === '';

/** Turns a request into the columns to save. Parameters that do not belong to the chosen type are cleared. */
function clean(body, existing = {}) {
  const merged = { ...existing, ...body };
  const name = String(merged.name || '').trim();
  if (!name) throw ApiError.unprocessable('Give the offer a name');
  if (name.length > 80) throw ApiError.unprocessable('The name is at most 80 characters');

  const data = { name, type: merged.type };
  for (const key of PARAMS) data[key] = blank(merged[key]) ? null : Number(merged[key]);
  for (const key of ['starts_at', 'ends_at']) {
    if (blank(merged[key])) data[key] = null;
    else {
      const d = new Date(merged[key]);
      if (Number.isNaN(d.getTime())) throw ApiError.unprocessable(`${key} is not a valid date and time`);
      data[key] = d.toISOString();
    }
  }
  const why = KPromo.problem(data);
  if (why) throw ApiError.unprocessable(why, undefined, 'invalid_promotion');

  const keep = {
    multi_buy: ['buy_qty', 'get_qty', 'limit_per_sale'],
    bundle: ['bundle_qty', 'bundle_price'],
    percent: ['percent_off'],
    amount: ['amount_off'],
  }[data.type];
  for (const key of PARAMS) if (!keep.includes(key)) data[key] = null;

  data.priority = blank(merged.priority) ? 0 : Math.trunc(Number(merged.priority)) || 0;
  data.is_active = merged.is_active === undefined ? true : Boolean(merged.is_active);
  data.branch_id = blank(merged.branch_id) ? null : String(merged.branch_id);
  if (data.branch_id && !UUID.test(data.branch_id)) throw ApiError.unprocessable('branch_id is not valid');
  return data;
}

function cleanVariantIds(list) {
  if (!Array.isArray(list) || !list.length) throw ApiError.unprocessable('Choose at least one item for this offer');
  const ids = [...new Set(list.map(String))];
  if (ids.length > 500 || ids.some((id) => !UUID.test(id))) throw ApiError.unprocessable('The list of items is not valid');
  return ids;
}

// GET /promotions
exports.list = asyncHandler(async (req, res) => {
  const rows = await run(req, (db) => Promotion.listWithCounts(db));
  return ok(res, rows);
});

// GET /promotions/:id
exports.get = asyncHandler(async (req, res) => {
  const promo = await run(req, (db) => Promotion.getWithItems(db, req.params.id));
  if (!promo) throw ApiError.notFound('Promotion not found');
  return ok(res, promo);
});

// POST /promotions  { name, type, buy_qty, get_qty, bundle_qty, bundle_price, percent_off, amount_off, limit_per_sale,
//                     starts_at, ends_at, priority, branch_id, is_active, variant_ids: [] }
exports.create = asyncHandler(async (req, res) => {
  const data = clean(req.body);
  const variantIds = cleanVariantIds(req.body.variant_ids);
  const promo = await run(req, async (db) => {
    const record = await Promotion.create(db, { ...data, created_by: req.user.id });
    await Promotion.setItems(db, record.id, variantIds);
    await audit(db, req, 'promotion.create', 'promotion', record.id, { name: record.name, type: record.type });
    return Promotion.getWithItems(db, record.id);
  });
  return created(res, promo);
});

// PATCH /promotions/:id   (send only what changes; variant_ids replaces the items)
exports.update = asyncHandler(async (req, res) => {
  const promo = await run(req, async (db) => {
    const existing = await Promotion.findById(db, req.params.id);
    if (!existing) throw ApiError.notFound('Promotion not found');
    // a type change must not keep the old type's numbers, so only the body and the stored type are merged
    const data = clean(req.body, req.body.type && req.body.type !== existing.type ? { name: existing.name } : existing);
    const variantIds = req.body.variant_ids === undefined ? null : cleanVariantIds(req.body.variant_ids);
    await Promotion.update(db, existing.id, data);
    if (variantIds) await Promotion.setItems(db, existing.id, variantIds);
    await Promotion.touch(db, existing.id);
    await audit(db, req, 'promotion.update', 'promotion', existing.id, { after: { ...data, items: variantIds ? variantIds.length : undefined } });
    return Promotion.getWithItems(db, existing.id);
  });
  return ok(res, promo);
});

// DELETE /promotions/:id   (sales already made keep the offer's name on their lines)
exports.remove = asyncHandler(async (req, res) => {
  await run(req, async (db) => {
    const record = await Promotion.remove(db, req.params.id);
    if (!record) throw ApiError.notFound('Promotion not found');
    await audit(db, req, 'promotion.delete', 'promotion', record.id, { name: record.name });
  });
  return ok(res, { deleted: true });
});
