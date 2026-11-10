'use strict';

/**
 * The shop owner's side of the online store: settings, banners, pages, delivery zones, and the
 * online order queue. (The customer-facing API is in publicStore.js, mounted at /store.)
 */
const express = require('express');
const { can, requireFeature, resolveBranch } = require('../middleware');
const { crudRoutes } = require('./guards');
const admin = require('../controllers/storefrontAdminController');
const orders = require('../controllers/onlineOrderController');

// ---------- /storefront ----------
const storefrontRouter = express.Router();
const manage = can('storefront.manage');
storefrontRouter.use(requireFeature('storefront'));

storefrontRouter.get('/settings', manage, admin.getSettings);
storefrontRouter.put('/settings', manage, admin.saveSettings);
storefrontRouter.post('/publish', manage, admin.publish);
storefrontRouter.post('/unpublish', manage, admin.unpublish);

crudRoutes(storefrontRouter, '/banners', admin.banners, { read: [manage], write: [manage] });
crudRoutes(storefrontRouter, '/pages', admin.pages, { read: [manage], write: [manage] });
crudRoutes(storefrontRouter, '/delivery-zones', admin.zones, { read: [manage], write: [manage] });

// ---------- /online-orders ----------
const ordersRouter = express.Router();
const handle = can('orders.online');
ordersRouter.use(requireFeature('storefront'));

ordersRouter.get('/counts', handle, resolveBranch(), orders.counts); // before /:id
ordersRouter.get('/', handle, resolveBranch(), orders.list);
ordersRouter.get('/:id', handle, orders.get);
ordersRouter.put('/:id/status', handle, orders.setStatus);

module.exports = { storefrontRouter, ordersRouter };
