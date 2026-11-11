'use strict';

/**
 * The sale flow, run as ONE transaction (the caller's `db`): pricing, discounts, tax, stock,
 * payments, prescriptions and the eTIMS queue. Controllers only validate the shape of the request.
 *
 * Conventions
 *  - sale_items.unit_price is the price of ONE unit including any modifiers.
 *  - discount_amount on a line includes its share of a whole-sale discount, so for every line:
 *      quantity * unit_price - discount_amount            = taxable amount
 *      prices_include_tax  -> line_total = taxable amount (tax is inside it)
 *      otherwise           -> line_total = taxable amount + tax_amount
 *    and subtotal - discount_total (+ tax_total when exclusive) = total.
 *  - A credit note (refund) is a sale with sale_type 'credit_note'; its quantities and totals are
 *    positive and reports subtract them.
 *  - Tenant settings read from tenants.settings (all optional):
 *      prices_include_tax (default true), allow_negative_stock, require_shift.
 *  - user may be null for system work (online orders); such calls are trusted.
 */
const ApiError = require('../utils/ApiError');
const { round2, round3 } = require('../utils/money');
const { isRestricted } = require('../utils/context');
const {
  Sale, Branch, Customer, CustomerLedger, Shift, ProductVariant, Modifier, PriceList, RecipeItem,
  PrescriptionRecord, EtimsInvoice, TenantEtimsConfig, DiningTable, Payment, OnlineOrder,
  StockReservation, Role,
} = require('../models');
const InventoryService = require('./InventoryService');
const PaymentService = require('./PaymentService');

const EPS = 0.005;
const REFUND_METHODS = ['cash', 'mpesa', 'card', 'bank_transfer', 'other'];

// ---------- small helpers ----------

const uniq = (list) => [...new Set(list)];
const mayDo = (user, key) => Boolean(user) && (user.is_owner || Role.hasPermission(user.permissions, key));

function assertBranchAccess(user, branchId) {
  if (isRestricted(user) && !(user.branch_ids || []).map(String).includes(String(branchId))) {
    throw ApiError.forbidden('You do not have access to that branch');
  }
}

/** Drops undefined / null / '' so database defaults apply to columns the request did not set. */
const compact = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));

async function getTenant(db) {
  const { rows } = await db.query(
    'SELECT id, currency, vat_registered, settings FROM tenants WHERE id = current_tenant_id()'
  );
  const tenant = rows[0];
  if (!tenant) throw new Error('SaleService: shop not found');
  return { ...tenant, settings: tenant.settings || {} };
}

async function lockSale(db, saleId) {
  const { rows } = await db.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [saleId]);
  if (!rows[0]) throw ApiError.notFound('Sale not found');
  return rows[0];
}

async function queueEtims(db, saleId, invoiceType) {
  const active = await TenantEtimsConfig.isActive(db);
  return EtimsInvoice.enqueue(db, { sale_id: saleId, invoice_type: invoiceType, skip: !active });
}

// ---------- pricing ----------

/**
 * Turns request lines into priced lines (before sale-level discount and tax).
 * item: { variant_id, quantity, unit_price?, discount_amount?, discount_percent?, modifiers: [{ modifier_id }], notes }
 */
async function priceLines(db, { items, customer, tenant, user, trusted }) {
  const variants = await ProductVariant.findForSale(db, uniq(items.map((i) => i.variant_id)));
  const variantById = new Map(variants.map((v) => [v.id, v]));

  const modifierIds = uniq(items.flatMap((i) => (i.modifiers || []).map((m) => m.modifier_id).filter(Boolean)));
  const modifiers = await Modifier.findByIds(db, modifierIds);
  const modifierById = new Map(modifiers.map((m) => [m.id, m]));

  const lines = [];
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const variant = variantById.get(item.variant_id);
    if (!variant || !variant.is_active) {
      throw ApiError.unprocessable('A product on this sale is no longer available', { variant_id: item.variant_id }, 'product_unavailable');
    }
    const quantity = round3(Number(item.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) throw ApiError.unprocessable('Quantity must be greater than 0');

    let listPrice = Number(variant.selling_price);
    if (customer && customer.price_list_id) {
      const special = await PriceList.getPrice(db, customer.price_list_id, variant.id, quantity);
      if (special !== null && special !== undefined) listPrice = Number(special);
    }

    let base = listPrice;
    if (item.unit_price !== undefined && item.unit_price !== null && item.unit_price !== '') {
      const asked = Number(item.unit_price);
      if (!Number.isFinite(asked) || asked < 0) throw ApiError.unprocessable('unit_price must be 0 or more');
      if (!trusted && asked < listPrice - EPS && !mayDo(user, 'pos.discount')) {
        throw ApiError.forbidden('You do not have permission to sell below the listed price (pos.discount)');
      }
      base = asked;
    }

    const chosen = [];
    for (const m of item.modifiers || []) {
      const found = modifierById.get(m.modifier_id);
      if (!found || !found.is_active) throw ApiError.unprocessable('A modifier on this sale is no longer available');
      chosen.push({
        modifier_id: found.id,
        name: found.name,
        price_delta: Number(found.price_delta || 0),
        ingredient_variant_id: found.ingredient_variant_id || null,
      });
    }
    const unit = round2(base + chosen.reduce((s, m) => s + m.price_delta, 0));
    const gross = round2(quantity * unit);

    let discount = 0;
    if (Number(item.discount_amount) > 0) discount = round2(Number(item.discount_amount));
    else if (Number(item.discount_percent ?? item.discount_rate) > 0) {
      const pct = Number(item.discount_percent ?? item.discount_rate);
      if (pct > 100) throw ApiError.unprocessable('A discount cannot be more than 100%');
      discount = round2((gross * pct) / 100);
    }
    if (discount > gross + EPS) throw ApiError.unprocessable(`The discount on ${variant.product_name} is more than its price`);

    const vat = Boolean(tenant.vat_registered);
    lines.push({
      idx,
      variant,
      quantity,
      unit_price: unit,
      gross,
      own_discount: discount,
      sale_discount: 0,
      tax_rate: vat ? Number(variant.tax_rate || 0) : 0,
      tax_code: vat ? variant.tax_code || null : 'D',
      modifiers: chosen,
      notes: item.notes || null,
      tracked: Boolean(variant.track_stock) && variant.product_type !== 'service',
    });
  }
  return lines;
}

/** Spreads a whole-sale discount over the lines in proportion to what each line is worth. */
function allocateSaleDiscount(lines, body) {
  const net = round2(lines.reduce((s, l) => s + l.gross - l.own_discount, 0));
  let discount = 0;
  const amount = Number(body.discount_amount ?? body.discount);
  const percent = Number(body.discount_percent ?? body.discount_rate);
  if (amount > 0) discount = round2(amount);
  else if (percent > 0) {
    if (percent > 100) throw ApiError.unprocessable('A discount cannot be more than 100%');
    discount = round2((net * percent) / 100);
  }
  if (discount <= 0) return;
  if (discount > net + EPS) throw ApiError.unprocessable('The discount is more than the sale total');

  let left = discount;
  lines.forEach((l, i) => {
    const room = round2(l.gross - l.own_discount);
    const share = i === lines.length - 1 ? left : Math.min(round2((discount * room) / (net || 1)), left);
    l.sale_discount = Math.min(share, room);
    left = round2(left - l.sale_discount);
  });
}

/** Fills discount_amount, tax_amount and line_total for each line. */
function finishLines(lines, pricesIncludeTax) {
  for (const l of lines) {
    l.discount_amount = round2(l.own_discount + l.sale_discount);
    const taxable = round2(l.gross - l.discount_amount);
    if (pricesIncludeTax) {
      l.tax_amount = round2((taxable * l.tax_rate) / (100 + l.tax_rate));
      l.line_total = taxable;
    } else {
      l.tax_amount = round2((taxable * l.tax_rate) / 100);
      l.line_total = round2(taxable + l.tax_amount);
    }
  }
}

function totalsOf(lines) {
  return {
    subtotal: round2(lines.reduce((s, l) => s + l.gross, 0)),
    discount_total: round2(lines.reduce((s, l) => s + l.discount_amount, 0)),
    tax_total: round2(lines.reduce((s, l) => s + l.tax_amount, 0)),
    total: round2(lines.reduce((s, l) => s + l.line_total, 0)),
  };
}

// ---------- pharmacy ----------

async function prescriptionNeeds(db, variantIds) {
  if (!variantIds.length) return new Set();
  const { rows } = await db.query(
    `SELECT v.id FROM product_variants v
       JOIN product_pharma pp ON pp.product_id = v.product_id
      WHERE v.id = ANY($1::uuid[])
        AND (pp.requires_prescription OR COALESCE(pp.drug_schedule, 'otc') <> 'otc')`,
    [variantIds]
  );
  return new Set(rows.map((r) => r.id));
}

function assertPrescription(prescription, needed) {
  if (!needed.size) return;
  if (!prescription || !prescription.patient_name || !prescription.prescriber_name) {
    throw ApiError.unprocessable(
      'This sale includes prescription medicine. Enter the patient and prescriber details.',
      undefined,
      'prescription_required'
    );
  }
}

// ---------- stock ----------

/** Ingredient quantities used by dishes (recipes) and chosen modifiers. */
async function ingredientNeeds(db, lines) {
  const dishIds = uniq(lines.map((l) => l.variant.id));
  const recipes = await RecipeItem.consumptionFor(db, dishIds);
  const need = new Map();
  const add = (variantId, qty) => need.set(variantId, round3((need.get(variantId) || 0) + qty));

  for (const l of lines) {
    for (const r of recipes) if (r.dish_variant_id === l.variant.id) add(r.ingredient_variant_id, l.quantity * Number(r.quantity));
    for (const m of l.modifiers) if (m.ingredient_variant_id) add(m.ingredient_variant_id, l.quantity);
  }
  if (!need.size) return [];

  const flags = await InventoryService.variantFlags(db, [...need.keys()]);
  return [...need.entries()]
    .filter(([id]) => flags.get(id) && flags.get(id).track_stock)
    .map(([variant_id, quantity]) => ({
      key: `ing:${variant_id}`, variant_id, quantity, name: null, unit_cost: flags.get(variant_id).cost_price,
    }));
}

async function applyIngredients(db, user, sale, needs) {
  if (!needs.length) return;
  const plan = await InventoryService.planOutflow(db, { branch_id: sale.branch_id, lines: needs, allowNegative: true });
  await InventoryService.applyOutflow(db, user, plan, needs, {
    branch_id: sale.branch_id, reference_type: 'sale', reference_id: sale.id, note: `${sale.sale_number} (ingredients)`,
  });
}

// ---------- create ----------

/**
 * input: { branch_id, channel, client_uuid, items, payments, customer_id | customer_name/phone/kra_pin,
 *          service_type, table_id, covers, status: 'open', discount/discount_amount/discount_percent,
 *          notes, prescription, terminal_id, sold_at, offline, defer_stock, trusted }
 *
 * offline     the sale already happened: stock may go negative, a missing payment does not stop it.
 * defer_stock online orders: stock is held by a reservation and booked when the payment arrives.
 * Returns the full sale ({ ...sale, items, payments, replayed }).
 */
async function create(db, user, input) {
  const trusted = Boolean(input.trusted) || !user;
  const channel = input.channel || 'pos';
  const offline = Boolean(input.offline);
  const deferStock = Boolean(input.defer_stock);
  const isTab = input.status === 'open' && channel !== 'online';
  const status = input.status === 'open' ? 'open' : 'completed';

  // The same client_uuid always gives back the sale already saved.
  if (input.client_uuid) {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sale:${input.client_uuid}`]);
    const existing = await Sale.findByClientUuid(db, input.client_uuid);
    if (existing) return { ...(await Sale.getFull(db, existing.id)), replayed: true };
  }

  if (!trusted) assertBranchAccess(user, input.branch_id);
  const branch = await Branch.findById(db, input.branch_id);
  if (!branch || !branch.is_active) throw ApiError.unprocessable('That branch is not available');

  const tenant = await getTenant(db);
  const settings = tenant.settings;
  const pricesIncludeTax = settings.prices_include_tax !== false;
  const allowNegative = offline || Boolean(settings.allow_negative_stock);

  let customer = null;
  if (input.customer_id) {
    customer = await Customer.findById(db, input.customer_id);
    if (!customer) throw ApiError.unprocessable('That customer does not exist');
  }

  const shift = user ? await Shift.findOpenForUser(db, user.id) : null;
  if (channel === 'pos' && !offline && !isTab && settings.require_shift && !shift) {
    throw ApiError.conflict('Open a shift before selling', undefined, 'shift_required');
  }
  const payments = Array.isArray(input.payments) ? input.payments : [];
  if (status === 'open' && payments.length) throw ApiError.unprocessable('An open tab cannot take payments until it is settled');

  // ---- price it ----
  const lines = await priceLines(db, { items: input.items, customer, tenant, user, trusted });
  allocateSaleDiscount(lines, input);
  finishLines(lines, pricesIncludeTax);
  const totals = totalsOf(lines);

  // payments declared must cover the sale (unless it is a tab, an online order, or already happened)
  if (status === 'completed' && channel === 'pos' && !offline && totals.total > EPS) {
    const declared = round2(payments.reduce((s, p) => s + Number(p.amount || 0), 0));
    if (declared + EPS < totals.total) {
      throw ApiError.unprocessable(
        `Payment is short: the sale is ${totals.total.toFixed(2)} and ${declared.toFixed(2)} was paid`,
        { total: totals.total, paid: declared },
        'payment_required'
      );
    }
  }

  // ---- pharmacy ----
  const rxNeeded = await prescriptionNeeds(db, uniq(lines.map((l) => l.variant.id)));
  assertPrescription(input.prescription, rxNeeded);

  // ---- restaurant table ----
  if (input.table_id && isTab) {
    const { rows } = await db.query(`SELECT id FROM sales WHERE table_id = $1 AND status = 'open' LIMIT 1`, [input.table_id]);
    if (rows[0]) throw ApiError.conflict('That table already has an open tab', { sale_id: rows[0].id }, 'table_has_open_tab');
  }

  // ---- stock ----
  const stockLines = lines
    .filter((l) => l.tracked)
    .map((l) => ({ key: l.idx, variant_id: l.variant.id, quantity: l.quantity, name: l.variant.product_name, unit_cost: l.variant.cost_price }));
  const plan = deferStock
    ? new Map()
    : await InventoryService.planOutflow(db, {
        branch_id: branch.id,
        lines: stockLines,
        allowNegative,
        respectReservations: channel === 'pos' && !offline,
      });
  const ingredients = deferStock ? [] : await ingredientNeeds(db, lines);

  // ---- save ----
  const now = new Date();
  const soldAt = offline && input.sold_at && !Number.isNaN(new Date(input.sold_at).getTime()) && new Date(input.sold_at) < new Date(now.getTime() + 5 * 60 * 1000)
    ? new Date(input.sold_at)
    : undefined;

  const header = compact({
    branch_id: branch.id,
    client_uuid: input.client_uuid,
    sale_type: 'sale',
    channel,
    service_type: input.service_type || (input.table_id ? 'dine_in' : undefined),
    status,
    table_id: input.table_id,
    covers: input.covers,
    customer_id: customer ? customer.id : undefined,
    customer_name: input.customer_name || (customer && customer.name),
    customer_phone: input.customer_phone || (customer && customer.phone),
    customer_kra_pin: input.customer_kra_pin || (customer && customer.kra_pin),
    terminal_id: input.terminal_id || (shift && shift.terminal_id),
    shift_id: shift ? shift.id : undefined,
    cashier_id: user ? user.id : undefined,
    currency: tenant.currency,
    prices_include_tax: pricesIncludeTax,
    ...totals,
    notes: input.notes,
    sold_at: soldAt,
  });

  const sentNow = status !== 'open' ? now : null;
  const rows = lines.map((l) => {
    const parts = plan.get(l.idx) || [];
    return {
      variant_id: l.variant.id,
      batch_id: parts[0] ? parts[0].batch_id : null,
      product_name: l.variant.product_name,
      variant_name: l.variant.name,
      sku: l.variant.sku,
      quantity: l.quantity,
      unit_price: l.unit_price,
      discount_amount: l.discount_amount,
      tax_code: l.tax_code,
      tax_rate: l.tax_rate,
      tax_amount: l.tax_amount,
      line_total: l.line_total,
      unit_cost: Number(l.variant.cost_price || 0),
      etims_item_class_code: l.variant.etims_item_class_code,
      etims_unit_code: l.variant.etims_unit_code,
      kitchen_status: l.variant.kitchen_station ? 'new' : null,
      sent_to_kitchen_at: l.variant.kitchen_station ? sentNow : null,
      notes: l.notes,
      modifiers: l.modifiers.map((m) => ({ modifier_id: m.modifier_id, name: m.name, price_delta: m.price_delta })),
    };
  });

  const sale = await Sale.createWithItems(db, header, rows);

  await InventoryService.applyOutflow(db, user, plan, stockLines, {
    branch_id: branch.id, reference_type: 'sale', reference_id: sale.id, note: sale.sale_number,
  });
  await applyIngredients(db, user, sale, ingredients);

  if (rxNeeded.size) {
    const rx = input.prescription;
    for (const l of lines) {
      if (!rxNeeded.has(l.variant.id)) continue;
      await PrescriptionRecord.create(db, compact({
        sale_id: sale.id,
        sale_item_id: sale.items[l.idx].id,
        variant_id: l.variant.id,
        quantity: l.quantity,
        patient_name: rx.patient_name,
        patient_id_no: rx.patient_id_no,
        prescriber_name: rx.prescriber_name,
        prescriber_reg_no: rx.prescriber_reg_no,
        prescription_ref: rx.prescription_ref,
        dispensed_by: user ? user.id : undefined,
      }));
    }
  }

  if (input.table_id && isTab) await DiningTable.setStatus(db, input.table_id, 'occupied');

  if (payments.length) await PaymentService.recordMany(db, user, sale, payments);

  if (status === 'completed' && channel !== 'online') await queueEtims(db, sale.id, 'sale');

  return { ...(await Sale.getFull(db, sale.id)), replayed: false };
}

// ---------- tabs ----------

/** Adds lines to an open restaurant tab. */
async function addItems(db, user, saleId, items) {
  const sale = await lockSale(db, saleId);
  if (sale.status !== 'open') throw ApiError.conflict('Only an open tab can be changed', undefined, 'sale_not_open');
  if (sale.sale_type !== 'sale') throw ApiError.conflict('Credit notes cannot be changed');
  assertBranchAccess(user, sale.branch_id);

  const tenant = await getTenant(db);
  const customer = sale.customer_id ? await Customer.findById(db, sale.customer_id) : null;
  const lines = await priceLines(db, { items, customer, tenant, user, trusted: !user });
  finishLines(lines, sale.prices_include_tax);

  const rx = await prescriptionNeeds(db, uniq(lines.map((l) => l.variant.id)));
  if (rx.size) throw ApiError.unprocessable('Prescription medicine cannot be added to a tab. Sell it at the pharmacy counter.');

  const stockLines = lines
    .filter((l) => l.tracked)
    .map((l) => ({ key: l.idx, variant_id: l.variant.id, quantity: l.quantity, name: l.variant.product_name, unit_cost: l.variant.cost_price }));
  const plan = await InventoryService.planOutflow(db, {
    branch_id: sale.branch_id,
    lines: stockLines,
    allowNegative: Boolean(tenant.settings.allow_negative_stock),
    respectReservations: true,
  });
  const ingredients = await ingredientNeeds(db, lines);

  const { rows: last } = await db.query('SELECT COALESCE(MAX(line_no), 0) AS n FROM sale_items WHERE sale_id = $1', [sale.id]);
  await Sale.addItems(
    db,
    sale.id,
    lines.map((l) => {
      const parts = plan.get(l.idx) || [];
      return {
        variant_id: l.variant.id,
        batch_id: parts[0] ? parts[0].batch_id : null,
        product_name: l.variant.product_name,
        variant_name: l.variant.name,
        sku: l.variant.sku,
        quantity: l.quantity,
        unit_price: l.unit_price,
        discount_amount: l.discount_amount,
        tax_code: l.tax_code,
        tax_rate: l.tax_rate,
        tax_amount: l.tax_amount,
        line_total: l.line_total,
        unit_cost: Number(l.variant.cost_price || 0),
        etims_item_class_code: l.variant.etims_item_class_code,
        etims_unit_code: l.variant.etims_unit_code,
        kitchen_status: l.variant.kitchen_station ? 'new' : null,
        notes: l.notes,
        modifiers: l.modifiers.map((m) => ({ modifier_id: m.modifier_id, name: m.name, price_delta: m.price_delta })),
      };
    }),
    Number(last[0].n) + 1
  );

  await InventoryService.applyOutflow(db, user, plan, stockLines, {
    branch_id: sale.branch_id, reference_type: 'sale', reference_id: sale.id, note: sale.sale_number,
  });
  await applyIngredients(db, user, sale, ingredients);

  await recalculateTotals(db, sale.id);
  await Sale.refreshPaymentTotals(db, sale.id);
  return Sale.getFull(db, sale.id);
}

async function recalculateTotals(db, saleId) {
  await db.query(
    `UPDATE sales s
        SET subtotal = t.subtotal, discount_total = t.discount_total, tax_total = t.tax_total, total = t.total
       FROM (SELECT COALESCE(SUM(ROUND(quantity * unit_price, 2)), 0) AS subtotal,
                    COALESCE(SUM(discount_amount), 0) AS discount_total,
                    COALESCE(SUM(tax_amount), 0) AS tax_total,
                    COALESCE(SUM(line_total), 0) AS total
               FROM sale_items WHERE sale_id = $1) t
      WHERE s.id = $1`,
    [saleId]
  );
}

// ---------- after a payment ----------

/**
 * Called after every payment on a sale. When an open tab or an online order becomes fully paid it
 * is completed and queued for eTIMS. (Sales created already-paid are handled in create().)
 */
async function afterPayment(db, user, saleId) {
  const sale = await Sale.findById(db, saleId);
  if (!sale || sale.sale_type !== 'sale' || sale.status !== 'open') return sale;
  if (sale.payment_status !== 'paid') return sale;

  if (sale.channel === 'online') {
    const StorefrontService = require('./StorefrontService'); // lazy: it requires this file
    await StorefrontService.onPaid(db, sale);
  }
  const completed = await Sale.update(db, sale.id, { status: 'completed' });
  if (sale.table_id) await DiningTable.setStatus(db, sale.table_id, 'cleaning');
  await queueEtims(db, sale.id, 'sale');
  return completed;
}

/** Books the stock for a sale that was created with defer_stock (online order, now paid). Idempotent. */
async function commitStock(db, user, saleId) {
  const sale = await Sale.findById(db, saleId);
  if (!sale) throw ApiError.notFound('Sale not found');
  const { rows: already } = await db.query(
    `SELECT 1 FROM stock_movements WHERE reference_type = 'sale' AND reference_id = $1 LIMIT 1`,
    [sale.id]
  );
  if (already.length) return;

  const items = await Sale.getItems(db, sale.id);
  const flags = await InventoryService.variantFlags(db, uniq(items.map((i) => i.variant_id)));
  const lines = items
    .filter((i) => flags.get(i.variant_id) && flags.get(i.variant_id).track_stock && flags.get(i.variant_id).product_type !== 'service')
    .map((i) => ({ key: i.id, variant_id: i.variant_id, quantity: Number(i.quantity), name: i.product_name, unit_cost: i.unit_cost }));
  if (!lines.length) return;

  // the customer has already paid, so the stock is booked even if it has run short meanwhile
  const plan = await InventoryService.planOutflow(db, { branch_id: sale.branch_id, lines, allowNegative: true });
  await InventoryService.applyOutflow(db, user, plan, lines, {
    branch_id: sale.branch_id, reference_type: 'sale', reference_id: sale.id, note: sale.sale_number,
  });
}

// ---------- void ----------

/** Cancels a sale and returns its stock. Sales already sent to KRA must be refunded instead. */
async function voidSale(db, user, saleId, reason) {
  const sale = await lockSale(db, saleId);
  if (sale.sale_type !== 'sale') throw ApiError.conflict('A credit note cannot be voided');
  if (sale.status === 'void') throw ApiError.conflict('This sale is already void');
  assertBranchAccess(user, sale.branch_id);
  if (!reason || !String(reason).trim()) throw ApiError.unprocessable('A reason is required');

  const { rows: credits } = await db.query(
    `SELECT 1 FROM sales WHERE original_sale_id = $1 AND sale_type = 'credit_note' AND status <> 'void' LIMIT 1`,
    [sale.id]
  );
  if (credits.length) throw ApiError.conflict('This sale has refunds and cannot be voided', undefined, 'has_refunds');

  const invoice = await EtimsInvoice.findBySale(db, sale.id);
  if (invoice && ['submitted', 'submitting'].includes(invoice.status)) {
    throw ApiError.conflict(
      'This sale was already sent to KRA. Refund it instead so a credit note is issued.',
      undefined,
      'use_refund'
    );
  }
  if (invoice) await EtimsInvoice.update(db, invoice.id, { status: 'skipped', last_error: 'Sale voided' });

  await Sale.void(db, sale.id, { voided_by: user ? user.id : null, void_reason: String(reason).trim() });
  await InventoryService.reverseMovements(db, user, {
    reference_type: 'sale', reference_id: sale.id, type: InventoryService.TYPES.return, note: `Void ${sale.sale_number}`,
  });

  const payments = await Payment.forSale(db, sale.id);
  let creditReversed = 0;
  let refundDue = 0;
  for (const p of payments) {
    if (p.status !== 'completed') continue;
    await Payment.markReversed(db, p.id);
    if (p.method === 'credit') creditReversed += Number(p.amount);
    else refundDue += Number(p.amount);
  }
  if (creditReversed > 0 && sale.customer_id) {
    await CustomerLedger.recordRefund(db, {
      customer_id: sale.customer_id, sale_id: sale.id, amount: creditReversed,
      created_by: user ? user.id : null, note: `Void ${sale.sale_number}`,
    });
  }

  if (sale.table_id) {
    const { rows } = await db.query(`SELECT 1 FROM sales WHERE table_id = $1 AND status = 'open' AND id <> $2 LIMIT 1`, [sale.table_id, sale.id]);
    if (!rows.length) await DiningTable.setStatus(db, sale.table_id, 'available');
  }

  if (sale.channel === 'online') {
    const order = await OnlineOrder.findBySaleId(db, sale.id);
    if (order) {
      await StockReservation.releaseForOrder(db, order.id);
      if (order.fulfilment_status !== 'cancelled') {
        await OnlineOrder.setStatus(db, order.id, 'cancelled', { cancel_reason: String(reason).trim() });
      }
    }
  }

  // Money taken by cash, M-Pesa or card has to be handed back outside the system.
  return { ...(await Sale.getFull(db, sale.id)), refund_due: round2(refundDue) };
}

// ---------- refund ----------

/**
 * Credit note for part or all of a completed sale.
 * body: { reason, items: [{ sale_item_id | variant_id, quantity }], refund_method, refund_reference, restock }
 * Whatever the customer still owed on credit is written off against the debt first; the rest is
 * paid out with refund_method (default: the method the customer mostly paid with).
 */
async function refund(db, user, saleId, body) {
  const orig = await lockSale(db, saleId);
  if (orig.sale_type !== 'sale') throw ApiError.conflict('Only a sale can be refunded');
  if (orig.status !== 'completed') throw ApiError.conflict('Only a completed sale can be refunded');
  assertBranchAccess(user, orig.branch_id);

  const origItems = await Sale.getItems(db, orig.id);
  const credited = new Map((await Sale.creditedQuantities(db, orig.id)).map((r) => [r.variant_id, Number(r.quantity)]));
  const remaining = new Map();
  for (const it of origItems) remaining.set(it.variant_id, round3((remaining.get(it.variant_id) || 0) + Number(it.quantity)));
  for (const [variantId, qty] of credited) remaining.set(variantId, round3((remaining.get(variantId) || 0) - qty));

  const picks = [];
  const pickedByItem = new Map();
  const requestedByVariant = new Map();
  for (const r of body.items) {
    const quantity = round3(Number(r.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) throw ApiError.unprocessable('Refund quantity must be greater than 0');

    let candidates;
    if (r.sale_item_id) {
      const found = origItems.find((i) => i.id === r.sale_item_id);
      if (!found) throw ApiError.unprocessable('A refund line is not part of this sale');
      candidates = [found];
    } else if (r.variant_id) {
      candidates = origItems.filter((i) => i.variant_id === r.variant_id);
      if (!candidates.length) throw ApiError.unprocessable('A refund line is not part of this sale');
    } else {
      throw ApiError.unprocessable('Each refund line needs sale_item_id or variant_id');
    }

    let left = quantity;
    for (const it of candidates) {
      if (left <= EPS) break;
      const room = round3(Number(it.quantity) - (pickedByItem.get(it.id) || 0));
      const take = Math.min(left, room);
      if (take > EPS) {
        picks.push({ item: it, quantity: take });
        pickedByItem.set(it.id, round3((pickedByItem.get(it.id) || 0) + take));
        left = round3(left - take);
      }
    }
    if (left > EPS) throw ApiError.unprocessable('You are refunding more than was sold');
    const variantId = candidates[0].variant_id;
    requestedByVariant.set(variantId, round3((requestedByVariant.get(variantId) || 0) + quantity));
  }
  for (const [variantId, qty] of requestedByVariant) {
    if (qty > (remaining.get(variantId) || 0) + EPS) {
      throw ApiError.unprocessable('Some of these items have already been refunded', { variant_id: variantId, refundable: Math.max(remaining.get(variantId) || 0, 0) });
    }
  }

  // credit-note lines: the same price, tax and share of discount as the original line
  const noteLines = picks.map(({ item, quantity }) => {
    const ratio = quantity / Number(item.quantity);
    const whole = Math.abs(quantity - Number(item.quantity)) < EPS;
    return {
      variant_id: item.variant_id,
      product_name: item.product_name,
      variant_name: item.variant_name,
      sku: item.sku,
      quantity,
      unit_price: Number(item.unit_price),
      discount_amount: whole ? Number(item.discount_amount) : round2(Number(item.discount_amount) * ratio),
      tax_code: item.tax_code,
      tax_rate: Number(item.tax_rate),
      tax_amount: whole ? Number(item.tax_amount) : round2(Number(item.tax_amount) * ratio),
      line_total: whole ? Number(item.line_total) : round2(Number(item.line_total) * ratio),
      unit_cost: Number(item.unit_cost),
      etims_item_class_code: item.etims_item_class_code,
      etims_unit_code: item.etims_unit_code,
      notes: null,
    };
  });
  const totals = {
    subtotal: round2(noteLines.reduce((s, l) => s + l.quantity * l.unit_price, 0)),
    discount_total: round2(noteLines.reduce((s, l) => s + l.discount_amount, 0)),
    tax_total: round2(noteLines.reduce((s, l) => s + l.tax_amount, 0)),
    total: round2(noteLines.reduce((s, l) => s + l.line_total, 0)),
  };

  const shift = user ? await Shift.findOpenForUser(db, user.id) : null;
  const note = await Sale.createWithItems(
    db,
    compact({
      branch_id: orig.branch_id,
      sale_type: 'credit_note',
      original_sale_id: orig.id,
      refund_reason: String(body.reason).trim(),
      channel: orig.channel,
      status: 'completed',
      customer_id: orig.customer_id,
      customer_name: orig.customer_name,
      customer_phone: orig.customer_phone,
      customer_kra_pin: orig.customer_kra_pin,
      terminal_id: (shift && shift.terminal_id) || undefined,
      shift_id: shift ? shift.id : undefined,
      cashier_id: user ? user.id : undefined,
      currency: orig.currency,
      prices_include_tax: orig.prices_include_tax,
      ...totals,
    }),
    noteLines
  );

  // stock back on the shelf (into the batches it came from)
  if (body.restock !== false) {
    const flags = await InventoryService.variantFlags(db, [...requestedByVariant.keys()]);
    for (const [variantId, qty] of requestedByVariant) {
      const f = flags.get(variantId);
      if (!f || !f.track_stock || f.product_type === 'service') continue;
      await InventoryService.returnToStock(db, user, {
        branch_id: orig.branch_id,
        variant_id: variantId,
        quantity: qty,
        unit_cost: f.cost_price,
        reference_type: 'sale',
        reference_id: note.id,
        source_reference_type: 'sale',
        source_reference_id: orig.id,
        note: `Refund ${note.sale_number}`,
      });
    }
  }

  // money: debt first, then the chosen method
  const origPayments = (await Payment.forSale(db, orig.id)).filter((p) => p.status === 'completed');
  const creditPaid = origPayments.filter((p) => p.method === 'credit').reduce((s, p) => s + Number(p.amount), 0);
  const { rows: prior } = await db.query(
    `SELECT COALESCE(SUM(p.amount), 0) AS amount
       FROM payments p JOIN sales cn ON cn.id = p.sale_id
      WHERE cn.original_sale_id = $1 AND cn.sale_type = 'credit_note' AND cn.status <> 'void'
        AND p.method = 'credit' AND p.status = 'completed'`,
    [orig.id]
  );
  const creditRoom = Math.max(round2(creditPaid - Number(prior[0].amount)), 0);
  const creditPortion = orig.customer_id ? round2(Math.min(totals.total, creditRoom)) : 0;
  const payoutPortion = round2(totals.total - creditPortion);

  let method = body.refund_method;
  if (!method) {
    const byMethod = new Map();
    for (const p of origPayments.filter((x) => x.method !== 'credit')) byMethod.set(p.method, (byMethod.get(p.method) || 0) + Number(p.amount));
    method = [...byMethod.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m)[0] || 'cash';
  }
  if (!REFUND_METHODS.includes(method)) {
    throw ApiError.unprocessable(`refund_method must be one of: ${REFUND_METHODS.join(', ')}`);
  }

  const common = { sale_id: note.id, status: 'completed', shift_id: shift ? shift.id : undefined, received_by: user ? user.id : undefined };
  if (creditPortion > EPS) {
    const payment = await Payment.create(db, { ...common, method: 'credit', amount: creditPortion });
    await CustomerLedger.recordRefund(db, {
      customer_id: orig.customer_id, sale_id: note.id, amount: creditPortion,
      created_by: user ? user.id : null, note: `Refund ${note.sale_number}`,
    });
    void payment;
  }
  if (payoutPortion > EPS) {
    await Payment.create(db, compact({
      ...common, method, amount: payoutPortion, tendered: payoutPortion, reference: body.refund_reference,
    }));
  }
  await Sale.refreshPaymentTotals(db, note.id);

  await queueEtims(db, note.id, 'credit_note');
  return Sale.getFull(db, note.id);
}

module.exports = {
  create,
  addItems,
  void: voidSale,
  refund,
  afterPayment,
  commitStock,
};
