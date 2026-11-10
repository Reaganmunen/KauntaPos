'use strict';

/**
 * The customer-facing storefront API. No login: the shop comes from the subdomain (req.tenantId,
 * set by the tenant-resolution middleware) and the shopper is identified by an unguessable cart
 * token (X-Cart-Token header) and, after checkout, an order tracking token.
 * Only public-safe fields leave this file: never cost prices, stock quantities beyond "available",
 * or internal ids the page does not need.
 */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/respond');
const { requireFields, oneOf, positive, pick } = require('../utils/validate');
const { run, pageParams } = require('../utils/context');
const {
  StorefrontSettings, StorefrontPage, Category, Product, ProductVariant, ProductImage,
  StockLevel, Cart, OnlineOrder,
} = require('../models');
const StorefrontService = require('../services/StorefrontService');

const PUBLIC_SETTINGS = [
  'store_name', 'tagline', 'logo_url', 'favicon_url', 'theme_key', 'theme', 'contact_phone',
  'contact_email', 'whatsapp_number', 'address', 'social_links', 'announcement', 'seo_title',
  'seo_description', 'enable_delivery', 'enable_pickup', 'min_order_amount',
];

// The published storefront settings plus the branch that fulfils orders, or 404.
async function storefront(db) {
  const settings = await StorefrontSettings.get(db);
  if (!settings || !settings.is_published || !settings.fulfilment_branch_id) {
    throw ApiError.notFound('This store is not available right now');
  }
  return { settings, branchId: settings.fulfilment_branch_id };
}

async function getCart(db, req, { create = false } = {}) {
  const token = req.get('x-cart-token') || req.query.cart;
  let cart = token ? await Cart.findByToken(db, token) : null;
  if (!cart && create) cart = await Cart.create(db, {});
  if (!cart) throw ApiError.notFound('Cart not found');
  return cart;
}

// Variant must be online, active and (for stock-tracked items) have enough available stock.
async function checkSellable(db, branchId, cartId, variantId, wantedQuantity) {
  const { rows } = await db.query(
    `SELECT v.id, p.track_stock, p.product_type,
            COALESCE(a.quantity_available, 0) AS available,
            COALESCE(pp.drug_schedule, 'otc') AS drug_schedule,
            COALESCE(pp.requires_prescription, false) AS requires_prescription,
            COALESCE((SELECT ci.quantity FROM cart_items ci WHERE ci.cart_id = $3 AND ci.variant_id = v.id), 0) AS in_cart
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       LEFT JOIN product_pharma pp ON pp.product_id = p.id
       LEFT JOIN v_stock_available a ON a.variant_id = v.id AND a.branch_id = $2
      WHERE v.id = $1 AND v.deleted_at IS NULL AND v.is_active
        AND p.deleted_at IS NULL AND p.is_active AND p.is_online`,
    [variantId, branchId, cartId]
  );
  const row = rows[0];
  if (!row) throw ApiError.notFound('That product is not available');
  if (row.drug_schedule !== 'otc' || row.requires_prescription) {
    throw ApiError.unprocessable('This medicine cannot be bought online. Please visit the pharmacy.');
  }
  if (row.track_stock && Number(row.in_cart) + wantedQuantity > Number(row.available)) {
    throw ApiError.conflict(`Only ${Math.max(Number(row.available) - Number(row.in_cart), 0)} more available`);
  }
  return row;
}

// ---------- catalogue ----------

// GET /storefront   settings, banners, pages, delivery zones in one call
exports.bundle = asyncHandler(async (req, res) => {
  const data = await run(req, async (db) => {
    await storefront(db);
    const bundle = await StorefrontSettings.getPublicBundle(db);
    if (!bundle) throw ApiError.notFound('This store is not available right now');
    return {
      settings: pick(bundle.settings, PUBLIC_SETTINGS),
      banners: bundle.banners,
      pages: bundle.pages,
      delivery_zones: bundle.delivery_zones,
    };
  });
  return ok(res, data);
});

// GET /storefront/categories
exports.categories = asyncHandler(async (req, res) => {
  const tree = await run(req, async (db) => {
    await storefront(db);
    return Category.tree(db, { onlineOnly: true });
  });
  return ok(res, tree);
});

// GET /storefront/products?category_id=&q=&page=
exports.products = asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const result = await run(req, async (db) => {
    const { branchId } = await storefront(db);
    return Product.listOnline(db, {
      branchId,
      category_id: req.query.category_id,
      q: req.query.q,
      page,
      limit: Math.min(limit, 48),
    });
  });
  return paginated(res, result);
});

// GET /storefront/products/:slug
exports.product = asyncHandler(async (req, res) => {
  const data = await run(req, async (db) => {
    const { branchId } = await storefront(db);
    const product = await Product.findBySlug(db, req.params.slug);
    if (!product || !product.is_online || !product.is_active) return null;

    const variants = (await ProductVariant.forProduct(db, product.id)).filter((v) => v.is_active);
    const availability = await StockLevel.availability(db, branchId, variants.map((v) => v.id));
    const available = new Map(availability.map((a) => [a.variant_id, Number(a.quantity_available)]));
    const images = await ProductImage.forProduct(db, product.id);

    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      description: product.online_description || product.description,
      seo_title: product.seo_title,
      seo_description: product.seo_description,
      category_id: product.category_id,
      images: images.map((i) => ({ url: i.url, alt_text: i.alt_text, variant_id: i.variant_id, is_primary: i.is_primary })),
      variants: variants.map((v) => {
        const qty = Math.max(available.get(v.id) || 0, 0);
        return {
          id: v.id,
          name: v.name,
          option_values: v.option_values,
          price: v.selling_price,
          in_stock: !product.track_stock || qty > 0,
          available: product.track_stock ? qty : null,
        };
      }),
    };
  });
  if (!data) throw ApiError.notFound('Product not found');
  return ok(res, data);
});

// GET /storefront/pages/:slug
exports.page = asyncHandler(async (req, res) => {
  const page = await run(req, async (db) => {
    await storefront(db);
    return StorefrontPage.findBySlug(db, req.params.slug, { publishedOnly: true });
  });
  if (!page) throw ApiError.notFound('Page not found');
  return ok(res, pick(page, ['slug', 'title', 'content']));
});

// ---------- cart ----------

// POST /storefront/cart   starts a cart; keep the returned token and send it as X-Cart-Token
exports.createCart = asyncHandler(async (req, res) => {
  const cart = await run(req, async (db) => {
    await storefront(db);
    return Cart.create(db, {});
  });
  return created(res, { token: cart.token, expires_at: cart.expires_at });
});

// GET /storefront/cart
exports.getCart = asyncHandler(async (req, res) => {
  const data = await run(req, async (db) => {
    const { branchId } = await storefront(db);
    const cart = await getCart(db, req);
    return Cart.getWithItems(db, cart.id, branchId);
  });
  return ok(res, data);
});

// POST /storefront/cart/items  { variant_id, quantity }
exports.addItem = asyncHandler(async (req, res) => {
  requireFields(req.body, ['variant_id']);
  const quantity = req.body.quantity === undefined ? 1 : positive(req.body.quantity, 'quantity');

  const data = await run(req, async (db) => {
    const { branchId } = await storefront(db);
    const cart = await getCart(db, req);
    await checkSellable(db, branchId, cart.id, req.body.variant_id, quantity);
    await Cart.addItem(db, cart.id, req.body.variant_id, quantity);
    return Cart.getWithItems(db, cart.id, branchId);
  });
  return ok(res, data);
});

// PATCH /storefront/cart/items/:variantId  { quantity }   0 removes the line
exports.setQuantity = asyncHandler(async (req, res) => {
  requireFields(req.body, ['quantity']);
  const quantity = Number(req.body.quantity);
  if (!Number.isFinite(quantity) || quantity < 0) throw ApiError.unprocessable('quantity must be 0 or more');

  const data = await run(req, async (db) => {
    const { branchId } = await storefront(db);
    const cart = await getCart(db, req);
    // Take the old line out first so the stock check compares the NEW total, not old + new.
    await Cart.removeItem(db, cart.id, req.params.variantId);
    if (quantity > 0) {
      await checkSellable(db, branchId, cart.id, req.params.variantId, quantity);
      await Cart.addItem(db, cart.id, req.params.variantId, quantity);
    }
    return Cart.getWithItems(db, cart.id, branchId);
  });
  return ok(res, data);
});

// DELETE /storefront/cart/items/:variantId
exports.removeItem = asyncHandler(async (req, res) => {
  const data = await run(req, async (db) => {
    const { branchId } = await storefront(db);
    const cart = await getCart(db, req);
    await Cart.removeItem(db, cart.id, req.params.variantId);
    return Cart.getWithItems(db, cart.id, branchId);
  });
  return ok(res, data);
});

// ---------- checkout and orders ----------

// POST /storefront/checkout
// { customer_name, customer_phone, customer_email, fulfilment_type: 'delivery'|'pickup',
//   delivery_zone_id, delivery_address, delivery_notes, customer_note }
// Creates the order as a normal sale (channel 'online'), holds the stock, and returns a tracking token.
exports.checkout = asyncHandler(async (req, res) => {
  requireFields(req.body, ['customer_name', 'customer_phone', 'fulfilment_type']);
  oneOf(req.body.fulfilment_type, ['delivery', 'pickup'], 'fulfilment_type');
  if (req.body.fulfilment_type === 'delivery') requireFields(req.body, ['delivery_address']);

  const order = await run(req, async (db) => {
    const { branchId } = await storefront(db);
    const cart = await getCart(db, req);
    return StorefrontService.checkout(db, {
      cart_id: cart.id,
      branch_id: branchId,
      ...pick(req.body, [
        'customer_name', 'customer_phone', 'customer_email', 'fulfilment_type',
        'delivery_zone_id', 'delivery_address', 'delivery_notes', 'customer_note',
      ]),
    });
  });
  return created(res, order);
});

// POST /storefront/orders/:token/pay  { phone }   sends the M-Pesa prompt (STK Push) to the customer
exports.pay = asyncHandler(async (req, res) => {
  requireFields(req.body, ['phone']);
  const result = await run(req, async (db) => {
    await storefront(db);
    return StorefrontService.startPayment(db, { tracking_token: req.params.token, phone: req.body.phone });
  });
  return ok(res, result);
});

// GET /storefront/orders/:token   order status, payment status and lines (poll after paying)
exports.trackOrder = asyncHandler(async (req, res) => {
  const order = await run(req, (db) => OnlineOrder.findByTrackingToken(db, req.params.token));
  if (!order) throw ApiError.notFound('Order not found');
  const { sale_id, ...safe } = order; // internal id is not needed by the shopper
  return ok(res, safe);
});
