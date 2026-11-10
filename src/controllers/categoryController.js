'use strict';

const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/respond');
const { requireFields } = require('../utils/validate');
const { run, pageParams, toBool } = require('../utils/context');
const { audit } = require('../utils/audit');
const { slugify } = require('../utils/slugify');
const { Category } = require('../models');

// GET /categories?tree=true&online=true | ?counts=true | ?all=true | paged
exports.list = asyncHandler(async (req, res) => {
  if (toBool(req.query.tree)) {
    const tree = await run(req, (db) => Category.tree(db, { onlineOnly: toBool(req.query.online) === true }));
    return ok(res, tree);
  }
  if (toBool(req.query.counts)) {
    return ok(res, await run(req, (db) => Category.withProductCounts(db)));
  }
  if (toBool(req.query.all)) {
    return ok(res, await run(req, (db) => Category.findAll(db)));
  }
  const { page, limit } = pageParams(req);
  const result = await run(req, (db) => Category.paginate(db, { page, limit, orderBy: req.query.sort }));
  return paginated(res, result);
});

// GET /categories/:id
exports.get = asyncHandler(async (req, res) => {
  const row = await run(req, (db) => Category.findById(db, req.params.id));
  if (!row) throw ApiError.notFound('Category not found');
  return ok(res, row);
});

// POST /categories  { name, parent_id, image_url, sort_order, show_online, etims_item_class_code }
exports.create = asyncHandler(async (req, res) => {
  requireFields(req.body, ['name']);
  const category = await run(req, async (db) => {
    const record = await Category.createWithSlug(db, req.body);
    await audit(db, req, 'category.create', 'category', record.id, { name: record.name });
    return record;
  });
  return created(res, category);
});

// PATCH /categories/:id
exports.update = asyncHandler(async (req, res) => {
  const category = await run(req, async (db) => {
    const existing = await Category.findById(db, req.params.id);
    if (!existing) throw ApiError.notFound('Category not found');

    const data = { ...req.body };
    if (data.parent_id && data.parent_id === existing.id) {
      throw ApiError.unprocessable('A category cannot be its own parent');
    }
    if (data.slug) data.slug = await Category.uniqueSlug(db, slugify(data.slug), { excludeId: existing.id });

    const record = await Category.update(db, existing.id, data);
    await audit(db, req, 'category.update', 'category', existing.id, { after: req.body });
    return record;
  });
  return ok(res, category);
});

// DELETE /categories/:id  (products and sub-categories become uncategorised / top level)
exports.remove = asyncHandler(async (req, res) => {
  await run(req, async (db) => {
    const record = await Category.remove(db, req.params.id);
    if (!record) throw ApiError.notFound('Category not found');
    await audit(db, req, 'category.delete', 'category', record.id, { name: record.name });
  });
  return ok(res, { deleted: true });
});
