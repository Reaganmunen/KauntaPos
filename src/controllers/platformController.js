'use strict';

/**
 * Kaunta staff panel: tenants, plans and subscription payments. Uses the admin database
 * connection (bypasses tenant isolation), so these routes must sit behind platform-admin auth
 * (req.admin) and never be exposed to shop users.
 */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/respond');
const { requireFields, oneOf, positive, pick } = require('../utils/validate');
const { pageParams, clientMeta } = require('../utils/context');
const { withAdmin } = require('../config/database');
const { Tenant, Plan, SubscriptionPayment, PlatformAdmin } = require('../models');
const AuthService = require('../services/AuthService');

const TENANT_STATUSES = ['trial', 'active', 'past_due', 'suspended', 'cancelled'];
const PLAN_FIELDS = [
  'code', 'name', 'price_monthly', 'price_yearly', 'currency',
  'max_branches', 'max_users', 'max_products', 'features', 'is_active',
];

const toDate = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (isoDate, days) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// ---------- staff login ----------

// POST /platform/login  { email, password }
exports.login = asyncHandler(async (req, res) => {
  requireFields(req.body, ['email', 'password']);
  const result = await AuthService.platformLogin({
    email: req.body.email,
    password: req.body.password,
    ...clientMeta(req),
  });
  return ok(res, result);
});

// GET /platform/me
exports.me = asyncHandler(async (req, res) => {
  const admin = await withAdmin((db) => PlatformAdmin.findById(db, req.admin.id));
  if (!admin) throw ApiError.unauthorized('This account no longer exists');
  return ok(res, PlatformAdmin.sanitize(admin));
});

// ---------- overview ----------

// GET /platform/stats
exports.stats = asyncHandler(async (req, res) => {
  const data = await withAdmin(async (db) => {
    const byStatus = await db.query('SELECT status, COUNT(*)::int AS count FROM tenants GROUP BY status');
    const extra = await db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM tenants WHERE created_at > now() - interval '30 days') AS new_30d,
         (SELECT COUNT(*)::int FROM subscription_payments WHERE status = 'pending') AS pending_payments,
         (SELECT COALESCE(SUM(amount), 0) FROM subscription_payments
           WHERE status = 'confirmed' AND confirmed_at >= date_trunc('month', now())) AS revenue_this_month,
         (SELECT COUNT(*)::int FROM tenants
           WHERE status = 'trial' AND trial_ends_at BETWEEN now() AND now() + interval '3 days') AS trials_ending_soon`
    );
    return {
      tenants_by_status: byStatus.rows.reduce((acc, r) => ({ ...acc, [r.status]: r.count }), {}),
      ...extra.rows[0],
    };
  });
  return ok(res, data);
});

// ---------- tenants ----------

// GET /platform/tenants?q=&status=
exports.listTenants = asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const where = [];
  const values = [];
  if (req.query.status) {
    values.push(req.query.status);
    where.push(`t.status = $${values.length}`);
  }
  if (req.query.q) {
    values.push(Tenant.like(req.query.q));
    where.push(`(t.name ILIKE $${values.length} OR t.slug ILIKE $${values.length} OR t.email ILIKE $${values.length})`);
  }
  const result = await withAdmin((db) =>
    Tenant.runPaged(db, {
      select: `t.*, p.name AS plan_name,
               (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = t.id AND u.is_active) AS user_count`,
      from: 'tenants t LEFT JOIN plans p ON p.id = t.plan_id',
      countFrom: 'tenants t',
      where,
      values,
      order: 't.created_at DESC',
      page,
      limit,
    })
  );
  return paginated(res, result);
});

// GET /platform/tenants/:id
exports.getTenant = asyncHandler(async (req, res) => {
  const data = await withAdmin(async (db) => {
    const tenant = await Tenant.findById(db, req.params.id);
    if (!tenant) return null;
    const usage = await db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM users WHERE tenant_id = $1 AND is_active) AS users,
         (SELECT COUNT(*)::int FROM branches WHERE tenant_id = $1 AND is_active) AS branches,
         (SELECT COUNT(*)::int FROM products WHERE tenant_id = $1 AND deleted_at IS NULL) AS products,
         (SELECT COUNT(*)::int FROM sales WHERE tenant_id = $1 AND sold_at > now() - interval '30 days') AS sales_30d,
         (SELECT COALESCE(SUM(total), 0) FROM sales
           WHERE tenant_id = $1 AND sale_type = 'sale' AND status = 'completed'
             AND sold_at > now() - interval '30 days') AS revenue_30d,
         (SELECT MAX(sold_at) FROM sales WHERE tenant_id = $1) AS last_sale_at`,
      [tenant.id]
    );
    const plan = tenant.plan_id ? await Plan.findById(db, tenant.plan_id) : null;
    return { ...tenant, plan, usage: usage.rows[0] };
  });
  if (!data) throw ApiError.notFound('Tenant not found');
  return ok(res, data);
});

// PUT /platform/tenants/:id/status  { status }
exports.setTenantStatus = asyncHandler(async (req, res) => {
  requireFields(req.body, ['status']);
  oneOf(req.body.status, TENANT_STATUSES, 'status');
  const tenant = await withAdmin((db) => Tenant.setStatus(db, req.params.id, req.body.status));
  if (!tenant) throw ApiError.notFound('Tenant not found');
  return ok(res, tenant);
});

// POST /platform/tenants/:id/extend-trial  { days }
exports.extendTrial = asyncHandler(async (req, res) => {
  const days = Math.floor(positive(req.body.days, 'days'));
  const tenant = await withAdmin(async (db) => {
    const { rows } = await db.query(
      `UPDATE tenants
          SET trial_ends_at = GREATEST(COALESCE(trial_ends_at, now()), now()) + ($2::int * interval '1 day'),
              status = CASE WHEN status IN ('suspended', 'past_due') THEN 'trial' ELSE status END
        WHERE id = $1
        RETURNING *`,
      [req.params.id, days]
    );
    return rows[0] || null;
  });
  if (!tenant) throw ApiError.notFound('Tenant not found');
  return ok(res, tenant);
});

// PUT /platform/tenants/:id/plan  { plan_id }
exports.changePlan = asyncHandler(async (req, res) => {
  requireFields(req.body, ['plan_id']);
  const tenant = await withAdmin(async (db) => {
    const plan = await Plan.findById(db, req.body.plan_id);
    if (!plan) throw ApiError.unprocessable('That plan does not exist');
    return Tenant.update(db, req.params.id, { plan_id: plan.id });
  });
  if (!tenant) throw ApiError.notFound('Tenant not found');
  return ok(res, tenant);
});

// ---------- plans ----------

// GET /platform/plans
exports.listPlans = asyncHandler(async (req, res) => {
  const plans = await withAdmin((db) => Plan.findAll(db));
  return ok(res, plans);
});

// POST /platform/plans
exports.createPlan = asyncHandler(async (req, res) => {
  requireFields(req.body, ['code', 'name']);
  const plan = await withAdmin((db) => Plan.create(db, pick(req.body, PLAN_FIELDS)));
  return created(res, plan);
});

// PATCH /platform/plans/:id
exports.updatePlan = asyncHandler(async (req, res) => {
  const plan = await withAdmin((db) => Plan.update(db, req.params.id, pick(req.body, PLAN_FIELDS)));
  if (!plan) throw ApiError.notFound('Plan not found');
  return ok(res, plan);
});

// ---------- subscription payments (manual activation flow) ----------

// Sets the paid period (default: 30 days, extending from the current end if still running),
// then confirms the payment and activates the tenant.
async function confirmPayment(db, paymentId, adminId, { days = 30, period_start, period_end, plan_id } = {}) {
  const payment = await SubscriptionPayment.findById(db, paymentId);
  if (!payment) throw ApiError.notFound('Payment not found');
  if (payment.status === 'confirmed') throw ApiError.conflict('This payment is already confirmed');

  const tenant = await Tenant.findById(db, payment.tenant_id);
  const today = toDate(new Date());
  const currentEnd = tenant.current_period_end ? toDate(tenant.current_period_end) : null;
  const start = period_start || (currentEnd && currentEnd > today ? currentEnd : today);
  const end = period_end || addDays(start, days);

  await SubscriptionPayment.update(db, payment.id, {
    period_start: start,
    period_end: end,
    plan_id: plan_id || payment.plan_id,
  });
  return SubscriptionPayment.confirmAndActivate(db, payment.id, adminId);
}

// GET /platform/payments?status=pending
exports.listPayments = asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const where = [];
  const values = [];
  if (req.query.status) {
    values.push(req.query.status);
    where.push(`sp.status = $${values.length}`);
  }
  if (req.query.tenant_id) {
    values.push(req.query.tenant_id);
    where.push(`sp.tenant_id = $${values.length}`);
  }
  const result = await withAdmin((db) =>
    SubscriptionPayment.runPaged(db, {
      select: 'sp.*, t.name AS tenant_name, t.slug AS tenant_slug, pl.name AS plan_name',
      from: `subscription_payments sp
             JOIN tenants t ON t.id = sp.tenant_id
             LEFT JOIN plans pl ON pl.id = sp.plan_id`,
      where,
      values,
      order: 'sp.created_at DESC',
      page,
      limit,
    })
  );
  return paginated(res, result);
});

// POST /platform/payments/:id/confirm  { days?, period_start?, period_end?, plan_id? }
exports.confirmPayment = asyncHandler(async (req, res) => {
  const payment = await withAdmin((db) =>
    confirmPayment(db, req.params.id, req.admin.id, {
      days: req.body.days ? Math.floor(positive(req.body.days, 'days')) : 30,
      period_start: req.body.period_start,
      period_end: req.body.period_end,
      plan_id: req.body.plan_id,
    })
  );
  return ok(res, payment);
});

// POST /platform/payments/:id/reject
exports.rejectPayment = asyncHandler(async (req, res) => {
  const payment = await withAdmin(async (db) => {
    const existing = await SubscriptionPayment.findById(db, req.params.id);
    if (!existing) throw ApiError.notFound('Payment not found');
    if (existing.status !== 'pending') throw ApiError.conflict('Only a pending payment can be rejected');
    return SubscriptionPayment.markFailed(db, existing.id);
  });
  return ok(res, payment);
});

// POST /platform/payments  { tenant_id, amount, plan_id, days, method, reference, notes }
// Records a payment received outside the app (cash, bank) and activates the tenant straight away.
exports.recordPayment = asyncHandler(async (req, res) => {
  requireFields(req.body, ['tenant_id', 'amount', 'plan_id']);
  const amount = positive(req.body.amount, 'amount');

  const payment = await withAdmin(
    async (db) => {
      const record = await SubscriptionPayment.create(db, {
        plan_id: req.body.plan_id,
        amount,
        method: req.body.method || 'manual',
        reference: req.body.reference || null,
        notes: req.body.notes || null,
        status: 'pending',
      });
      return confirmPayment(db, record.id, req.admin.id, {
        days: req.body.days ? Math.floor(positive(req.body.days, 'days')) : 30,
        plan_id: req.body.plan_id,
      });
    },
    { tenantId: req.body.tenant_id }
  );
  return created(res, payment);
});
