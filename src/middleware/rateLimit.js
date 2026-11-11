'use strict';

const rateLimit = require('express-rate-limit');

/**
 * Rate limiters (express-rate-limit v7). Counts are per server process; for several instances
 * add a shared store (e.g. Redis) later. Behind a proxy set app.set('trust proxy', ...) so
 * req.ip is the real client address, otherwise everyone shares the proxy's limit.
 */
function limiter({ windowMs, limit, keyGenerator, skipSuccessfulRequests = false }) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator,
    skipSuccessfulRequests,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === 'test',
    handler: (req, res) =>
      res.status(429).json({
        success: false,
        error: {
          message: 'Too many requests. Please slow down and try again in a moment.',
          code: 'rate_limited',
          request_id: req.id,
        },
      }),
  });
}

const minute = 60 * 1000;

module.exports = {
  // whole authenticated API, per IP (shops often share one NAT address, so this is generous)
  api: limiter({ windowMs: minute, limit: 600 }),

  // login, PIN login, password reset, platform login: slows credential guessing (per IP + account).
  // Successful logins are not counted, so cashiers switching on a shared till are never locked out;
  // only failed attempts use up the allowance.
  login: limiter({
    windowMs: 15 * minute,
    limit: 10,
    skipSuccessfulRequests: true,
    keyGenerator: (req) =>
      `${req.ip}|${String((req.body && (req.body.identifier || req.body.user_id || req.body.email)) || '').toLowerCase()}`,
  }),
  auth: limiter({ windowMs: 15 * minute, limit: 60 }),

  // forgot / reset password: these always answer "ok", so every request counts (no skipping successes)
  recovery: limiter({
    windowMs: 15 * minute,
    limit: 10,
    keyGenerator: (req) => `${req.ip}|${String((req.body && (req.body.identifier || req.body.token)) || '').slice(0, 64).toLowerCase()}`,
  }),

  // shop signup, per IP
  register: limiter({ windowMs: 60 * minute, limit: 10 }),

  // public storefront browsing and cart
  publicStore: limiter({ windowMs: minute, limit: 240 }),

  // placing orders and sending M-Pesa prompts to customers' phones
  checkout: limiter({ windowMs: 10 * minute, limit: 15 }),

  // STK Push from the till: per signed-in user, so a busy shop sharing one IP is not throttled
  posStk: limiter({
    windowMs: 10 * minute,
    limit: 60,
    keyGenerator: (req) => (req.user ? `${req.tenantId}|${req.user.id}` : String(req.ip)),
  }),

  // Safaricom callbacks
  webhook: limiter({ windowMs: minute, limit: 1200 }),

  // platform admin panel
  platform: limiter({ windowMs: minute, limit: 120 }),
};
