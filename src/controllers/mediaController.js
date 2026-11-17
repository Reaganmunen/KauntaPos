'use strict';

/**
 * Product photos kept in Postgres (table `media`, see sql/media.sql).
 *
 *   POST /media        (any signed-in staff)   { data: "data:image/jpeg;base64,..." }
 *                      -> { id, url: "/api/media/<id>" }; use that url for a product image, a profile picture or the shop logo
 *   GET  /media/:id    public: <img> tags cannot send a login. The id is a random uuid, and the read
 *                      goes through get_media(), which returns that one photo and nothing else.
 *
 * The browser shrinks each photo to a small JPEG before sending (see js/step-products.js), so the
 * 400 KB cap is generous. The body parser's 1 MB limit covers the base64 text.
 */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { created } = require('../utils/respond');
const { run } = require('../utils/context');
const { query } = require('../config/database');

const MAX_BYTES = 400 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

// The bytes must really be that kind of image, not just labelled as one.
function looksLike(type, buf) {
  if (type === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (type === 'image/png') return buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/webp') return buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
  return false;
}

// POST /media
exports.upload = asyncHandler(async (req, res) => {
  const match = DATA_URL.exec(String((req.body && req.body.data) || ''));
  if (!match) throw ApiError.unprocessable('Send the photo as a JPEG, PNG or WebP data URL');
  const type = match[1];
  const buf = Buffer.from(match[2], 'base64');
  if (!buf.length || buf.length > MAX_BYTES) {
    throw ApiError.unprocessable(`That photo is too large (the limit is ${MAX_BYTES / 1024} KB after resizing)`, undefined, 'image_too_large');
  }
  if (!looksLike(type, buf)) throw ApiError.unprocessable('That file is not a valid image');

  const id = await run(req, async (db) => {
    const { rows } = await db.query(
      'INSERT INTO media (content_type, size_bytes, data) VALUES ($1, $2, $3) RETURNING id',
      [type, buf.length, buf]
    );
    return rows[0].id;
  });
  const prefix = (process.env.API_PREFIX || '/api').replace(/\/$/, '');
  return created(res, { id, url: `${prefix}/media/${id}` });
});

// GET /media/:id
exports.serve = asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!UUID_RE.test(id)) throw ApiError.notFound('Image not found');

  // A photo never changes once saved, so the id doubles as its ETag.
  const etag = `"${id}"`;
  if (req.get('if-none-match') === etag) return res.status(304).end();

  const { rows } = await query('SELECT content_type, data FROM get_media($1)', [id]);
  if (!rows[0]) throw ApiError.notFound('Image not found');

  res.set({
    'Content-Type': rows[0].content_type,
    'Content-Length': rows[0].data.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  });
  return res.end(rows[0].data);
});