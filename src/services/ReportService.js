'use strict';

/**
 * Aggregations for the reports screens, run inside the caller's tenant transaction.
 *
 * What counts as a sale: sales.status = 'completed' (open tabs, unpaid online orders and voids are
 * left out). Credit notes (sale_type 'credit_note') are subtracted, so every figure is NET of
 * refunds unless the name says otherwise. "Revenue" excludes VAT; "sales" totals include it.
 *
 * Ranges: resolveRange() returns { from, to } as ISO strings WITH the shop's UTC offset, e.g.
 *   from 2026-11-10T00:00:00+03:00   to 2026-11-10T23:59:59.999+03:00
 * `to` is the last moment of the last day. That works for timestamps (sold_at >= from AND < to) and
 * for date columns (expense_date <= to::date) alike.
 */
const ApiError = require('../utils/ApiError');
const { round2 } = require('../utils/money');
const {
  Sale, Expense, ProductVariant, EtimsInvoice, OnlineOrder, Customer, StockBatch,
} = require('../models');

const DEFAULT_TZ = 'Africa/Nairobi';
const MAX_RANGE_DAYS = 731;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SIGN = `(CASE WHEN s.sale_type = 'credit_note' THEN -1 ELSE 1 END)`;
const NEXT_BASE = `s.status = 'completed' AND s.sold_at >= $1::timestamptz AND s.sold_at < $2::timestamptz
                   AND ($3::uuid IS NULL OR s.branch_id = $3)`;

// ---------- dates in the shop's timezone ----------

async function shopTimezone(db) {
  const { rows } = await db.query('SELECT timezone FROM tenants WHERE id = current_tenant_id()');
  return (rows[0] && rows[0].timezone) || DEFAULT_TZ;
}

const localDate = (tz, instant = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(instant);

function offsetMinutes(tz, instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(instant).map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

function offsetString(tz, dateStr) {
  const noon = new Date(`${dateStr}T12:00:00Z`);
  const minutes = offsetMinutes(tz, noon);
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const addDays = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

function parseDay(value, name) {
  const day = String(value).slice(0, 10);
  if (!DATE_RE.test(day) || Number.isNaN(new Date(`${day}T00:00:00Z`).getTime())) {
    throw ApiError.unprocessable(`${name} must be a date like 2026-11-10`);
  }
  return day;
}

/** ?from=&to= (dates) or ?period=today|yesterday|week|month|year|last_7_days|last_30_days. Default: today. */
async function resolveRange(db, query = {}) {
  const tz = await shopTimezone(db);
  const today = localDate(tz);

  let from;
  let to;
  let period = 'custom';

  if (query.from || query.to) {
    to = query.to ? parseDay(query.to, 'to') : today;
    from = query.from ? parseDay(query.from, 'from') : to;
  } else {
    period = query.period || 'today';
    const [y, m] = today.split('-');
    switch (period) {
      case 'today': from = today; to = today; break;
      case 'yesterday': from = addDays(today, -1); to = from; break;
      case 'week': {
        const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
        from = addDays(today, -dow); to = today; break;
      }
      case 'month': from = `${y}-${m}-01`; to = today; break;
      case 'year': from = `${y}-01-01`; to = today; break;
      case 'last_7_days': from = addDays(today, -6); to = today; break;
      case 'last_30_days': from = addDays(today, -29); to = today; break;
      default:
        throw ApiError.unprocessable('period must be one of: today, yesterday, week, month, year, last_7_days, last_30_days');
    }
  }

  if (from > to) throw ApiError.unprocessable('from must not be after to');
  const days = (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000 + 1;
  if (days > MAX_RANGE_DAYS) throw ApiError.unprocessable('Choose a range of two years or less');

  return {
    period,
    from: `${from}T00:00:00${offsetString(tz, from)}`,
    to: `${to}T23:59:59.999${offsetString(tz, to)}`,
    from_date: from,
    to_date: to,
    timezone: tz,
  };
}

// ---------- building blocks ----------

const ledger = (db, sql, params) => db.query(sql, params).then((r) => r.rows);

/** Headline totals for a period. */
async function summary(db, { from, to, branch_id }) {
  const [row] = await ledger(
    db,
    `SELECT COUNT(*) FILTER (WHERE s.sale_type = 'sale')::int AS sales_count,
            COUNT(*) FILTER (WHERE s.sale_type = 'credit_note')::int AS refunds_count,
            COALESCE(SUM(CASE WHEN s.sale_type = 'sale' THEN s.total END), 0) AS gross_sales,
            COALESCE(SUM(CASE WHEN s.sale_type = 'credit_note' THEN s.total END), 0) AS refunds,
            COALESCE(SUM(${SIGN} * s.total), 0) AS net_sales,
            COALESCE(SUM(${SIGN} * s.tax_total), 0) AS tax,
            COALESCE(SUM(${SIGN} * s.discount_total), 0) AS discounts
       FROM sales s WHERE ${NEXT_BASE}`,
    [from, to, branch_id || null]
  );
  return {
    ...row,
    average_sale: row.sales_count ? round2(Number(row.gross_sales) / row.sales_count) : 0,
  };
}

const BUCKETS = {
  hour: { unit: 'hour', format: 'YYYY-MM-DD"T"HH24:00' },
  day: { unit: 'day', format: 'YYYY-MM-DD' },
  week: { unit: 'week', format: 'YYYY-MM-DD' }, // the Monday of the week
  month: { unit: 'month', format: 'YYYY-MM' },
};

async function salesSeries(db, { from, to, branch_id, group_by = 'day' }) {
  const bucket = BUCKETS[group_by];
  if (!bucket) throw ApiError.unprocessable('group_by must be one of: hour, day, week, month');
  const tz = await shopTimezone(db);

  // unit and format come from the fixed table above, never from the request
  return ledger(
    db,
    `SELECT to_char(date_trunc('${bucket.unit}', s.sold_at AT TIME ZONE $4), '${bucket.format}') AS bucket,
            COUNT(*) FILTER (WHERE s.sale_type = 'sale')::int AS sales_count,
            COALESCE(SUM(CASE WHEN s.sale_type = 'sale' THEN s.total END), 0) AS gross_sales,
            COALESCE(SUM(CASE WHEN s.sale_type = 'credit_note' THEN s.total END), 0) AS refunds,
            COALESCE(SUM(${SIGN} * s.total), 0) AS net_sales,
            COALESCE(SUM(${SIGN} * s.tax_total), 0) AS tax,
            COALESCE(SUM(${SIGN} * s.discount_total), 0) AS discounts
       FROM sales s WHERE ${NEXT_BASE}
      GROUP BY 1 ORDER BY 1`,
    [from, to, branch_id || null, tz]
  );
}

async function topProducts(db, { from, to, branch_id, by = 'revenue', limit = 20 }) {
  const order = { revenue: 'revenue', quantity: 'quantity', profit: 'profit' }[by];
  if (!order) throw ApiError.unprocessable('by must be one of: revenue, quantity, profit');
  return ledger(
    db,
    `SELECT i.variant_id, i.product_name, i.variant_name, i.sku,
            SUM(${SIGN} * i.quantity) AS quantity,
            SUM(${SIGN} * (i.line_total - i.tax_amount)) AS revenue,
            SUM(${SIGN} * (i.line_total - i.tax_amount - i.unit_cost * i.quantity)) AS profit
       FROM sale_items i JOIN sales s ON s.id = i.sale_id
      WHERE ${NEXT_BASE}
      GROUP BY i.variant_id, i.product_name, i.variant_name, i.sku
      ORDER BY ${order} DESC, i.product_name ASC
      LIMIT $4`,
    [from, to, branch_id || null, limit]
  );
}

async function salesByCategory(db, { from, to, branch_id }) {
  const rows = await ledger(
    db,
    `SELECT c.id AS category_id, COALESCE(c.name, 'Uncategorised') AS category,
            SUM(${SIGN} * i.quantity) AS quantity,
            SUM(${SIGN} * (i.line_total - i.tax_amount)) AS revenue,
            SUM(${SIGN} * (i.line_total - i.tax_amount - i.unit_cost * i.quantity)) AS profit
       FROM sale_items i
       JOIN sales s ON s.id = i.sale_id
       LEFT JOIN product_variants v ON v.id = i.variant_id
       LEFT JOIN products p ON p.id = v.product_id
       LEFT JOIN categories c ON c.id = p.category_id
      WHERE ${NEXT_BASE}
      GROUP BY c.id, c.name
      ORDER BY revenue DESC`,
    [from, to, branch_id || null]
  );
  const total = rows.reduce((s, r) => s + Number(r.revenue), 0);
  return rows.map((r) => ({ ...r, share_percent: total > 0 ? round2((Number(r.revenue) / total) * 100) : 0 }));
}

/** Revenue (excluding VAT), cost of goods and gross profit. The controller adds expenses. */
async function profit(db, { from, to, branch_id }) {
  const [row] = await ledger(
    db,
    `SELECT COALESCE(SUM(${SIGN} * (i.line_total - i.tax_amount)), 0) AS revenue,
            COALESCE(SUM(${SIGN} * i.unit_cost * i.quantity), 0) AS cost_of_goods,
            COALESCE(SUM(${SIGN} * i.tax_amount), 0) AS tax_collected,
            COALESCE(SUM(${SIGN} * i.discount_amount), 0) AS discounts
       FROM sale_items i JOIN sales s ON s.id = i.sale_id
      WHERE ${NEXT_BASE}`,
    [from, to, branch_id || null]
  );
  const sales = await summary(db, { from, to, branch_id });
  const revenue = round2(row.revenue);
  const cost = round2(row.cost_of_goods);
  const gross = round2(revenue - cost);
  return {
    revenue,
    cost_of_goods: cost,
    gross_profit: gross,
    margin_percent: revenue > 0 ? round2((gross / revenue) * 100) : 0,
    tax_collected: round2(row.tax_collected),
    discounts: round2(row.discounts),
    transactions: sales.sales_count,
  };
}

/** Output VAT per tax code, the same split that goes to KRA. */
async function vatSummary(db, { from, to, branch_id }) {
  return ledger(
    db,
    `SELECT COALESCE(i.tax_code, '-') AS tax_code, i.tax_rate,
            SUM(${SIGN} * (i.line_total - i.tax_amount)) AS taxable_amount,
            SUM(${SIGN} * i.tax_amount) AS tax_amount,
            SUM(${SIGN} * i.line_total) AS gross_amount
       FROM sale_items i JOIN sales s ON s.id = i.sale_id
      WHERE ${NEXT_BASE}
      GROUP BY i.tax_code, i.tax_rate
      ORDER BY i.tax_code NULLS LAST`,
    [from, to, branch_id || null]
  );
}

async function cashierPerformance(db, { from, to, branch_id }) {
  const rows = await ledger(
    db,
    `SELECT s.cashier_id, COALESCE(u.full_name, 'Online / system') AS cashier,
            COUNT(*) FILTER (WHERE s.sale_type = 'sale')::int AS sales_count,
            COALESCE(SUM(CASE WHEN s.sale_type = 'sale' THEN s.total END), 0) AS gross_sales,
            COUNT(*) FILTER (WHERE s.sale_type = 'credit_note')::int AS refunds_count,
            COALESCE(SUM(CASE WHEN s.sale_type = 'credit_note' THEN s.total END), 0) AS refunds,
            COALESCE(SUM(${SIGN} * s.total), 0) AS net_sales,
            COALESCE(SUM(${SIGN} * s.discount_total), 0) AS discounts
       FROM sales s LEFT JOIN users u ON u.id = s.cashier_id
      WHERE ${NEXT_BASE}
      GROUP BY s.cashier_id, u.full_name
      ORDER BY net_sales DESC`,
    [from, to, branch_id || null]
  );
  return rows.map((r) => ({ ...r, average_sale: r.sales_count ? round2(Number(r.gross_sales) / r.sales_count) : 0 }));
}

// ---------- dashboard ----------

async function lowStockAcrossBranches(db) {
  return ledger(
    db,
    `SELECT v.id, v.sku, v.name AS variant_name, v.reorder_level, p.name AS product_name,
            COALESCE(SUM(sl.quantity_on_hand), 0) AS quantity_on_hand
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       LEFT JOIN stock_levels sl ON sl.variant_id = v.id
      WHERE v.deleted_at IS NULL AND v.is_active AND p.deleted_at IS NULL AND p.is_active AND p.track_stock
      GROUP BY v.id, p.name
     HAVING COALESCE(SUM(sl.quantity_on_hand), 0) <= v.reorder_level
      ORDER BY COALESCE(SUM(sl.quantity_on_hand), 0) ASC, p.name ASC
      LIMIT 500`,
    []
  );
}

/** Today's numbers, a 7-day trend, and the things that need attention. */
async function dashboard(db, { branch_id } = {}) {
  const today = await resolveRange(db, { period: 'today' });
  const week = await resolveRange(db, { period: 'last_7_days' });

  const [todaySummary, todayProfit, trend, methods] = await Promise.all([
    summary(db, { from: today.from, to: today.to, branch_id }),
    profit(db, { from: today.from, to: today.to, branch_id }),
    salesSeries(db, { from: week.from, to: week.to, branch_id, group_by: 'day' }),
    Sale.paymentBreakdown(db, { from: today.from, to: today.to, branch_id }),
  ]);

  // every one of the 7 days, including quiet ones
  const byDay = new Map(trend.map((r) => [r.bucket, r]));
  const filled = [];
  for (let d = week.from_date; d <= week.to_date; d = addDays(d, 1)) {
    filled.push(byDay.get(d) || { bucket: d, sales_count: 0, gross_sales: 0, refunds: 0, net_sales: 0, tax: 0, discounts: 0 });
  }

  const lowStock = branch_id ? await ProductVariant.lowStock(db, branch_id) : await lowStockAcrossBranches(db);
  const [expiring, openTabs, unmatched, etims, orders, owed] = await Promise.all([
    StockBatch.expiringSoon(db, { days: 30, branchId: branch_id || undefined }),
    ledger(db, `SELECT COUNT(*)::int AS n FROM sales WHERE status = 'open' AND channel <> 'online' AND ($1::uuid IS NULL OR branch_id = $1)`, [branch_id || null]),
    ledger(db, `SELECT COUNT(*)::int AS n FROM mpesa_transactions WHERE sale_id IS NULL AND status = 'success'`, []),
    EtimsInvoice.statusCounts(db),
    OnlineOrder.statusCounts(db, branch_id || undefined),
    Customer.totalOwed(db),
  ]);

  return {
    date: today.from_date,
    timezone: today.timezone,
    today: { ...todaySummary, gross_profit: todayProfit.gross_profit, payment_methods: methods },
    trend: filled,
    attention: {
      low_stock_count: lowStock.length,
      low_stock: lowStock.slice(0, 10),
      expiring_30_days: expiring.length,
      open_tabs: openTabs[0].n,
      unmatched_mpesa_payments: unmatched[0].n,
      etims: {
        pending: etims.pending || 0,
        failed: (etims.failed || 0) + (etims.rejected || 0),
        rejected: etims.rejected || 0,
      },
      online_orders: orders,
      customers_owe: round2(owed),
    },
  };
}

// ---------- end of day (Z-report) ----------

async function endOfDay(db, { branch_id, date }) {
  const range = date ? await resolveRange(db, { from: date, to: date }) : await resolveRange(db, { period: 'today' });
  const { from, to } = range;

  const { rows: branchRows } = await db.query('SELECT id, name FROM branches WHERE id = $1', [branch_id]);
  if (!branchRows[0]) throw ApiError.notFound('Branch not found');

  const [sales, payments, vat, products, voids, shifts, expenses, credit, etims] = await Promise.all([
    summary(db, { from, to, branch_id }),
    Sale.paymentBreakdown(db, { from, to, branch_id }),
    vatSummary(db, { from, to, branch_id }),
    topProducts(db, { from, to, branch_id, by: 'revenue', limit: 5 }),
    ledger(
      db,
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(total), 0) AS total
         FROM sales WHERE branch_id = $3 AND status = 'void' AND sale_type = 'sale'
          AND voided_at >= $1::timestamptz AND voided_at < $2::timestamptz`,
      [from, to, branch_id]
    ),
    ledger(
      db,
      `SELECT sh.id, u.full_name AS cashier, sh.status, sh.opened_at, sh.closed_at, sh.opening_float,
              sh.expected_cash, sh.counted_cash, sh.variance
         FROM shifts sh JOIN users u ON u.id = sh.user_id
        WHERE sh.branch_id = $3
          AND ((sh.opened_at >= $1::timestamptz AND sh.opened_at < $2::timestamptz)
            OR (sh.closed_at >= $1::timestamptz AND sh.closed_at < $2::timestamptz))
        ORDER BY sh.opened_at`,
      [from, to, branch_id]
    ),
    Expense.summaryByCategory(db, { from, to, branch_id }),
    ledger(
      db,
      `SELECT COALESCE(SUM(l.amount), 0) AS total
         FROM customer_ledger l JOIN sales s ON s.id = l.sale_id
        WHERE l.entry_type = 'credit_sale' AND s.branch_id = $3
          AND l.created_at >= $1::timestamptz AND l.created_at < $2::timestamptz`,
      [from, to, branch_id]
    ),
    ledger(
      db,
      `SELECT e.status, COUNT(*)::int AS count
         FROM etims_invoices e JOIN sales s ON s.id = e.sale_id
        WHERE s.branch_id = $3 AND s.sold_at >= $1::timestamptz AND s.sold_at < $2::timestamptz
        GROUP BY e.status`,
      [from, to, branch_id]
    ),
  ]);

  const expenseTotal = round2(expenses.reduce((s, e) => s + Number(e.total), 0));
  const closed = shifts.filter((s) => s.status === 'closed');
  return {
    date: range.from_date,
    timezone: range.timezone,
    branch: branchRows[0],
    sales,
    payments,
    vat,
    top_products: products,
    voids: voids[0],
    credit_given: round2(credit[0].total),
    expenses: { total: expenseTotal, categories: expenses },
    shifts: {
      list: shifts,
      cash_variance: round2(closed.reduce((s, x) => s + Number(x.variance || 0), 0)),
      still_open: shifts.filter((s) => s.status === 'open').length,
    },
    etims: Object.fromEntries(etims.map((r) => [r.status, r.count])),
  };
}

module.exports = {
  resolveRange,
  summary,
  dashboard,
  salesSeries,
  topProducts,
  salesByCategory,
  profit,
  vatSummary,
  cashierPerformance,
  endOfDay,
};
