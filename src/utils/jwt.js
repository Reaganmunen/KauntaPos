'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

/**
 * Access tokens are short-lived JWTs. Shop staff and Kaunta platform admins use DIFFERENT secrets
 * and audiences, so a shop token can never be accepted by the platform panel (or the reverse).
 * Refresh tokens are NOT JWTs: they are random strings, stored only as a hash (see below).
 *
 *   JWT_SECRET            signs shop tokens      (32+ random characters)
 *   PLATFORM_JWT_SECRET   signs platform tokens  (32+ random characters, different from the above)
 *   ACCESS_TOKEN_TTL      default '15m'
 *   PLATFORM_TOKEN_TTL    default '8h'
 */
const ISSUER = 'kaunta';

function secret(name) {
  const value = process.env[name];
  if (!value || value.length < 32) {
    throw new Error(`${name} must be set to a random string of at least 32 characters`);
  }
  return value;
}

function signAccessToken({ userId, tenantId }) {
  return jwt.sign({ tid: tenantId, typ: 'access' }, secret('JWT_SECRET'), {
    algorithm: 'HS256',
    subject: userId,
    issuer: ISSUER,
    audience: 'tenant',
    expiresIn: process.env.ACCESS_TOKEN_TTL || '15m',
  });
}

/** Returns { sub, tid, ... } or throws a jsonwebtoken error (TokenExpiredError, JsonWebTokenError). */
function verifyAccessToken(token, { ignoreExpiration = false } = {}) {
  const payload = jwt.verify(token, secret('JWT_SECRET'), {
    algorithms: ['HS256'],
    issuer: ISSUER,
    audience: 'tenant',
    ignoreExpiration,
  });
  if (payload.typ !== 'access' || !payload.sub || !payload.tid) {
    throw new jwt.JsonWebTokenError('invalid token');
  }
  return payload;
}

function signPlatformToken({ adminId }) {
  return jwt.sign({ typ: 'platform' }, secret('PLATFORM_JWT_SECRET'), {
    algorithm: 'HS256',
    subject: adminId,
    issuer: ISSUER,
    audience: 'platform',
    expiresIn: process.env.PLATFORM_TOKEN_TTL || '8h',
  });
}

function verifyPlatformToken(token) {
  const payload = jwt.verify(token, secret('PLATFORM_JWT_SECRET'), {
    algorithms: ['HS256'],
    issuer: ISSUER,
    audience: 'platform',
  });
  if (payload.typ !== 'platform' || !payload.sub) throw new jwt.JsonWebTokenError('invalid token');
  return payload;
}

/** Random opaque token for refresh / password reset / invites. Store only hashToken(token). */
function generateOpaqueToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  signPlatformToken,
  verifyPlatformToken,
  generateOpaqueToken,
  hashToken,
};
