'use strict';

const crypto = require('crypto');

/**
 * AES-256-GCM encryption for secrets stored in the database (M-Pesa credentials,
 * Digitax API keys). ENCRYPTION_KEY must be a long random string (32+ characters) and
 * must never change once data is encrypted, or existing secrets become unreadable.
 * Stored format: v1:<iv>:<tag>:<ciphertext> (base64 parts).
 */
let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    throw new Error('ENCRYPTION_KEY must be set to a random string of at least 32 characters');
  }
  cachedKey = crypto.createHash('sha256').update(raw).digest();
  return cachedKey;
}

function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
}

function decrypt(payload) {
  if (!payload) return null;
  const [version, iv, tag, data] = String(payload).split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unrecognised encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
