'use strict';

const asyncHandler = require('./asyncHandler');
const ApiError = require('./ApiError');
const { ok, created, paginated } = require('./respond');
const { run, pageParams, toBool } = require('./context');
const { audit } = require('./audit');

/**
 * Standard list / get / create / update / remove handlers for simple lookup models.
 *   ?all=true  -> every row, no paging (for dropdowns)
 *   ?sort=name:desc
 * Options: label (for messages), beforeCreate(db, req, data), beforeUpdate(db, req, data).
 * Do not use for models that hold secrets (their audit entries store the request body).
 */
function makeCrud(Model, { label = 'Record', beforeCreate, beforeUpdate } = {}) {
  const entity = label.toLowerCase().replace(/\s+/g, '_');

  return {
    list: asyncHandler(async (req, res) => {
      if (toBool(req.query.all)) {
        const rows = await run(req, (db) => Model.findAll(db, { orderBy: req.query.sort }));
        return ok(res, rows);
      }
      const { page, limit } = pageParams(req);
      const result = await run(req, (db) => Model.paginate(db, { page, limit, orderBy: req.query.sort }));
      return paginated(res, result);
    }),

    get: asyncHandler(async (req, res) => {
      const row = await run(req, (db) => Model.findById(db, req.params.id));
      if (!row) throw ApiError.notFound(`${label} not found`);
      return ok(res, row);
    }),

    create: asyncHandler(async (req, res) => {
      const row = await run(req, async (db) => {
        const data = beforeCreate ? await beforeCreate(db, req, { ...req.body }) : req.body;
        const record = await Model.create(db, data);
        await audit(db, req, `${entity}.create`, entity, record.id, { after: req.body });
        return record;
      });
      return created(res, row);
    }),

    update: asyncHandler(async (req, res) => {
      const row = await run(req, async (db) => {
        const data = beforeUpdate ? await beforeUpdate(db, req, { ...req.body }) : req.body;
        const record = await Model.update(db, req.params.id, data);
        if (!record) throw ApiError.notFound(`${label} not found`);
        await audit(db, req, `${entity}.update`, entity, record.id, { after: req.body });
        return record;
      });
      return ok(res, row);
    }),

    remove: asyncHandler(async (req, res) => {
      await run(req, async (db) => {
        const record = await Model.remove(db, req.params.id);
        if (!record) throw ApiError.notFound(`${label} not found`);
        await audit(db, req, `${entity}.delete`, entity, record.id, null);
      });
      return ok(res, { deleted: true });
    }),
  };
}

module.exports = { makeCrud };
