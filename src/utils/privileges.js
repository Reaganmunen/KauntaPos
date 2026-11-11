'use strict';

const { Role } = require('../models');

/**
 * Staff with "manage users" or "manage roles" must not be able to hand out (or take over) more
 * access than they hold themselves, or any manager could promote themselves to the top.
 * Owners hold everything, so they are never limited.
 */

/** Which of `wanted` the acting user does not hold. ('*' and 'group.*' are matched as written.) */
function ungrantable(actor, wanted = []) {
  if (!actor || actor.is_owner) return [];
  return wanted.filter((p) => !Role.hasPermission(actor.permissions, p));
}

module.exports = { ungrantable };
