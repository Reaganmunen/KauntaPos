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

// ---------- /chat (customer questions from the storefront) ----------
const chatRouter = express.Router();
const chat = require('../controllers/chatController');
const { canAny } = require('../middleware');
const answer = canAny('orders.online', 'storefront.manage');
chatRouter.use(requireFeature('storefront'));

chatRouter.get('/unread', answer, chat.staffUnread);
chatRouter.get('/push/key', answer, chat.pushKey);
chatRouter.post('/push/subscribe', answer, chat.pushSubscribe);
chatRouter.post('/push/unsubscribe', answer, chat.pushUnsubscribe);
chatRouter.get('/threads', answer, chat.staffList);
chatRouter.get('/threads/:id', answer, chat.staffGet);
chatRouter.post('/threads/:id/messages', answer, chat.staffSend);
chatRouter.put('/threads/:id/status', answer, chat.staffStatus);

module.exports = { storefrontRouter, ordersRouter, chatRouter };