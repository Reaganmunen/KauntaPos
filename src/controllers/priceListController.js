'use strict';

/** Price lists (Retail, Wholesale, custom) with per-variant and quantity-break prices. */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/respond');
const { requireFields, nonEmptyArray } = require('../utils/validate');
const { run } = require('../utils/context');
const { audit } = require('../utils/audit');
const { makeCrud } = require('../utils/crud');
const { PriceList } = require('../models');

Object.assign(exports, makeCrud(PriceList, { label: 'Price list' }));

// GET /price-lists/:id/items
exports.getItems = asyncHandler(async (req, res) => {
  const items = await run(req, (db) => PriceList.getItems(db, req.params.id));
  return ok(res, items);
});

// PUT /price-lists/:id/items  { items: [{ variant_id, price, min_quantity }] }  (insert or update)
exports.setItems = asyncHandler(async (req, res) => {
  const items = nonEmptyArray(req.body.items, 'items');
  for (const item of items) requireFields(item, ['variant_id', 'price']);

  const result = await run(req, async (db) => {
    const list = await PriceList.findById(db, req.params.id);
    if (!list) throw ApiError.notFound('Price list not found');
    const saved = await PriceList.setItems(db, list.id, items);
    await audit(db, req, 'price_list.items', 'price_list', list.id, { count: items.length });
    return saved;
  });
  return ok(res, result);
});

// DELETE /price-lists/:id/items/:variantId?min_quantity=1
exports.removeItem = asyncHandler(async (req, res) => {
  const minQuantity = req.query.min_quantity ? Number(req.query.min_quantity) : 1;
  await run(req, (db) => PriceList.removeItem(db, req.params.id, req.params.variantId, minQuantity));
  return ok(res, { deleted: true });
});

// POST /price-lists/:id/default
exports.setDefault = asyncHandler(async (req, res) => {
  const list = await run(req, (db) => PriceList.setDefault(db, req.params.id));
  if (!list) throw ApiError.notFound('Price list not found');
  return ok(res, list);
});
