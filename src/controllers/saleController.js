'use strict';

/**
 * Sales at the till. The sale flow itself (pricing, tax, stock, payments, eTIMS queue) lives in
 * services/SaleService so it runs as ONE transaction; this controller only validates and calls it.
 */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/respond');
const { requireFields, nonEmptyArray, positive } = require('../utils/validate');
const { run, branchId, listBranch, pageParams } = require('../utils/context');
const { audit } = require('../utils/audit');
const { Sale, Tenant, Role } = require('../models');
const SaleService = require('../services/SaleService');

const isManager = (req) => req.user.is_owner || Role.hasPermission(req.user.permissions, 'reports.view');

function validateLines(items) {
  nonEmptyArray(items, 'items');
  for (const item of items) {
    requireFields(item, ['variant_id']);
    positive(item.quantity, 'item quantity');
  }
}

// POST /sales
// { client_uuid (idempotency key; generate on the device), items: [{ variant_id, quantity, unit_price?,
//   discount_amount?, modifiers: [{ modifier_id }], notes }], payments: [{ method, amount, ... }],
//   customer_id | customer_name/phone/kra_pin, service_type, table_id, status: 'open' (restaurant tab),
//   discount, notes, prescription: { patient_name, prescriber_name, ... } }
// Sending the same client_uuid again returns the sale already saved (HTTP 200) instead of a duplicate.
exports.create = asyncHandler(async (req, res) => {
  validateLines(req.body.items);
  const branch = branchId(req);

  const sale = await run(req, async (db) => {
    const result = await SaleService.create(db, req.user, { ...req.body, branch_id: branch, channel: 'pos' });
    if (!result.replayed) {
      await audit(db, req, 'sale.create', 'sale', result.id, {
        number: result.sale_number,
        total: result.total,
        payment_status: result.payment_status,
      });
    }
    return result;
  });
  return res.status(sale.replayed ? 200 : 201).json({ success: true, data: sale });
});

// GET /sales?q=&branch_id=&status=&channel=&sale_type=&payment_status=&customer_id=&from=&to=
// Cashiers only see their own sales; managers see everyone's.
exports.list = asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const result = await run(req, (db) =>
    Sale.search(db, {
      q: req.query.q,
      branch_id: listBranch(req),
      status: req.query.status,
      channel: req.query.channel,
      sale_type: req.query.sale_type,
      payment_status: req.query.payment_status,
      customer_id: req.query.customer_id,
      cashier_id: isManager(req) ? req.query.cashier_id : req.user.id,
      from: req.query.from,
      to: req.query.to,
      page,
      limit,
    })
  );
  return paginated(res, result);
});

async function loadForUser(db, req, id) {
  const sale = await Sale.getFull(db, id);
  if (!sale) throw ApiError.notFound('Sale not found');
  if (!isManager(req) && sale.cashier_id !== req.user.id && sale.status !== 'open') {
    throw ApiError.forbidden('That sale was made by another cashier');
  }
  return sale;
}

// GET /sales/:id
exports.get = asyncHandler(async (req, res) => {
  const sale = await run(req, (db) => loadForUser(db, req, req.params.id));
  return ok(res, sale);
});

// GET /sales/by-number/:number   e.g. when a customer brings a receipt for a refund
exports.getByNumber = asyncHandler(async (req, res) => {
  const sale = await run(req, async (db) => {
    const found = await Sale.findOne(db, { sale_number: req.params.number });
    if (!found) throw ApiError.notFound('Sale not found');
    return loadForUser(db, req, found.id);
  });
  return ok(res, sale);
});

// GET /sales/:id/receipt   everything needed to print: sale, lines, payments, KRA details, business
exports.receipt = asyncHandler(async (req, res) => {
  const data = await run(req, async (db) => {
    const sale = await loadForUser(db, req, req.params.id);
    const tenant = await Tenant.findById(db, req.tenantId);
    return {
      sale,
      business: {
        name: tenant.name,
        legal_name: tenant.legal_name,
        kra_pin: tenant.kra_pin,
        vat_registered: tenant.vat_registered,
        phone: tenant.phone,
        email: tenant.email,
        address: tenant.address,
        currency: tenant.currency,
        receipt_footer: (tenant.settings && tenant.settings.receipt_footer) || null,
      },
    };
  });
  return ok(res, data);
});

// POST /sales/:id/items   add lines to an open tab (restaurant)  { items: [...] }
exports.addItems = asyncHandler(async (req, res) => {
  validateLines(req.body.items);
  const sale = await run(req, async (db) => {
    const result = await SaleService.addItems(db, req.user, req.params.id, req.body.items);
    await audit(db, req, 'sale.add_items', 'sale', req.params.id, { lines: req.body.items.length });
    return result;
  });
  return ok(res, sale);
});

// POST /sales/:id/void  { reason }   cancels a sale and returns its stock
exports.void = asyncHandler(async (req, res) => {
  requireFields(req.body, ['reason']);
  const sale = await run(req, async (db) => {
    const result = await SaleService.void(db, req.user, req.params.id, req.body.reason);
    await audit(db, req, 'sale.void', 'sale', req.params.id, { reason: req.body.reason });
    return result;
  });
  return ok(res, sale);
});

// POST /sales/:id/refund
// { reason, items: [{ sale_item_id | variant_id, quantity }], refund_method: 'cash'|'mpesa'|..., restock: true }
// Creates a credit note (which is also sent to KRA eTIMS) and books the refund.
exports.refund = asyncHandler(async (req, res) => {
  requireFields(req.body, ['reason']);
  nonEmptyArray(req.body.items, 'items');
  for (const item of req.body.items) positive(item.quantity, 'item quantity');

  const creditNote = await run(req, async (db) => {
    const result = await SaleService.refund(db, req.user, req.params.id, req.body);
    await audit(db, req, 'sale.refund', 'sale', req.params.id, {
      credit_note: result.sale_number,
      total: result.total,
      reason: req.body.reason,
    });
    return result;
  });
  return created(res, creditNote);
});
