'use strict';

/**
 * Offline support for the POS app. The till keeps selling while the internet is down, stores
 * sales locally (each with its own client_uuid), then pushes them here when it reconnects.
 * Pushing the same sale twice is safe: the client_uuid makes it idempotent.
 */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/respond');
const { nonEmptyArray } = require('../utils/validate');
const { run, branchId, isRestricted } = require('../utils/context');
const { assertSaleRights } = require('../utils/saleGuards');
const SaleService = require('../services/SaleService');

const MAX_BATCH = 100;

// POST /sync/sales  { sales: [ <same body as POST /sales, each with client_uuid and sold_at> ] }
// Each sale is saved on its own savepoint, so one bad sale never blocks the rest. Offline sales
// are already paid and handed over, so stock is never refused (it may go negative for review).
exports.pushSales = asyncHandler(async (req, res) => {
  const sales = nonEmptyArray(req.body.sales, 'sales');
  if (sales.length > MAX_BATCH) throw ApiError.unprocessable(`Send at most ${MAX_BATCH} sales per request`);
  const branch = branchId(req);

  const results = await run(req, async (db) => {
    const out = [];
    for (const sale of sales) {
      if (!sale || !sale.client_uuid) {
        out.push({ client_uuid: null, ok: false, code: 422, error: 'client_uuid is required' });
        continue;
      }
      // a till may only push sales for a branch its user is allowed to work in
      const saleBranch = sale.branch_id || branch;
      if (isRestricted(req.user) && !(req.user.branch_ids || []).map(String).includes(String(saleBranch))) {
        out.push({ client_uuid: sale.client_uuid, ok: false, code: 403, error: 'You do not have access to that branch' });
        continue;
      }
      await db.query('SAVEPOINT sync_sale');
      try {
        assertSaleRights(req.user, sale);
        const saved = await SaleService.create(db, req.user, {
          ...sale,
          branch_id: saleBranch,
          channel: 'pos',
          offline: true,
        });
        await db.query('RELEASE SAVEPOINT sync_sale');
        out.push({
          client_uuid: sale.client_uuid,
          ok: true,
          sale_id: saved.id,
          sale_number: saved.sale_number,
          replayed: Boolean(saved.replayed),
        });
      } catch (err) {
        await db.query('ROLLBACK TO SAVEPOINT sync_sale');
        out.push({ client_uuid: sale.client_uuid, ok: false, code: err.status || 500, error: err.message });
      }
    }
    return out;
  });

  return ok(res, {
    results,
    saved: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  });
});

// GET /sync/catalog?since=<ISO time>   (branch required)
// Everything the till needs to sell offline: products, variants, prices, tax and stock for the branch.
// Pass the previous response's server_time as `since` to get only what changed. Cost prices are
// never sent. Rows with removed = true should be deleted from the device.
exports.catalog = asyncHandler(async (req, res) => {
  const branch = branchId(req);
  const since = req.query.since ? new Date(req.query.since) : null;
  if (since && Number.isNaN(since.getTime())) throw ApiError.unprocessable('since must be a valid date-time');

  const data = await run(req, async (db) => {
    const { rows } = await db.query(
      `SELECT v.id AS variant_id, v.product_id, v.name AS variant_name, v.sku, v.barcode,
              v.selling_price, v.wholesale_price,
              p.name AS product_name, p.product_type, p.track_stock, p.category_id, p.kitchen_station,
              t.code AS tax_code, COALESCE(t.rate, 0) AS tax_rate,
              COALESCE(sl.quantity_on_hand, 0) AS quantity_on_hand,
              (v.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL OR NOT v.is_active OR NOT p.is_active) AS removed,
              GREATEST(v.updated_at, p.updated_at, COALESCE(sl.updated_at, v.updated_at)) AS changed_at
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
         LEFT JOIN tax_classes t ON t.id = p.tax_class_id
         LEFT JOIN stock_levels sl ON sl.variant_id = v.id AND sl.branch_id = $1
        WHERE $2::timestamptz IS NULL
           OR GREATEST(v.updated_at, p.updated_at, COALESCE(sl.updated_at, v.updated_at)) > $2::timestamptz
        ORDER BY changed_at ASC
        LIMIT 5000`,
      [branch, since]
    );
    return rows;
  });

  return ok(res, {
    server_time: new Date().toISOString(),
    count: data.length,
    truncated: data.length === 5000, // call again with since = the last changed_at
    items: data,
  });
});
