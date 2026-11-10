'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Guards the public M-Pesa webhooks (/hooks/pay/:token/...). Safaricom sends no login, so:
 *   1. the URL token must look like one we generated (48 hex characters) - anything else is a
 *      plain 404, so probing reveals nothing
 *   2. optionally only Safaricom's published IP addresses may call:
 *        MPESA_ALLOWED_IPS="196.201.214.200,196.201.214.206,..."   (leave empty to skip)
 *      Check Safaricom's current list before turning this on; it needs app.set('trust proxy', ...)
 *      when behind a proxy.
 *   3. the body must be a JSON object
 * Whether the token belongs to a real, active M-Pesa configuration is checked by MpesaService.
 */
const TOKEN_RE = /^[a-f0-9]{48}$/;

module.exports = function mpesaWebhookGuard(req, res, next) {
  if (!TOKEN_RE.test(req.params.token || '')) {
    return next(ApiError.notFound('Not found'));
  }

  const allowed = (process.env.MPESA_ALLOWED_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length) {
    const ip = String(req.ip || '').replace(/^::ffff:/, '');
    if (!allowed.includes(ip)) {
      console.warn(JSON.stringify({ level: 'warn', msg: 'webhook from unexpected IP', ip, id: req.id }));
      return next(ApiError.forbidden('Forbidden'));
    }
  }

  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return next(ApiError.badRequest('Invalid payload'));
  }
  return next();
};
