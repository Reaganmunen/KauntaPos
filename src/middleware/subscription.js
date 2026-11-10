'use strict';

const ApiError = require('../utils/ApiError');
const { Tenant } = require('../models');

/**
 * Subscription gate for logged-in shop requests (run after authenticate).
 *
 *   active / past_due / trial still running -> everything works
 *   trial ended or cancelled                -> READ-ONLY: the shop can still view and export its
 *                                              data and pay, but cannot change anything
 *   suspended                               -> locked out, except login and the payment screens
 *
 * Always allowed, whatever the status: auth, the subscription/plans screens, and pushing sales that
 * were already made offline (those customers have already been served and taxed).
 */
const prefix = (process.env.API_PREFIX || '/api').replace(/\/$/, '');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ALWAYS_ALLOWED = [
  new RegExp(`^${escape(prefix)}/auth/`),
  new RegExp(`^${escape(prefix)}/tenant/(subscription|plans)`),
  new RegExp(`^${escape(prefix)}/sync/sales$`),
];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

module.exports = function requireActiveSubscription(req, res, next) {
  const ctx = req.tenantCtx;
  if (!ctx) return next(ApiError.unauthorized());
  if (Tenant.canOperate(ctx)) return next();

  const path = req.originalUrl.split('?')[0];
  if (ALWAYS_ALLOWED.some((re) => re.test(path))) return next();

  const state = ctx.status === 'trial' ? 'trial_ended' : ctx.status;
  res.setHeader('X-Subscription-Status', state);

  if (ctx.status === 'suspended') {
    return next(new ApiError(403, 'This account is suspended. Please contact Kaunta support.', { status: state }, 'account_suspended'));
  }
  if (SAFE_METHODS.has(req.method)) return next(); // read-only mode

  const message =
    ctx.status === 'trial'
      ? 'Your free trial has ended. Subscribe to keep making changes.'
      : 'Your subscription is not active. Renew to keep making changes.';
  return next(new ApiError(402, message, { status: state }, 'subscription_inactive'));
};
