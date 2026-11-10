'use strict';

const ApiError = require('../utils/ApiError');
const { Role } = require('../models');

const has = (user, key) => user.is_owner || Role.hasPermission(user.permissions, key);

/**
 * can('products.manage')                 needs that permission
 * can('pos.sell', 'pos.discount')        needs ALL of them
 * Use after authenticate. Permission keys live in utils/permissions.js.
 */
function can(...keys) {
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    const missing = keys.filter((k) => !has(req.user, k));
    if (missing.length) {
      return next(ApiError.forbidden(`You do not have permission to do that (${missing.join(', ')})`, { missing }));
    }
    return next();
  };
}

/** canAny('pos.sell', 'orders.online')    needs AT LEAST ONE of them */
function canAny(...keys) {
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (keys.some((k) => has(req.user, k))) return next();
    return next(ApiError.forbidden(`You do not have permission to do that (${keys.join(' or ')})`, { missing: keys }));
  };
}

/**
 * requireFeature('restaurant')   the module must be switched on for this shop.
 * Gives a clear 403 with code 'feature_disabled' so the app can offer to enable it.
 */
function requireFeature(key) {
  return (req, res, next) => {
    const features = (req.tenantCtx && req.tenantCtx.features) || {};
    if (features[key] === true) return next();
    return next(ApiError.forbidden(`The ${key.replace(/_/g, ' ')} module is not enabled for your shop`, { feature: key }, 'feature_disabled'));
  };
}

module.exports = { can, canAny, requireFeature };
