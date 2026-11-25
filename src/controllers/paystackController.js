'use strict';

/** Paying for a subscription through Paystack (see services/PaystackService). */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/respond');
const { requireFields } = require('../utils/validate');
const { run } = require('../utils/context');
const { audit } = require('../utils/audit');
const { Tenant, Plan, SubscriptionPayment } = require('../models');
const Paystack = require('../services/PaystackService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REF_RE = /^[A-Za-z0-9._-]{8,100}$/;
const CURRENCY = () => (process.env.PAYSTACK_CURRENCY || 'KES').toUpperCase();

function callbackUrl(req) {
  if (process.env.PAYSTACK_CALLBACK_URL) return process.env.PAYSTACK_CALLBACK_URL;
  return `${req.protocol}://${req.get('host')}/renew.html`;
}

// POST /tenant/subscription/paystack/initialize  { plan_id, cycle: 'monthly' | 'yearly' }  (owner only)
// The price comes from the plan in the database, never from the browser.
exports.initialize = asyncHandler(async (req, res) => {
  if (!Paystack.isConfigured()) {
    throw new ApiError(503, 'Online payment is not switched on yet. Please pay by M-Pesa below.', undefined, 'paystack_not_configured');
  }
  requireFields(req.body, ['plan_id']);
  const cycle = req.body.cycle === 'yearly' ? 'yearly' : 'monthly';
  if (!UUID_RE.test(String(req.body.plan_id))) {
    throw ApiError.unprocessable('Choose one of the listed plans', undefined, 'invalid_plan');
  }

  // 1. record the attempt
  const { payment, email, plan } = await run(req, async (db) => {
    const tenant = await Tenant.findById(db, req.tenantId);
    const plan = await Plan.findById(db, req.body.plan_id);
    if (!plan || !plan.is_active) throw ApiError.unprocessable('Choose one of the listed plans', undefined, 'invalid_plan');

    const price = Number(cycle === 'yearly' ? plan.price_yearly : plan.price_monthly);
    if (!Number.isFinite(price) || price <= 0) {
      throw ApiError.unprocessable(`The ${plan.name} plan has no ${cycle} price`, undefined, 'no_price');
    }
    if (plan.currency && plan.currency.toUpperCase() !== CURRENCY()) {
      throw ApiError.unprocessable('This plan is not priced in the currency Paystack is set up for', undefined, 'currency_mismatch');
    }
    const email = [tenant.email, req.user && req.user.email].find((e) => e && EMAIL_RE.test(e));
    if (!email) {
      throw ApiError.unprocessable('Add an email address to your shop profile first. Paystack needs it for the receipt.', undefined, 'email_required');
    }

    const payment = await SubscriptionPayment.create(db, {
      plan_id: plan.id,
      amount: price,
      method: 'paystack',
      paystack_reference: Paystack.newReference(req.tenantId),
      billing_cycle: cycle,
      status: 'pending',
    });
    await audit(db, req, 'subscription.paystack_started', 'subscription_payment', payment.id, { amount: price, cycle });
    return { payment, email, plan };
  });

  // 2. open the Paystack checkout (outside the database transaction: it is a network call)
  try {
    const data = await Paystack.initialize({
      email,
      amount: payment.amount,
      currency: CURRENCY(),
      reference: payment.paystack_reference,
      callbackUrl: callbackUrl(req),
      metadata: { tenant_id: req.tenantId, plan_id: plan.id, cycle, payment_id: payment.id },
    });
    return ok(res, { authorization_url: data.authorization_url, reference: payment.paystack_reference });
  } catch (err) {
    console.error('Paystack initialize failed:', err.message);
    await run(req, (db) => SubscriptionPayment.markFailed(db, payment.id)).catch(() => {});
    throw new ApiError(502, 'Could not reach Paystack. Please try again in a moment.', undefined, 'paystack_unavailable');
  }
});

// GET /tenant/subscription/paystack/verify?reference=...  (owner only; the page the shop returns to calls this)
exports.verify = asyncHandler(async (req, res) => {
  const reference = String(req.query.reference || req.query.trxref || '');
  if (!REF_RE.test(reference)) throw ApiError.badRequest('Missing payment reference');

  // RLS makes this find only this shop's own payments
  const mine = await run(req, async (db) => {
    const { rows } = await db.query('SELECT id FROM subscription_payments WHERE paystack_reference = $1', [reference]);
    return rows[0] || null;
  });
  if (!mine) throw ApiError.notFound('Payment not found');

  let out;
  try {
    out = await Paystack.settle(reference);
  } catch (err) {
    console.error('Paystack verify failed:', err.message);
    return ok(res, { status: 'pending' }); // webhook will still activate it; the page can ask again
  }
  const status = { confirmed: 'confirmed', failed: 'failed', mismatch: 'review' }[out.result] || 'pending';
  return ok(res, { status });
});

// POST /hooks/paystack  (public; Paystack calls it. Signed with your secret key.)
exports.webhook = asyncHandler(async (req, res) => {
  if (!Paystack.validSignature(req.rawBody, req.get('x-paystack-signature'))) {
    return res.status(401).json({ success: false });
  }
  const event = req.body || {};
  const reference = event.data && event.data.reference;
  if (event.event === 'charge.success' && typeof reference === 'string' && REF_RE.test(reference)) {
    try {
      await Paystack.settle(reference); // unknown references (other uses of your account) are ignored
    } catch (err) {
      console.error('Paystack webhook settle failed:', err.message);
      return res.status(500).json({ success: false }); // Paystack retries
    }
  }
  return res.status(200).json({ success: true });
});
