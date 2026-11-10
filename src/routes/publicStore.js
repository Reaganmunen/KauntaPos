'use strict';

/**
 * The customer-facing storefront API (mounted at /store). No login: the shop comes from the
 * subdomain / custom domain (or the X-Tenant header while developing), and the shopper is
 * identified by the cart token (X-Cart-Token) and later an order tracking token.
 * Shops that are suspended, expired or not published answer 404.
 */
const express = require('express');
const { resolveTenant, rateLimit } = require('../middleware');
const store = require('../controllers/storefrontPublicController');

const router = express.Router();

router.use(rateLimit.publicStore, resolveTenant({ required: true, blockInactive: true }));

// catalogue
router.get('/', store.bundle);
router.get('/categories', store.categories);
router.get('/products', store.products);
router.get('/products/:slug', store.product);
router.get('/pages/:slug', store.page);

// cart
router.post('/cart', store.createCart);
router.get('/cart', store.getCart);
router.post('/cart/items', store.addItem);
router.patch('/cart/items/:variantId', store.setQuantity);
router.delete('/cart/items/:variantId', store.removeItem);

// checkout and orders (tighter limits: these create orders and send M-Pesa prompts to phones)
router.post('/checkout', rateLimit.checkout, store.checkout);
router.get('/orders/:token', store.trackOrder);
router.post('/orders/:token/pay', rateLimit.checkout, store.pay);

module.exports = router;
