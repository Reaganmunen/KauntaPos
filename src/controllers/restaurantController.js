'use strict';

/**
 * Restaurant module: tables, open tabs, kitchen display, modifiers and recipes.
 * Switch it on per shop with the "restaurant" feature flag.
 */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created } = require('../utils/respond');
const { requireFields, oneOf, nonEmptyArray, positive } = require('../utils/validate');
const { run, branchId } = require('../utils/context');
const { audit } = require('../utils/audit');
const { makeCrud } = require('../utils/crud');
const {
  DiningTable, Sale, ModifierGroup, Modifier, RecipeItem, ProductVariant,
} = require('../models');

// ---------- tables ----------

const tables = makeCrud(DiningTable, { label: 'Table' });
exports.getTable = tables.get;
exports.createTable = tables.create;
exports.updateTable = tables.update;
exports.removeTable = tables.remove;

// GET /restaurant/tables   active tables for the branch
exports.listTables = asyncHandler(async (req, res) => {
  const branch = branchId(req);
  const rows = await run(req, (db) => DiningTable.forBranch(db, branch));
  return ok(res, rows);
});

// GET /restaurant/floor   tables with their open tab (id, number, running total)
exports.floorPlan = asyncHandler(async (req, res) => {
  const branch = branchId(req);
  const rows = await run(req, (db) => DiningTable.floorPlan(db, branch));
  return ok(res, rows);
});

// PUT /restaurant/tables/:id/status  { status: 'available'|'occupied'|'reserved'|'cleaning' }
exports.setTableStatus = asyncHandler(async (req, res) => {
  requireFields(req.body, ['status']);
  oneOf(req.body.status, ['available', 'occupied', 'reserved', 'cleaning'], 'status');
  const table = await run(req, (db) => DiningTable.setStatus(db, req.params.id, req.body.status));
  if (!table) throw ApiError.notFound('Table not found');
  return ok(res, table);
});

// ---------- tabs and kitchen ----------

// GET /restaurant/tabs?table_id=   open tabs for the branch
exports.openTabs = asyncHandler(async (req, res) => {
  const branch = branchId(req);
  const rows = await run(req, (db) => Sale.openTabs(db, branch, { tableId: req.query.table_id }));
  return ok(res, rows);
});

// GET /restaurant/kitchen?station=kitchen|bar   items waiting / preparing / ready, oldest first
exports.kitchenQueue = asyncHandler(async (req, res) => {
  const branch = branchId(req);
  const rows = await run(req, (db) => Sale.kitchenQueue(db, branch, { station: req.query.station }));
  return ok(res, rows);
});

// POST /restaurant/tabs/:saleId/send   sends all new lines of the tab to the kitchen
exports.sendToKitchen = asyncHandler(async (req, res) => {
  const items = await run(req, async (db) => {
    const sale = await Sale.findById(db, req.params.saleId);
    if (!sale) throw ApiError.notFound('Tab not found');
    if (sale.status !== 'open') throw ApiError.conflict('This tab is not open');
    const sent = await Sale.sendToKitchen(db, sale.id);
    await audit(db, req, 'kitchen.send', 'sale', sale.id, { lines: sent.length });
    return sent;
  });
  return ok(res, { sent: items.length, items });
});

// PUT /restaurant/kitchen/items/:itemId  { status: 'preparing'|'ready'|'served'|'cancelled' }
exports.setKitchenStatus = asyncHandler(async (req, res) => {
  requireFields(req.body, ['status']);
  oneOf(req.body.status, ['new', 'preparing', 'ready', 'served', 'cancelled'], 'status');
  const item = await run(req, (db) => Sale.setItemKitchenStatus(db, req.params.itemId, req.body.status));
  if (!item) throw ApiError.notFound('Order line not found');
  return ok(res, item);
});

// ---------- modifiers ----------

const groups = makeCrud(ModifierGroup, { label: 'Modifier group' });
exports.getModifierGroup = groups.get;
exports.createModifierGroup = groups.create;
exports.updateModifierGroup = groups.update;
exports.removeModifierGroup = groups.remove;

// GET /restaurant/modifier-groups   every group with its modifiers
exports.listModifierGroups = asyncHandler(async (req, res) => {
  const rows = await run(req, (db) => ModifierGroup.listWithModifiers(db));
  return ok(res, rows);
});

const modifiers = makeCrud(Modifier, { label: 'Modifier' });
exports.createModifier = modifiers.create;
exports.updateModifier = modifiers.update;
exports.removeModifier = modifiers.remove;

// GET /restaurant/modifier-groups/:id/modifiers
exports.listModifiers = asyncHandler(async (req, res) => {
  const rows = await run(req, (db) => Modifier.forGroup(db, req.params.id));
  return ok(res, rows);
});

// ---------- recipes ----------

// GET /restaurant/recipes/:dishVariantId
exports.getRecipe = asyncHandler(async (req, res) => {
  const rows = await run(req, (db) => RecipeItem.forDish(db, req.params.dishVariantId));
  return ok(res, rows);
});

// PUT /restaurant/recipes/:dishVariantId  { items: [{ ingredient_variant_id, quantity }] }
// Selling the dish then deducts these ingredients from stock.
exports.setRecipe = asyncHandler(async (req, res) => {
  const items = nonEmptyArray(req.body.items, 'items');
  for (const item of items) {
    requireFields(item, ['ingredient_variant_id']);
    positive(item.quantity, 'ingredient quantity');
    if (item.ingredient_variant_id === req.params.dishVariantId) {
      throw ApiError.unprocessable('A dish cannot be an ingredient of itself');
    }
  }
  const recipe = await run(req, async (db) => {
    const dish = await ProductVariant.findById(db, req.params.dishVariantId);
    if (!dish) throw ApiError.notFound('Dish not found');
    const rows = await RecipeItem.replaceForDish(db, dish.id, items);
    await audit(db, req, 'recipe.set', 'product_variant', dish.id, { ingredients: items.length });
    return rows;
  });
  return ok(res, recipe);
});
