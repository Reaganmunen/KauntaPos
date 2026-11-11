'use strict';

const { AuditLog } = require('../models');

/**
 * Writes an audit entry inside the request's transaction.
 * Deliberately NOT wrapped in try/catch: a failed statement aborts the Postgres transaction,
 * and swallowing the error would let the request look successful while everything rolls back.
 */
async function audit(db, req, action, entityType, entityId, changes) {
  return AuditLog.record(db, {
    user_id: (req.user && req.user.id) || null,
    action,
    entity_type: entityType || null,
    entity_id: entityId || null,
    changes: changes === undefined ? null : changes,
    ip: req.ip || null,
    user_agent: req.get('user-agent') || null,
  });
}

module.exports = { audit };
