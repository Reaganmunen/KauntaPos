'use strict';

/** Every success response is { success: true, data, meta? }. */
const ok = (res, data = null, meta) =>
  res.status(200).json(meta ? { success: true, data, meta } : { success: true, data });

const created = (res, data = null) => res.status(201).json({ success: true, data });

const paginated = (res, { rows, total, page, limit, pages }) =>
  res.status(200).json({ success: true, data: rows, meta: { total, page, limit, pages } });

const noContent = (res) => res.status(204).end();

module.exports = { ok, created, paginated, noContent };
