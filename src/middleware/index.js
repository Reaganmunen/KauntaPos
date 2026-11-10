'use strict';

const { notFound, errorHandler } = require('./errorHandler');
const { authenticate, requireOwner, authenticatePlatform } = require('./auth');
const { can, canAny, requireFeature } = require('./permissions');
const { resolveTenant } = require('./tenant');

module.exports = {
  // request plumbing
  requestContext: require('./requestContext'),
  corsOptions: require('./security').corsOptions,
  notFound,
  errorHandler,

  // which shop?
  resolveTenant,

  // who is calling?
  authenticate,
  authenticatePlatform,
  requireOwner,

  // may they?
  can,
  canAny,
  requireFeature,
  requireActiveSubscription: require('./subscription'),
  resolveBranch: require('./branch').resolveBranch,

  // abuse protection
  rateLimit: require('./rateLimit'),
  mpesaWebhookGuard: require('./webhookGuard'),
};
