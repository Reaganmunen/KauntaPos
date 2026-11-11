'use strict';

/**
 * Authentication logic for shop staff and Kaunta platform admins.
 *
 *  - Passwords and PINs are hashed with scrypt (Node's built-in crypto, no extra package).
 *    Stored format: scrypt$<N>$<salt b64>$<hash b64>.
 *  - Access tokens are JWTs (utils/jwt). Refresh tokens are random strings stored only as a hash,
 *    rotated on every use. Presenting an already-used refresh token revokes every session of that user.
 *  - Every method opens its own tenant transaction, so controllers need no transaction of their own.
 *
 * Note on failures: withTenant() rolls back when the callback throws. Where a failure must still
 * write something (token-reuse revocation), the callback RETURNS an outcome and the error is thrown
 * after the transaction has committed.
 */
const crypto = require('crypto');
const { promisify } = require('util');
const ApiError = require('../utils/ApiError');
const { slugify } = require('../utils/slugify');
const { withTenant, withTransaction, withAdmin } = require('../config/database');
const {
  signAccessToken, signPlatformToken, generateOpaqueToken, hashToken,
} = require('../utils/jwt');
const { invalidateUser } = require('../utils/contextCache');
const { Tenant, User, RefreshToken, UserToken, PlatformAdmin } = require('../models');

const scrypt = promisify(crypto.scrypt);

const SCRYPT_N = 16384;
const KEY_LEN = 64;
const REFRESH_TTL_DAYS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '30', 10);
const RESET_TTL_MINUTES = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESERVED_SLUGS = new Set(['www', 'api', 'app', 'admin', 'platform', 'mail', 'static', 'cdn', 'support', 'kaunta']);

// ---------- password hashing ----------

async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(plain), salt, KEY_LEN, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(plain, stored) {
  if (!stored) return false;
  const [scheme, n, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !n || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(String(plain), Buffer.from(salt, 'base64'), expected.length, { N: Number(n) });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Compared against when the account does not exist, so "unknown user" takes as long as "wrong password".
let dummyHashPromise = null;
const dummyHash = () => {
  if (!dummyHashPromise) dummyHashPromise = hashPassword(crypto.randomBytes(8).toString('hex'));
  return dummyHashPromise;
};

function assertStrongEnough(password) {
  const value = String(password || '');
  if (value.length < 8) throw ApiError.unprocessable('Password must be at least 8 characters');
  if (value.length > 128) throw ApiError.unprocessable('Password must be at most 128 characters');
}

const normaliseIdentifier = (identifier) => {
  const value = String(identifier || '').trim();
  return value.includes('@') ? value.toLowerCase() : value;
};

// ---------- PIN brute-force protection (in memory, per server) ----------

const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 5 * 60 * 1000;
const pinFails = new Map(); // `${tenantId}:${userId}` -> { count, lockedUntil }

function pinLocked(key) {
  const entry = pinFails.get(key);
  return Boolean(entry && entry.lockedUntil && entry.lockedUntil > Date.now());
}
function pinFailed(key) {
  const entry = pinFails.get(key) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= PIN_MAX_FAILS) {
    entry.lockedUntil = Date.now() + PIN_LOCK_MS;
    entry.count = 0;
  }
  pinFails.set(key, entry);
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pinFails) if (!entry.lockedUntil || entry.lockedUntil < now) pinFails.delete(key);
}, 10 * 60 * 1000).unref();

// ---------- sessions ----------

/**
 * Creates the access + refresh token pair. Runs inside the caller's tenant transaction.
 * Returns what the apps store: tokens, the user (no hashes) and the branches they may work in.
 */
async function issueSession(db, tenantId, user, meta = {}) {
  const refreshToken = generateOpaqueToken();
  await RefreshToken.create(db, {
    user_id: user.id,
    token_hash: hashToken(refreshToken),
    user_agent: meta.userAgent ? String(meta.userAgent).slice(0, 300) : null,
    ip: meta.ip || null,
    expires_at: new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000),
  });

  const branch_ids = await User.getBranchIds(db, user.id);
  return {
    access_token: signAccessToken({ userId: user.id, tenantId }),
    refresh_token: refreshToken,
    token_type: 'Bearer',
    user: { ...User.sanitize(user), branch_ids },
  };
}

async function tenantSummary(db, tenantId) {
  const { rows } = await db.query(
    'SELECT id, slug, name, status, business_type, trial_ends_at, current_period_end FROM tenants WHERE id = $1',
    [tenantId]
  );
  return rows[0] || null;
}

// ---------- public API ----------

/**
 * Signup: creates the shop (tenant, main branch, roles, owner, storefront row) and signs the owner in.
 * body: { slug, name, business_type, owner_name, owner_email, owner_phone, password }
 */
async function register(body, meta = {}) {
  assertStrongEnough(body.password);

  const slug = slugify(body.slug);
  if (slug.length < 3) throw ApiError.unprocessable('Shop address must be at least 3 letters or digits');
  if (RESERVED_SLUGS.has(slug)) throw ApiError.unprocessable('That shop address is reserved. Please choose another.');

  const ownerEmail = body.owner_email ? String(body.owner_email).trim().toLowerCase() : null;
  const ownerPhone = body.owner_phone ? String(body.owner_phone).trim() : null;
  const passwordHash = await hashPassword(body.password);

  let tenantId;
  try {
    tenantId = await withTransaction((db) =>
      Tenant.register(db, {
        slug,
        name: String(body.name).trim(),
        businessType: body.business_type || 'general',
        ownerName: String(body.owner_name).trim(),
        ownerEmail,
        ownerPhone,
        passwordHash,
      })
    );
  } catch (err) {
    if (err && err.code === '23505') {
      throw ApiError.conflict('That shop address or owner login is already taken', undefined, 'already_exists');
    }
    throw err;
  }

  return withTenant(tenantId, async (db) => {
    const owner = await User.findByIdentifier(db, ownerEmail || ownerPhone);
    if (!owner) throw new Error('register: the owner account was not created');
    await User.touchLogin(db, owner.id);
    const session = await issueSession(db, tenantId, owner, meta);
    return { ...session, tenant: await tenantSummary(db, tenantId) };
  });
}

/** Email-or-phone + password login for one shop. */
async function login({ tenantId, identifier, password, ip, userAgent }) {
  const outcome = await withTenant(tenantId, async (db) => {
    const user = await User.findByIdentifier(db, normaliseIdentifier(identifier));
    const valid = user
      ? await verifyPassword(password, user.password_hash)
      : (await verifyPassword(password, await dummyHash()), false);
    if (!valid) return { failed: true };

    await User.touchLogin(db, user.id);
    const session = await issueSession(db, tenantId, user, { ip, userAgent });
    return { session: { ...session, tenant: await tenantSummary(db, tenantId) } };
  });

  if (outcome.failed) {
    throw ApiError.unauthorized('Incorrect login details', undefined, 'invalid_credentials');
  }
  return outcome.session;
}

/** Quick cashier switch on a shared till: user id + PIN. */
async function pinLogin({ tenantId, userId, pin, ip, userAgent }) {
  const invalid = () => ApiError.unauthorized('Incorrect PIN', undefined, 'invalid_credentials');
  if (!UUID_RE.test(String(userId))) throw invalid();

  const key = `${tenantId}:${userId}`;
  if (pinLocked(key)) {
    throw new ApiError(429, 'Too many wrong PINs. Try again in a few minutes.', undefined, 'pin_locked');
  }

  const outcome = await withTenant(tenantId, async (db) => {
    const user = await User.findWithRole(db, userId);
    if (!user || !user.is_active || !user.pin_hash) {
      await verifyPassword(pin, await dummyHash());
      return { failed: true };
    }
    if (!(await verifyPassword(pin, user.pin_hash))) return { failed: true };

    await User.touchLogin(db, user.id);
    const session = await issueSession(db, tenantId, user, { ip, userAgent });
    return { session: { ...session, tenant: await tenantSummary(db, tenantId) } };
  });

  if (outcome.failed) {
    pinFailed(key);
    throw invalid();
  }
  pinFails.delete(key);
  return outcome.session;
}

/** Trades a refresh token for a new pair. The old token is revoked (rotation). */
async function refresh({ tenantId, refreshToken, ip, userAgent }) {
  const tokenHash = hashToken(refreshToken);

  const outcome = await withTenant(tenantId, async (db) => {
    const { rows } = await db.query('SELECT * FROM refresh_tokens WHERE token_hash = $1 LIMIT 1', [tokenHash]);
    const stored = rows[0];
    if (!stored) return { error: 'invalid' };

    if (stored.revoked_at) {
      // An old token came back: it may have been stolen. End every session of that user.
      await RefreshToken.revokeAllForUser(db, stored.user_id);
      return { error: 'reused' };
    }
    if (new Date(stored.expires_at) <= new Date()) return { error: 'invalid' };

    const user = await User.findWithRole(db, stored.user_id);
    if (!user || !user.is_active) {
      await RefreshToken.revoke(db, stored.id);
      return { error: 'inactive' };
    }

    await RefreshToken.revoke(db, stored.id);
    const session = await issueSession(db, tenantId, user, { ip, userAgent });
    return { session: { ...session, tenant: await tenantSummary(db, tenantId) } };
  });

  if (outcome.error === 'inactive') {
    throw ApiError.unauthorized('This account is no longer active', undefined, 'account_inactive');
  }
  if (outcome.error) {
    throw ApiError.unauthorized('Your session has expired. Please log in again.', undefined, 'invalid_refresh_token');
  }
  return outcome.session;
}

/** Revokes one refresh token. Never fails for an unknown token. */
async function logout({ tenantId, refreshToken }) {
  if (!tenantId || !refreshToken) return;
  await withTenant(tenantId, async (db) => {
    const { rows } = await db.query('SELECT id FROM refresh_tokens WHERE token_hash = $1 LIMIT 1', [
      hashToken(refreshToken),
    ]);
    if (rows[0]) await RefreshToken.revoke(db, rows[0].id);
  });
}

// ---------- password reset ----------

/**
 * How a reset link reaches the user. Replace with your email / SMS sender at start-up:
 *   AuthService.setResetNotifier(async ({ user, token, tenantId }) => { ... });
 * The default only logs (and prints the token outside production, to make local testing possible).
 */
let resetNotifier = async ({ user, token }) => {
  const line = { level: 'info', msg: 'password reset requested', user_id: user.id };
  if (process.env.NODE_ENV !== 'production') line.token = token;
  console.log(JSON.stringify(line));
};
function setResetNotifier(fn) {
  resetNotifier = fn;
}

/** Always completes quietly, whether or not the account exists. */
async function forgotPassword({ tenantId, identifier }) {
  const issued = await withTenant(tenantId, async (db) => {
    const user = await User.findByIdentifier(db, normaliseIdentifier(identifier));
    if (!user) return null;
    const token = generateOpaqueToken();
    await UserToken.create(db, {
      user_id: user.id,
      purpose: 'password_reset',
      token_hash: hashToken(token),
      expires_at: new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000),
    });
    return { user: User.sanitize(user), token };
  });

  if (!issued) return;
  try {
    await resetNotifier({ ...issued, tenantId });
  } catch (err) {
    console.error('Could not send the password reset message:', err);
  }
}

async function resetPassword({ tenantId, token, password }) {
  assertStrongEnough(password);
  const passwordHash = await hashPassword(password);

  const ok = await withTenant(tenantId, async (db) => {
    const record = await UserToken.findValid(db, hashToken(token), 'password_reset');
    if (!record) return false;
    await UserToken.markUsed(db, record.id);
    await User.update(db, record.user_id, { password_hash: passwordHash });
    await RefreshToken.revokeAllForUser(db, record.user_id);
    return true;
  });
  if (!ok) throw ApiError.badRequest('This reset link is invalid or has expired', undefined, 'invalid_token');
}

/** Signs the user out everywhere (including this device), so the apps should send them to login. */
async function changePassword({ tenantId, userId, currentPassword, newPassword }) {
  assertStrongEnough(newPassword);
  const newHash = await hashPassword(newPassword);

  const ok = await withTenant(tenantId, async (db) => {
    const user = await User.findById(db, userId);
    if (!user || !(await verifyPassword(currentPassword, user.password_hash))) return false;
    await User.update(db, userId, { password_hash: newHash });
    await RefreshToken.revokeAllForUser(db, userId);
    return true;
  });
  if (!ok) throw ApiError.unprocessable('Your current password is not correct', undefined, 'invalid_credentials');
  invalidateUser(tenantId, userId);
}

// ---------- platform staff ----------

async function platformLogin({ email, password }) {
  const admin = await withAdmin(async (db) => {
    const found = await PlatformAdmin.findByEmail(db, String(email || '').trim().toLowerCase());
    const valid = found
      ? await verifyPassword(password, found.password_hash)
      : (await verifyPassword(password, await dummyHash()), false);
    if (!valid) return null;
    await PlatformAdmin.touchLogin(db, found.id);
    return found;
  });
  if (!admin) throw ApiError.unauthorized('Incorrect login details', undefined, 'invalid_credentials');

  return {
    access_token: signPlatformToken({ adminId: admin.id }),
    token_type: 'Bearer',
    admin: PlatformAdmin.sanitize(admin),
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  register,
  login,
  pinLogin,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  changePassword,
  platformLogin,
  setResetNotifier,
};
