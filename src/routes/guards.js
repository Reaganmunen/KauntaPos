'use strict';

/**
 * Small route-level helpers shared by the route files.
 */
const { Role } = require('../models');
const { requireFeature } = require('../middleware');
const { assertSaleRights } = require('../utils/saleGuards');

/** requireFeature(key), but only for requests where test(req) is true (e.g. "this sale is a table tab"). */
function requireFeatureIf(key, test) {
  const gate = requireFeature(key);
  return (req, res, next) => (test(req) ? gate(req, res, next) : next());
}

/** Rights a sale body needs beyond "may sell": discounts, prescriptions. See utils/saleGuards. */
function saleRights(req, res, next) {
  try {
    assertSaleRights(req.user, req.body);
  } catch (err) {
    return next(err);
  }
  return next();
}

/**
 * Silently drops body fields that the caller may not set (e.g. a cashier adding a customer at the
 * till can create it, but cannot give it a credit limit).
 */
function stripUnless(fields, permission) {
  return (req, res, next) => {
    const user = req.user;
    const allowed = user && (user.is_owner || Role.hasPermission(user.permissions, permission));
    if (!allowed && req.body && typeof req.body === 'object') {
      for (const field of fields) delete req.body[field];
    }
    next();
  };
}

/**
 * Registers the standard handlers from utils/crud.makeCrud:
 *   GET base · POST base · GET base/:id · PATCH base/:id · DELETE base/:id
 * `read` and `write` are lists of middleware for the read routes and the write routes.
 */
function crudRoutes(router, base, handlers, { read = [], write = [] } = {}) {
  const root = base === '/' ? '' : base.replace(/\/$/, ''); // '/' means "the router's own root"
  router.get(root || '/', ...read, handlers.list);
  router.post(root || '/', ...write, handlers.create);
  router.get(`${root}/:id`, ...read, handlers.get);
  router.patch(`${root}/:id`, ...write, handlers.update);
  router.delete(`${root}/:id`, ...write, handlers.remove);
}

module.exports = { requireFeatureIf, saleRights, stripUnless, crudRoutes };
