'use strict';

const ApiError = require('./ApiError');

function requireFields(obj, fields) {
  const missing = fields.filter(
    (f) => !obj || obj[f] === undefined || obj[f] === null || obj[f] === ''
  );
  if (missing.length) {
    throw ApiError.unprocessable(`Missing required field(s): ${missing.join(', ')}`, { missing });
  }
}

function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) {
    throw ApiError.unprocessable(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function positive(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw ApiError.unprocessable(`${name} must be a number greater than 0`);
  return n;
}

function nonEmptyArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw ApiError.unprocessable(`${name} must be a non-empty array`);
  }
  return value;
}

function pick(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (obj && obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

module.exports = { requireFields, oneOf, positive, nonEmptyArray, pick };
