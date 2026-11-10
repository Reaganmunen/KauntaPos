'use strict';

/**
 * Restaurant module: tables, open tabs, kitchen display, modifiers and recipes.
 * Tables, tabs and the kitchen need the "restaurant" module; modifiers and recipes have their own
 * switches ("modifiers", "recipes"), as in the shop's feature flags.
 */
const express = require('express');
const { can, canAny, requireFeature, resolveBranch } = require('../middleware');
const restaurant = require('../controllers/restaurantController');

const router = express.Router();

const seeFloor = canAny('pos.sell', 'kitchen.view');
const catalogRead = canAny('products.view', 'products.manage', 'pos.sell');

// ---------- tables, tabs, kitchen ----------
const floor = requireFeature('restaurant');

router.get('/tables', floor, seeFloor, resolveBranch({ required: true }), restaurant.listTables);
router.post('/tables', floor, can('settings.manage'), restaurant.createTable);
router.get('/tables/:id', floor, seeFloor, restaurant.getTable);
router.patch('/tables/:id', floor, can('settings.manage'), restaurant.updateTable);
router.delete('/tables/:id', floor, can('settings.manage'), restaurant.removeTable);
router.put('/tables/:id/status', floor, can('pos.sell'), restaurant.setTableStatus);

router.get('/floor', floor, seeFloor, resolveBranch({ required: true }), restaurant.floorPlan);
router.get('/tabs', floor, can('pos.sell'), resolveBranch({ required: true }), restaurant.openTabs);
router.post('/tabs/:saleId/send', floor, can('pos.sell'), restaurant.sendToKitchen);

router.get('/kitchen', floor, can('kitchen.view'), resolveBranch({ required: true }), restaurant.kitchenQueue);
router.put('/kitchen/items/:itemId', floor, can('kitchen.view'), restaurant.setKitchenStatus);

// ---------- modifiers ----------
const modifiers = requireFeature('modifiers');

router.get('/modifier-groups', modifiers, catalogRead, restaurant.listModifierGroups);
router.post('/modifier-groups', modifiers, can('products.manage'), restaurant.createModifierGroup);
router.get('/modifier-groups/:id', modifiers, catalogRead, restaurant.getModifierGroup);
router.patch('/modifier-groups/:id', modifiers, can('products.manage'), restaurant.updateModifierGroup);
router.delete('/modifier-groups/:id', modifiers, can('products.manage'), restaurant.removeModifierGroup);
router.get('/modifier-groups/:id/modifiers', modifiers, catalogRead, restaurant.listModifiers);

router.post('/modifiers', modifiers, can('products.manage'), restaurant.createModifier);
router.patch('/modifiers/:id', modifiers, can('products.manage'), restaurant.updateModifier);
router.delete('/modifiers/:id', modifiers, can('products.manage'), restaurant.removeModifier);

// ---------- recipes ----------
const recipes = requireFeature('recipes');

router.get('/recipes/:dishVariantId', recipes, canAny('products.view', 'products.manage'), restaurant.getRecipe);
router.put('/recipes/:dishVariantId', recipes, can('products.manage'), restaurant.setRecipe);

module.exports = router;
