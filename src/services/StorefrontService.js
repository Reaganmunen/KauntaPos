'use strict';

/**
 * Online store orders. An order is a normal sale (channel 'online') plus an online_orders row:
 *
 *   checkout      -> sale (status 'open', stock NOT yet booked) + order 'awaiting_payment'
 *                    + stock reservations (30 min) so nobody else can buy the same items
 *   startPayment  -> STK Push to the customer's phone (MpesaService)
 *   payment lands -> PaymentService -> SaleService.afterPayment -> onPaid(): reservations become
 *                    real stock movements, order becomes 'paid', the sale is completed and queued for eTIMS
 *   updateStatus  -> the shop moves the order along; cancelling voids (or refunds) the sale
 *
 * Delivery fees are sold as a normal service line ("Delivery fee", created on first use) so totals,
 * VAT and the eTIMS invoice stay consistent.
 */
const ApiError = require('../utils/ApiError');
const { round2 } = require('../utils/money');
const {
  Sale, Cart, Customer, DeliveryZone, OnlineOrder, StockReservation, StorefrontSettings,
  Product, ProductVariant, TaxClass, EtimsInvoice, StockLevel,
} = require('../models');
const InventoryService = require('./InventoryService');
const SaleService = require('./SaleService');
const MpesaService = require('./MpesaService');

const HOLD_MINUTES = 30;
const PAYMENT_HOLD_MINUTES = 10;

/**
 * Allowed moves. Everything after awaiting_payment needs the sale to be paid.
 * (Pay on delivery: record the cash payment on the sale and the order moves to 'paid'.)
 */
const NEXT = {
  awaiting_payment: ['paid', 'cancelled'],
  paid: ['processing', 'ready', 'out_for_delivery', 'completed', 'cancelled'],
  processing: ['ready', 'out_for_delivery', 'completed', 'cancelled'],
  ready: ['out_for_delivery', 'completed', 'cancelled'],
  out_for_delivery: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

// ---------- helpers ----------

async function deliveryVariant(db) {
  let product = await Product.findBySlug(db, 'delivery-fee');
  if (!product) {
    const tax = await TaxClass.getDefault(db);
    product = await Product.createWithVariants(
      db,
      {
        name: 'Delivery fee',
        slug: 'delivery-fee',
        product_type: 'service',
        track_stock: false,
        is_online: false,
        is_active: true,
        tax_class_id: tax ? tax.id : undefined,
      },
      [{ name: 'Default', selling_price: 0, cost_price: 0 }]
    );
    return product.variants[0];
  }
  const variants = await ProductVariant.forProduct(db, product.id);
  return variants[0];
}

/** Every item must still be sold online, in stock, and not a prescription medicine. */
async function assertCartSellable(db, branchId, items) {
  const { rows } = await db.query(
    `SELECT v.id, p.name, p.track_stock, p.is_online, p.is_active AS p_active, v.is_active AS v_active,
            COALESCE(pp.drug_schedule, 'otc') AS drug_schedule,
            COALESCE(pp.requires_prescription, false) AS requires_prescription,
            COALESCE(a.quantity_available, 0) AS available
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       LEFT JOIN product_pharma pp ON pp.product_id = p.id
       LEFT JOIN v_stock_available a ON a.variant_id = v.id AND a.branch_id = $2
      WHERE v.id = ANY($1::uuid[]) AND v.deleted_at IS NULL AND p.deleted_at IS NULL`,
    [items.map((i) => i.variant_id), branchId]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const item of items) {
    const r = byId.get(item.variant_id);
    if (!r || !r.is_online || !r.p_active || !r.v_active) {
      throw ApiError.conflict(`${item.product_name} is no longer available`, { variant_id: item.variant_id }, 'product_unavailable');
    }
    if (r.drug_schedule !== 'otc' || r.requires_prescription) {
      throw ApiError.unprocessable(`${r.name} cannot be bought online. Please visit the pharmacy.`);
    }
    if (r.track_stock && Number(item.quantity) > Number(r.available)) {
      throw ApiError.conflict(
        `Only ${Math.max(Number(r.available), 0)} of ${r.name} left`,
        { variant_id: item.variant_id, available: Math.max(Number(r.available), 0) },
        'insufficient_stock'
      );
    }
  }
}

// ---------- checkout ----------

/**
 * input: { cart_id, branch_id, customer_name, customer_phone, customer_email, fulfilment_type,
 *          delivery_zone_id, delivery_address, delivery_notes, customer_note }
 * Returns what the shopper needs: the tracking token, the order number and the amount to pay.
 */
async function checkout(db, input) {
  const settings = await StorefrontSettings.get(db);
  if (!settings || !settings.is_published) throw ApiError.notFound('This store is not available right now');

  const delivery = input.fulfilment_type === 'delivery';
  if (delivery && !settings.enable_delivery) throw ApiError.unprocessable('This shop does not deliver. Choose pickup.');
  if (!delivery && !settings.enable_pickup) throw ApiError.unprocessable('This shop does not offer pickup. Choose delivery.');

  const phone = MpesaService.normalisePhone(input.customer_phone);
  if (!phone) throw ApiError.unprocessable('Enter a valid phone number, e.g. 0712 345 678', undefined, 'invalid_phone');

  await db.query('SELECT id FROM carts WHERE id = $1 FOR UPDATE', [input.cart_id]); // one checkout per cart at a time
  const cart = await Cart.getWithItems(db, input.cart_id, input.branch_id);
  if (!cart.items.length) throw ApiError.unprocessable('Your cart is empty', undefined, 'cart_empty');
  await assertCartSellable(db, input.branch_id, cart.items);

  if (settings.min_order_amount && cart.total + 0.005 < Number(settings.min_order_amount)) {
    throw ApiError.unprocessable(`The minimum order is ${Number(settings.min_order_amount).toFixed(2)}`, undefined, 'below_minimum');
  }

  let zone = null;
  let fee = 0;
  if (delivery) {
    const zones = await DeliveryZone.listActive(db);
    if (zones.length) {
      zone = zones.find((z) => z.id === input.delivery_zone_id);
      if (!zone) throw ApiError.unprocessable('Choose a delivery area', undefined, 'zone_required');
      fee = round2(Number(zone.fee || 0));
      if (zone.min_order_amount && cart.total + 0.005 < Number(zone.min_order_amount)) {
        throw ApiError.unprocessable(`Delivery to ${zone.name} needs an order of at least ${Number(zone.min_order_amount).toFixed(2)}`, undefined, 'below_minimum');
      }
    }
  }

  const items = cart.items.map((i) => ({ variant_id: i.variant_id, quantity: Number(i.quantity) }));
  if (fee > 0) {
    const variant = await deliveryVariant(db);
    items.push({ variant_id: variant.id, quantity: 1, unit_price: fee });
  }

  const sale = await SaleService.create(db, null, {
    branch_id: input.branch_id,
    channel: 'online',
    status: 'open',
    trusted: true,
    defer_stock: true,
    items,
    customer_name: String(input.customer_name).trim(),
    customer_phone: phone,
    notes: input.customer_note ? String(input.customer_note).slice(0, 500) : undefined,
  });

  // link to an existing customer record when the phone matches (not created from the public site)
  const known = await Customer.findByPhone(db, phone);
  if (known) await Sale.update(db, sale.id, { customer_id: known.id });

  const order = await OnlineOrder.create(db, {
    sale_id: sale.id,
    branch_id: input.branch_id,
    customer_name: String(input.customer_name).trim(),
    customer_phone: phone,
    customer_email: input.customer_email || null,
    fulfilment_type: input.fulfilment_type,
    delivery_zone_id: zone ? zone.id : null,
    delivery_address: delivery ? input.delivery_address : null,
    delivery_notes: input.delivery_notes || null,
    delivery_fee: fee,
    customer_note: input.customer_note || null,
    fulfilment_status: 'awaiting_payment',
  });

  const held = cart.items
    .filter((i) => i.track_stock)
    .map((i) => ({ variant_id: i.variant_id, quantity: Number(i.quantity) }));
  if (held.length) {
    await StockReservation.reserve(db, { branch_id: input.branch_id, online_order_id: order.id, items: held, minutes: HOLD_MINUTES });
  }
  await Cart.clear(db, input.cart_id);

  return {
    tracking_token: order.tracking_token,
    order_number: sale.sale_number,
    total: sale.total,
    delivery_fee: fee,
    fulfilment_type: order.fulfilment_type,
    fulfilment_status: order.fulfilment_status,
    payment_status: sale.payment_status,
    hold_minutes: HOLD_MINUTES,
  };
}

// ---------- payment ----------

async function lockOrderByToken(db, token) {
  try {
    const { rows } = await db.query(
      `SELECT o.* FROM online_orders o WHERE o.tracking_token = $1 FOR UPDATE`,
      [token]
    );
    return rows[0] || null;
  } catch (err) {
    if (err && err.code === '22P02') return null; // not a valid token format
    throw err;
  }
}

/** Sends the M-Pesa prompt for an order that is waiting for payment. */
async function startPayment(db, { tracking_token, phone }) {
  const order = await lockOrderByToken(db, tracking_token);
  if (!order) throw ApiError.notFound('Order not found');
  if (order.fulfilment_status !== 'awaiting_payment') {
    throw ApiError.conflict(
      order.fulfilment_status === 'cancelled' ? 'This order was cancelled' : 'This order has already been paid',
      undefined,
      'not_awaiting_payment'
    );
  }

  const sale = await Sale.findById(db, order.sale_id);
  if (!sale || sale.status === 'void') throw ApiError.conflict('This order was cancelled', undefined, 'not_awaiting_payment');

  await ensureStockHeld(db, order, sale);

  const tx = await MpesaService.stkPush(db, null, { sale_id: sale.id, phone, branch_id: order.branch_id });
  return {
    payment_status: 'pending',
    amount: Number(tx.amount),
    message: `Check your phone and enter your M-Pesa PIN to pay KES ${Number(tx.amount).toLocaleString('en-KE')}.`,
  };
}

/** Keeps the hold alive while the customer pays, and re-takes it if it lapsed (when the stock is still there). */
async function ensureStockHeld(db, order, sale) {
  const { rows: active } = await db.query(
    `SELECT 1 FROM stock_reservations WHERE online_order_id = $1 AND status = 'active' AND expires_at > now() LIMIT 1`,
    [order.id]
  );
  if (active.length) {
    await db.query(
      `UPDATE stock_reservations SET expires_at = GREATEST(expires_at, now() + ($2::int * interval '1 minute'))
        WHERE online_order_id = $1 AND status = 'active'`,
      [order.id, PAYMENT_HOLD_MINUTES]
    );
    return;
  }

  const items = await Sale.getItems(db, sale.id);
  const flags = await InventoryService.variantFlags(db, items.map((i) => i.variant_id));
  const wanted = items
    .filter((i) => flags.get(i.variant_id) && flags.get(i.variant_id).track_stock && flags.get(i.variant_id).product_type !== 'service')
    .map((i) => ({ variant_id: i.variant_id, quantity: Number(i.quantity), name: i.product_name }));
  if (!wanted.length) return;

  const available = new Map(
    (await StockLevel.availability(db, order.branch_id, wanted.map((w) => w.variant_id))).map((a) => [a.variant_id, Number(a.quantity_available)])
  );
  const short = wanted.find((w) => w.quantity > (available.get(w.variant_id) || 0));
  if (short) {
    throw ApiError.conflict(`${short.name} is no longer available. Please place a new order.`, undefined, 'order_expired');
  }
  await db.query(`UPDATE stock_reservations SET status = 'expired' WHERE online_order_id = $1 AND status = 'active'`, [order.id]);
  await StockReservation.reserve(db, {
    branch_id: order.branch_id, online_order_id: order.id, items: wanted, minutes: PAYMENT_HOLD_MINUTES,
  });
}

/**
 * Called by SaleService.afterPayment when an online sale becomes fully paid (before it is
 * completed): the held stock turns into real movements and the order moves to 'paid'.
 */
async function onPaid(db, sale) {
  const order = await OnlineOrder.findBySaleId(db, sale.id);
  if (!order) return;
  if (order.fulfilment_status === 'cancelled') {
    console.warn(JSON.stringify({ level: 'warn', msg: 'payment received for a cancelled online order', sale: sale.id }));
    return;
  }
  if (order.fulfilment_status !== 'awaiting_payment') return;

  await StockReservation.commitForOrder(db, order.id);
  await SaleService.commitStock(db, null, sale.id);
  await OnlineOrder.setStatus(db, order.id, 'paid');
}

// ---------- the shop's side ----------

/** Moves an order along. Cancelling voids the sale, or refunds it when KRA already has the invoice. */
async function updateStatus(db, user, orderId, status, { reason } = {}) {
  const { rows } = await db.query('SELECT * FROM online_orders WHERE id = $1 FOR UPDATE', [orderId]);
  const order = rows[0];
  if (!order) throw ApiError.notFound('Order not found');

  const allowed = NEXT[order.fulfilment_status] || [];
  if (!allowed.includes(status)) {
    throw ApiError.conflict(`An order that is ${order.fulfilment_status.replace(/_/g, ' ')} cannot be set to ${status.replace(/_/g, ' ')}`, undefined, 'invalid_transition');
  }

  const sale = await Sale.findById(db, order.sale_id);
  if (!sale) throw ApiError.notFound('The sale for this order is missing');

  if (status === 'cancelled') {
    const invoice = await EtimsInvoice.findBySale(db, sale.id);
    const sentToKra = invoice && ['submitted', 'submitting'].includes(invoice.status);
    if (sentToKra) {
      const lines = await Sale.getItems(db, sale.id);
      await SaleService.refund(db, user, sale.id, {
        reason,
        items: lines.map((l) => ({ sale_item_id: l.id, quantity: Number(l.quantity) })),
        restock: true,
      });
      await StockReservation.releaseForOrder(db, order.id);
      await OnlineOrder.setStatus(db, order.id, 'cancelled', { cancel_reason: reason });
    } else if (sale.status !== 'void') {
      await SaleService.void(db, user, sale.id, reason); // also cancels the order and frees the hold
    }
    return OnlineOrder.findById(db, order.id);
  }

  if (sale.payment_status !== 'paid') {
    throw ApiError.conflict('This order has not been paid yet. Record the payment first.', undefined, 'payment_required');
  }
  if (status === 'paid') {
    if (order.fulfilment_status === 'awaiting_payment') await onPaid(db, sale);
    return OnlineOrder.findById(db, order.id);
  }

  // A paid order still marked awaiting_payment (payment recorded some other way) is caught up first.
  if (order.fulfilment_status === 'awaiting_payment') await onPaid(db, sale);
  return OnlineOrder.setStatus(db, order.id, status);
}

module.exports = { checkout, startPayment, onPaid, updateStatus };
