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
const { invalidateTenant } = require('../utils/contextCache');
const OnboardingService = require('../services/OnboardingService');
const KScale = require('../../public/js/scale-barcode');
const { planFor, usage } = require('../utils/limits');
const {
  MODULES, describeAccess, planAllows, planHas, effectiveFeatures, periodDays,
} = require('../utils/entitlements');

const PROFILE_FIELDS = [
  'name', 'legal_name', 'kra_pin', 'vat_registered', 'email', 'phone',
  'address', 'county', 'logo_url', 'timezone',
];

// Modules a shop owner may switch on/off themselves (and the plan may leave out).
const TOGGLEABLE_FEATURES = MODULES;

// An M-Pesa confirmation code: 10 letters and digits, e.g. SJK1A2B3C4.
const RECEIPT_RE = /^[A-Z0-9]{10}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PENDING_PAYMENTS = 3;

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
  // The scale label layout is checked here so a typo cannot silently stop every weighed item from scanning.
  const patch = { ...req.body };
  if (patch.scale_barcode !== undefined) {
    const checked = KScale.normalize(patch.scale_barcode);
    if (!checked.ok) throw ApiError.unprocessable(checked.error, undefined, 'invalid_scale_barcode');
    patch.scale_barcode = checked.config;
  }
  const tenant = await run(req, async (db) => {
    const updated = await Tenant.mergeSettings(db, req.tenantId, patch);
    await audit(db, req, 'tenant.settings', 'tenant', req.tenantId, { after: patch });
    return updated;
  });
  return ok(res, tenant.settings);
});

// ---------- get-started checklist ----------

// GET /tenant/onboarding  -> { steps: [{ key, title, done, optional, href, ... }], done, total, complete, dismissed }
exports.getOnboarding = asyncHandler(async (req, res) => {
  const data = await run(req, (db) => OnboardingService.getChecklist(db, req.tenantId));
  return ok(res, data);
});

// POST /tenant/onboarding/dismiss  closes the card for the whole shop
exports.dismissOnboarding = asyncHandler(async (req, res) => {
  await run(req, async (db) => {
    await Tenant.mergeSettings(db, req.tenantId, { onboarding_dismissed: true });
    await audit(db, req, 'tenant.onboarding_dismissed', 'tenant', req.tenantId, null);
  });
  return ok(res, { dismissed: true });
});

// ---------- modules / feature flags ----------

// GET /tenant/features  -> { restaurant: false, batch_expiry: true, ... }
// A module the shop's plan leaves out always shows false, whatever the shop switched on before.
exports.getFeatures = asyncHandler(async (req, res) => {
  const map = await run(req, async (db) => {
    const flags = await TenantFeature.asMap(db);
    return effectiveFeatures(flags, await planFor(db, req.tenantId));
  });
  return ok(res, map);
});

// PUT /tenant/features  { restaurant: true, storefront: false }  (only switchable modules)
// Switching a module OFF is always allowed. Switching one ON needs the shop's plan to include it.
exports.setFeatures = asyncHandler(async (req, res) => {
  const changes = {};
  for (const [key, value] of Object.entries(req.body || {})) {
    if (TOGGLEABLE_FEATURES.includes(key)) changes[key] = Boolean(value);
  }
  if (!Object.keys(changes).length) {
    throw ApiError.unprocessable(`Nothing to change. Switchable modules: ${TOGGLEABLE_FEATURES.join(', ')}`);
  }
  const map = await run(req, async (db) => {
    const plan = await planFor(db, req.tenantId);
    const blocked = Object.keys(changes).filter((key) => changes[key] && !planAllows(plan, key));
    if (blocked.length) {
      const names = blocked.map((key) => key.replace(/_/g, ' ')).join(', ');
      throw ApiError.forbidden(
        `Your plan does not include: ${names}. Upgrade your plan to switch ${blocked.length > 1 ? 'them' : 'it'} on.`,
        { features: blocked },
        'plan_upgrade_required'
      );
    }
    await TenantFeature.setMany(db, changes);
    await audit(db, req, 'tenant.features', 'tenant', req.tenantId, { after: changes });
    return effectiveFeatures(await TenantFeature.asMap(db), plan);
  });
  invalidateTenant(req.tenantId); // so requireFeature() sees the change straight away
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
    if (!planHas(plan, 'custom_domain')) {
      throw ApiError.forbidden('Custom domains are not included in your plan', { feature: 'custom_domain' }, 'plan_upgrade_required');
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

// What to tell a shop about paying. Set BILLING_PAYBILL or BILLING_TILL (and optionally BILLING_NOTE)
// in the environment; with neither set the billing screen says to ask Kaunta for the number.
function paymentInstructions(tenant) {
  const paybill = (process.env.BILLING_PAYBILL || '').trim();
  const till = (process.env.BILLING_TILL || '').trim();
  if (!paybill && !till) return null;
  return {
    paybill: paybill || null,
    till: till || null,
    account: tenant.slug,
    note: (process.env.BILLING_NOTE || '').trim() || null,
  };
}

// GET /tenant/subscription
//   access        { state, can_operate, read_only, ends_at, days_left, grace_ends_at } (see utils/entitlements)
//   usage         { branches|users|products: { used, limit } }, limit null = no limit
//   modules       { restaurant: { enabled, allowed }, ... }  allowed = included in the plan
exports.getSubscription = asyncHandler(async (req, res) => {
  const data = await run(req, async (db) => {
    const tenant = await Tenant.findById(db, req.tenantId);
    const plan = tenant.plan_id ? await Plan.findById(db, tenant.plan_id) : null;
    const access = describeAccess(tenant);
    const flags = await TenantFeature.asMap(db);
    const pending = await db.query("SELECT COUNT(*)::int AS n FROM subscription_payments WHERE status = 'pending' AND method <> 'paystack'");
    return {
      status: tenant.status,
      access,
      plan,
      trial_ends_at: tenant.trial_ends_at,
      current_period_start: tenant.current_period_start,
      current_period_end: tenant.current_period_end,
      days_left: access.days_left,
      can_operate: access.can_operate,
      usage: await usage(db, req.tenantId),
      modules: Object.fromEntries(
        MODULES.map((key) => [key, { enabled: flags[key] === true, allowed: planAllows(plan, key) }])
      ),
      custom_domain: planHas(plan, 'custom_domain'),
      period_days: periodDays(),
      payment_instructions: paymentInstructions(tenant),
      paystack_enabled: require('../services/PaystackService').isConfigured(),
      pending_payments: pending.rows[0].n,
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
// The code must look like a real M-Pesa code, can only be submitted once, and a shop may have
// only a few payments waiting at a time.
exports.submitPayment = asyncHandler(async (req, res) => {
  requireFields(req.body, ['amount', 'mpesa_receipt']);
  const amount = positive(req.body.amount, 'amount');
  const receipt = String(req.body.mpesa_receipt).trim().toUpperCase();
  if (!RECEIPT_RE.test(receipt)) {
    throw ApiError.unprocessable(
      'That does not look like an M-Pesa code. It has 10 letters and numbers, for example SJK1A2B3C4.',
      undefined,
      'invalid_receipt'
    );
  }
  if (req.body.plan_id && !UUID_RE.test(String(req.body.plan_id))) {
    throw ApiError.unprocessable('Choose one of the listed plans', undefined, 'invalid_plan');
  }

  const payment = await run(req, async (db) => {
    const tenant = await Tenant.findById(db, req.tenantId);
    const planId = req.body.plan_id || tenant.plan_id || null;
    if (planId) {
      const plan = await Plan.findById(db, planId);
      if (!plan || !plan.is_active) {
        throw ApiError.unprocessable('Choose one of the listed plans', undefined, 'invalid_plan');
      }
    }
    const same = await db.query("SELECT 1 FROM subscription_payments WHERE mpesa_receipt = $1 AND status <> 'failed' LIMIT 1", [receipt]);
    if (same.rows[0]) {
      throw ApiError.conflict('That M-Pesa code has already been sent to Kaunta', undefined, 'duplicate_receipt');
    }
    const waiting = await db.query("SELECT COUNT(*)::int AS n FROM subscription_payments WHERE status = 'pending' AND method <> 'paystack'");
    if (waiting.rows[0].n >= MAX_PENDING_PAYMENTS) {
      throw ApiError.conflict(
        'You already have payments waiting for Kaunta to confirm. Please wait for them to be confirmed first.',
        undefined,
        'too_many_pending'
      );
    }
    const record = await SubscriptionPayment.create(db, {
      plan_id: planId,
      amount,
      method: 'mpesa',
      mpesa_receipt: receipt,
      reference: req.body.reference ? String(req.body.reference).slice(0, 120) : null,
      notes: req.body.notes ? String(req.body.notes).slice(0, 500) : null,
      status: 'pending',
    });
    await audit(db, req, 'subscription.payment_submitted', 'subscription_payment', record.id, { amount });
    return record;
  });
  return created(res, payment);
});
