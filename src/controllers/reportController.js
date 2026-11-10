'use strict';

/**
 * Reports. Date range: ?from=&to= (ISO dates) or ?period=today|yesterday|week|month|year;
 * defaults to today in the shop's timezone. Optional ?branch_id= narrows to one branch.
 * Heavy aggregation lives in services/ReportService.
 */
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/respond');
const { run, branchId } = require('../utils/context');
const { Sale, Expense, StockLevel, Branch } = require('../models');
const ReportService = require('../services/ReportService');

// Resolves the range and branch once, then runs the report inside one tenant transaction.
function report(handler) {
  return asyncHandler(async (req, res) => {
    const branch = branchId(req, { required: false });
    const data = await run(req, async (db) => {
      const range = await ReportService.resolveRange(db, req.query);
      return { range, ...(await handler(db, { range, branch, query: req.query })) };
    });
    return ok(res, data);
  });
}

// GET /reports/dashboard   today's headline numbers, 7-day trend, low stock, eTIMS backlog
exports.dashboard = asyncHandler(async (req, res) => {
  const branch = branchId(req, { required: false });
  const data = await run(req, (db) => ReportService.dashboard(db, { branch_id: branch }));
  return ok(res, data);
});

// GET /reports/sales?group_by=hour|day|week|month
exports.sales = report(async (db, { range, branch, query }) => ({
  group_by: query.group_by || 'day',
  series: await ReportService.salesSeries(db, {
    from: range.from, to: range.to, branch_id: branch, group_by: query.group_by || 'day',
  }),
}));

// GET /reports/top-products?by=revenue|quantity|profit&limit=20
exports.topProducts = report(async (db, { range, branch, query }) => ({
  products: await ReportService.topProducts(db, {
    from: range.from, to: range.to, branch_id: branch,
    by: query.by || 'revenue',
    limit: Math.min(parseInt(query.limit, 10) || 20, 100),
  }),
}));

// GET /reports/by-category
exports.byCategory = report(async (db, { range, branch }) => ({
  categories: await ReportService.salesByCategory(db, { from: range.from, to: range.to, branch_id: branch }),
}));

// GET /reports/payment-methods   cash / M-Pesa / card / credit split (refunds count negative)
exports.byPaymentMethod = report(async (db, { range, branch }) => ({
  methods: await Sale.paymentBreakdown(db, { from: range.from, to: range.to, branch_id: branch }),
}));

// GET /reports/profit   revenue, cost of goods, gross profit, expenses, net profit
exports.profit = report(async (db, { range, branch }) => {
  const profit = await ReportService.profit(db, { from: range.from, to: range.to, branch_id: branch });
  const expenses = await Expense.summaryByCategory(db, {
    from: range.from, to: range.to, branch_id: branch,
  });
  const expenseTotal = expenses.reduce((sum, e) => sum + Number(e.total), 0);
  return {
    ...profit,
    expenses: expenseTotal,
    net_profit: Math.round((Number(profit.gross_profit) - expenseTotal) * 100) / 100,
    expense_breakdown: expenses,
  };
});

// GET /reports/vat   output VAT by tax code (matches what goes to KRA)
exports.vat = report(async (db, { range, branch }) => ({
  tax: await ReportService.vatSummary(db, { from: range.from, to: range.to, branch_id: branch }),
}));

// GET /reports/cashiers   sales per cashier
exports.cashiers = report(async (db, { range, branch }) => ({
  cashiers: await ReportService.cashierPerformance(db, { from: range.from, to: range.to, branch_id: branch }),
}));

// GET /reports/expenses
exports.expenses = report(async (db, { range, branch }) => {
  const categories = await Expense.summaryByCategory(db, { from: range.from, to: range.to, branch_id: branch });
  return { total: categories.reduce((s, c) => s + Number(c.total), 0), categories };
});

// GET /reports/stock-value   stock at cost and at retail price, per branch and in total
exports.stockValue = asyncHandler(async (req, res) => {
  const branch = branchId(req, { required: false });
  const data = await run(req, async (db) => {
    const branches = branch
      ? [await Branch.findById(db, branch)]
      : await Branch.findAll(db, { filters: { is_active: true } });
    const rows = [];
    for (const b of branches.filter(Boolean)) {
      rows.push({ branch_id: b.id, branch_name: b.name, ...(await StockLevel.valuation(db, b.id)) });
    }
    return {
      branches: rows,
      total: rows.reduce(
        (acc, r) => ({
          cost_value: acc.cost_value + Number(r.cost_value),
          retail_value: acc.retail_value + Number(r.retail_value),
        }),
        { cost_value: 0, retail_value: 0 }
      ),
    };
  });
  return ok(res, data);
});

// GET /reports/end-of-day?date=2026-11-10   the Z-report for one branch and day
exports.endOfDay = asyncHandler(async (req, res) => {
  const branch = branchId(req);
  const data = await run(req, (db) => ReportService.endOfDay(db, { branch_id: branch, date: req.query.date }));
  return ok(res, data);
});
