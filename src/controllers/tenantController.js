'use strict';

/** The shop's own account: profile, settings, modules, domains and subscription. */
const dns = require('dns').promises;
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/respond');
const { requireFields, pick, positive } = require('../utils/validate');
const { run, pageParams } = require('../utils/context');
const { audit } = require('../utils/audit');
const { Tenant, TenantFeature, TenantDomain, SubscriptionPayment, Plan } = require('../models');

const PROFILE_FIELDS = [
  'name', 'legal_name', 'kra_pin', 'vat_registered', 'email', 'phone',
  'address', 'county', 'logo_url', 'timezone',
];

// Modules a shop owner may switch on/off themselves.
const TOGGLEABLE_FEATURES = [
  'batch_expiry', 'prescriptions', 'restaurant', 'modifiers', 'recipes',
  'variants', 'storefront', 'credit_sales', 'multi_branch',
];

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;

// GET /tenant
exports.getProfile = asyncHandler(async (req, res) => {
  const data = await run(req, async (db) => {
    const tenant = await Tenant.findById(db, req.tenantId);
    if (!tenant) throw ApiError.notFound('Shop not found');
    const plan = tenant.plan_id ? await Plan.findById(db, tenant.plan_id) : null;
    return { ...tenant, plan };
  });
  return ok(res, data);
});

// PATCH /tenant
exports.updateProfile = asyncHandler(async (req, res) => {
  const data = pick(req.body, PROFILE_FIELDS);
  const tenant = await run(req, async (db) => {
    const updated = await Tenant.update(db, req.tenantId, data);
    await audit(db, req, 'tenant.update', 'tenant', req.tenantId, { after: data });
    return updated;
  });
  return ok(res, tenant);
});

// PATCH /tenant/settings  { receipt_footer, allow_negative_stock, ... } merged into tenants.settings
exports.mergeSettings = asyncHandler(async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw ApiError.unprocessable('Send an object of settings to change');
  }
  const tenant = await run(req, async (db) => {
    const updated = await Tenant.mergeSettings(db, req.tenantId, req.body);
    await audit(db, req, 'tenant.settings', 'tenant', req.tenantId, { after: req.body });
    return updated;
  });
  return ok(res, tenant.settings);
});

// ---------- modules / feature flags ----------

// GET /tenant/features  -> { restaurant: false, batch_expiry: true, ... }
exports.getFeatures = asyncHandler(async (req, res) => {
  const map = await run(req, (db) => TenantFeature.asMap(db));
  return ok(res, map);
});

// PUT /tenant/features  { restaurant: true, storefront: false }  (only switchable modules)
exports.setFeatures = asyncHandler(async (req, res) => {
  const changes = {};
  for (const [key, value] of Object.entries(req.body || {})) {
    if (TOGGLEABLE_FEATURES.includes(key)) changes[key] = Boolean(value);
  }
  if (!Object.keys(changes).length) {
    throw ApiError.unprocessable(`Nothing to change. Switchable modules: ${TOGGLEABLE_FEATURES.join(', ')}`);
  }
  const map = await run(req, async (db) => {
    await TenantFeature.setMany(db, changes);
    await audit(db, req, 'tenant.features', 'tenant', req.tenantId, { after: changes });
    return TenantFeature.asMap(db);
  });
  return ok(res, map);
});

// ---------- domains ----------

// GET /tenant/domains
exports.listDomains = asyncHandler(async (req, res) => {
  const rows = await run(req, (db) => TenantDomain.findAll(db));
  return ok(res, rows);
});

// POST /tenant/domains  { domain }  custom domains only; plan must allow it
exports.addDomain = asyncHandler(async (req, res) => {
  requireFields(req.body, ['domain']);
  const domain = String(req.body.domain).trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) throw ApiError.unprocessable('That does not look like a valid domain');

  const row = await run(req, async (db) => {
    const tenant = await Tenant.findById(db, req.tenantId);
    const plan = tenant && tenant.plan_id ? await Plan.findById(db, tenant.plan_id) : null;
    if (!plan || !plan.features || !plan.features.custom_domain) {
      throw ApiError.forbidden('Custom domains are not included in your plan');
    }
    const record = await TenantDomain.addCustom(db, domain);
    await audit(db, req, 'domain.add', 'tenant_domain', record.id, { domain });
    return record;
  });
  return created(res, {
    ...row,
    dns_instructions: {
      type: 'TXT',
      host: `_kaunta-verify.${row.domain}`,
      value: row.verification_token,
    },
  });
});

// POST /tenant/domains/:id/verify  checks the TXT record, then marks the domain verified
exports.verifyDomain = asyncHandler(async (req, res) => {
  const domain = await run(req, (db) => TenantDomain.findById(db, req.params.id));
  if (!domain) throw ApiError.notFound('Domain not found');
  if (domain.verified_at) return ok(res, domain);

  let records = [];
  try {
    records = (await dns.resolveTxt(`_kaunta-verify.${domain.domain}`)).map((parts) => parts.join(''));
  } catch (err) {
    // no record yet; handled below
  }
  if (!records.includes(domain.verification_token)) {
    throw ApiError.unprocessable('The DNS record was not found yet. DNS changes can take a while; try again shortly.');
  }
  const verified = await run(req, (db) => TenantDomain.markVerified(db, domain.id));
  return ok(res, verified);
});

// POST /tenant/domains/:id/primary
exports.setPrimaryDomain = asyncHandler(async (req, res) => {
  const row = await run(req, (db) => TenantDomain.setPrimary(db, req.params.id));
  if (!row) throw ApiError.unprocessable('Only a verified domain can be made primary');
  return ok(res, row);
});

// DELETE /tenant/domains/:id  (custom domains only)
exports.removeDomain = asyncHandler(async (req, res) => {
  await run(req, async (db) => {
    const domain = await TenantDomain.findById(db, req.params.id);
    if (!domain) throw ApiError.notFound('Domain not found');
    if (domain.kind !== 'custom') throw ApiError.forbidden('The default Kaunta address cannot be removed');
    await TenantDomain.remove(db, domain.id);
    await audit(db, req, 'domain.remove', 'tenant_domain', domain.id, { domain: domain.domain });
  });
  return ok(res, { deleted: true });
});

// ---------- subscription ----------

// GET /tenant/plans  public price list for the upgrade screen
exports.listPlans = asyncHandler(async (req, res) => {
  const plans = await run(req, (db) => Plan.listActive(db));
  return ok(res, plans);
});

// GET /tenant/subscription
exports.getSubscription = asyncHandler(async (req, res) => {
  const data = await run(req, async (db) => {
    const tenant = await Tenant.findById(db, req.tenantId);
    const plan = tenant.plan_id ? await Plan.findById(db, tenant.plan_id) : null;
    const endsAt = tenant.status === 'trial' ? tenant.trial_ends_at : tenant.current_period_end;
    const daysLeft = endsAt ? Math.ceil((new Date(endsAt) - Date.now()) / 86400000) : null;
    return {
      status: tenant.status,
      plan,
      trial_ends_at: tenant.trial_ends_at,
      current_period_start: tenant.current_period_start,
      current_period_end: tenant.current_period_end,
      days_left: daysLeft,
      can_operate: Tenant.canOperate(tenant),
    };
  });
  return ok(res, data);
});

// GET /tenant/subscription/payments
exports.listPayments = asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const result = await run(req, (db) => SubscriptionPayment.listForTenant(db, { page, limit }));
  return paginated(res, result);
});

// POST /tenant/subscription/payments  { plan_id, amount, mpesa_receipt, notes }
// The shop reports an M-Pesa payment; a platform admin confirms it (manual activation flow).
exports.submitPayment = asyncHandler(async (req, res) => {
  requireFields(req.body, ['amount', 'mpesa_receipt']);
  const amount = positive(req.body.amount, 'amount');
  const payment = await run(req, async (db) => {
    const record = await SubscriptionPayment.create(db, {
      plan_id: req.body.plan_id || null,
      amount,
      method: 'mpesa',
      mpesa_receipt: String(req.body.mpesa_receipt).trim().toUpperCase(),
      reference: req.body.reference || null,
      notes: req.body.notes || null,
      status: 'pending',
    });
    await audit(db, req, 'subscription.payment_submitted', 'subscription_payment', record.id, { amount });
    return record;
  });
  return created(res, payment);
});
