'use strict';

const crypto = require('crypto');

/**
 * Gives every request an id (from X-Request-Id if the caller sent a sane one), echoes it back in
 * the response header and error bodies, and writes one JSON log line per request when it finishes.
 */
module.exports = function requestContext(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    if (process.env.NODE_ENV === 'test') return;
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        id: req.id,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
        tenant: req.tenantId || null,
        user: (req.user && req.user.id) || (req.admin && req.admin.id) || null,
        ip: req.ip,
      })
    );
  });
  next();
};
