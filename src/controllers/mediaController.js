'use strict';

/**
 * Serves storefront pictures stored in the database (table storefront_media).
 * Mounted in app.js at GET /media/:tenantId/:id, before the API, with no login: an <img> tag cannot send a
 * token, and shoppers have no account. The id is a random UUID, and the row is looked up inside that
 * tenant's own context, so one shop can never read another shop's pictures by guessing.
 */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { withTenant } = require('../config/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_RE = /^[A-Za-z0-9_-]{1,64}$/;

// GET /media/:tenantId/:id
exports.serve = asyncHandler(async (req, res) => {
  const { tenantId, id } = req.params;
  if (!UUID_RE.test(id) || !TENANT_RE.test(tenantId)) throw ApiError.notFound('Picture not found');

  let row;
  try {
    const result = await withTenant(tenantId, (db) =>
      db.query('SELECT mime_type, byte_size, data FROM storefront_media WHERE id = $1 AND tenant_id = $2', [id, tenantId])
    );
    row = result.rows[0];
  } catch (err) {
    if (err && err.code === '22P02') throw ApiError.notFound('Picture not found'); // tenant id is not a valid id
    throw err;
  }
  if (!row) throw ApiError.notFound('Picture not found');

  res.set({
    'Content-Type': row.mime_type,
    'Content-Length': String(row.byte_size),
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  return res.end(row.data);
});