'use strict';

const ApiError = require('../utils/ApiError');
const { accessState, canOperate, READ_ONLY_MESSAGES } = require('../utils/entitlements');

/**
 * Subscription gate for logged-in shop requests (run after authenticate).
 *
 *   trial / active / grace   everything works (grace = the few days after a paid period ends)
 *   trial ended, expired,    READ-ONLY: the shop can still view and export its data and pay, but
 *   cancelled                cannot change anything (402 subscription_inactive)
 *   suspended                locked out (403 account_suspended), except login and the payment screens
 *
 * "Which state" comes from utils/entitlements, which looks at the dates as well as the status, so a
 * paid period that has run out stops counting without anyone editing the tenant.
 *
 * Always allowed, whatever the state: the subscription / plans screens (so the shop can pay), and
 * pushing sales that were already made offline (those customers have already been served and taxed).
 * The state is sent back in the X-Subscription-Status header on every answer.
 */
const prefix = (process.env.API_PREFIX || '/api').replace(/\/$/, '');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PAYMENT_SCREENS = new RegExp(`^${escape(prefix)}/tenant/(subscription(/payments|/paystack/(initialize|verify))?|plans)/?$`);
const OFFLINE_SALES = new RegExp(`^${escape(prefix)}/sync/sales/?$`);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

module.exports = function requireActiveSubscription(req, res, next) {
  const ctx = req.tenantCtx;
  if (!ctx) return next(ApiError.unauthorized());

  const state = accessState(ctx);
  req.accessState = state;
  res.setHeader('X-Subscription-Status', state);
  if (canOperate(state)) return next();

  const path = req.originalUrl.split('?')[0];
  if (PAYMENT_SCREENS.test(path) || OFFLINE_SALES.test(path)) return next();

  if (state === 'suspended') {
    return next(new ApiError(403, 'This account is suspended. Please contact Kaunta support.', { status: state }, 'account_suspended'));
  }
  if (SAFE_METHODS.has(req.method)) return next(); // read-only mode

  return next(new ApiError(402, READ_ONLY_MESSAGES[state] || READ_ONLY_MESSAGES.inactive, { status: state }, 'subscription_inactive'));
};
