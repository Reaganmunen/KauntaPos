'use strict';

/**
 * The catalogue: categories, brands, units, tax classes, price lists, products and variants.
 *
 * Reading: the till (pos.sell) may read the small lookup lists and search products through
 * /products/pos/search, but the full product endpoints include cost prices, so those need
 * products.view (or a stock / purchasing role).
 */
const express = require('express');
const { can, canAny, resolveBranch } = require('../middleware');
const { crudRoutes } = require('./guards');
const categories = require('../controllers/categoryController');
const lookups = require('../controllers/lookupController');
const priceLists = require('../controllers/priceListController');
const products = require('../controllers/productController');

const lookupRead = canAny('products.view', 'products.manage', 'pos.sell', 'inventory.view', 'purchases.manage');
const productRead = canAny('products.view', 'products.manage', 'inventory.view', 'purchases.manage');
const manage = can('products.manage');

// ---------- /categories ----------
const categoriesRouter = express.Router();
crudRoutes(categoriesRouter, '/', categories, { read: [lookupRead], write: [manage] });

// ---------- /brands, /units ----------
const brandsRouter = express.Router();
crudRoutes(brandsRouter, '/', lookups.brands, { read: [lookupRead], write: [manage] });

const unitsRouter = express.Router();
crudRoutes(unitsRouter, '/', lookups.units, { read: [lookupRead], write: [manage] });

// ---------- /tax-classes ----------
// Tax rates feed straight into VAT and KRA eTIMS, so changing them is a settings job.
const taxRouter = express.Router();
crudRoutes(taxRouter, '/', lookups.taxClasses, { read: [lookupRead], write: [can('settings.manage')] });
taxRouter.post('/:id/default', can('settings.manage'), lookups.setDefaultTaxClass);

// ---------- /price-lists ----------
const priceListsRouter = express.Router();
crudRoutes(priceListsRouter, '/', priceLists, { read: [lookupRead], write: [manage] });
priceListsRouter.get('/:id/items', lookupRead, priceLists.getItems);
priceListsRouter.put('/:id/items', manage, priceLists.setItems);
priceListsRouter.delete('/:id/items/:variantId', manage, priceLists.removeItem);
priceListsRouter.post('/:id/default', manage, priceLists.setDefault);

// ---------- /products ----------
const productsRouter = express.Router();

// fixed paths first, so they are never mistaken for /:id
productsRouter.get('/pos/search', can('pos.sell'), resolveBranch({ required: true }), products.posSearch);
productsRouter.get('/low-stock', canAny('products.view', 'inventory.view'), resolveBranch({ required: true }), products.lowStock);
productsRouter.post('/import', manage, resolveBranch(), products.bulkImport);

productsRouter.get('/', productRead, products.list);
productsRouter.post('/', manage, resolveBranch(), products.create);
productsRouter.get('/:id', productRead, products.get);
productsRouter.patch('/:id', manage, products.update);
productsRouter.delete('/:id', manage, products.remove);

productsRouter.get('/:id/variants', productRead, products.listVariants);
productsRouter.post('/:id/variants', manage, resolveBranch(), products.createVariant);
productsRouter.patch('/:id/variants/:variantId', manage, products.updateVariant);
productsRouter.post('/:id/variants/:variantId/default', manage, products.setDefaultVariant);
productsRouter.delete('/:id/variants/:variantId', manage, products.removeVariant);

productsRouter.post('/:id/images', manage, products.addImage);
productsRouter.post('/:id/images/:imageId/primary', manage, products.setPrimaryImage);
productsRouter.delete('/:id/images/:imageId', manage, products.removeImage);

module.exports = { categoriesRouter, brandsRouter, unitsRouter, taxRouter, priceListsRouter, productsRouter };
