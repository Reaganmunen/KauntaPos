'use strict';

/**
 * Every permission key the system knows. Roles store a subset of these ('*' = everything,
 * 'group.*' = a whole group). Routes use these exact keys.
 */
const PERMISSION_GROUPS = {
  pos: ['pos.sell', 'pos.discount', 'pos.void', 'pos.refund', 'pos.shift'],
  products: ['products.view', 'products.manage'],
  inventory: ['inventory.view', 'inventory.adjust', 'inventory.transfer'],
  purchases: ['purchases.manage'],
  people: ['customers.manage', 'suppliers.manage'],
  expenses: ['expenses.manage'],
  reports: ['reports.view'],
  restaurant: ['kitchen.view'],
  pharmacy: ['pharmacy.dispense'],
  online: ['orders.online', 'storefront.manage'],
  integrations: ['mpesa.manage', 'etims.manage'],
  admin: ['users.manage', 'roles.manage', 'branches.manage', 'settings.manage', 'audit.view'],
};

const ALL_PERMISSIONS = Object.values(PERMISSION_GROUPS).flat();

function isValidPermission(p) {
  if (p === '*') return true;
  if (ALL_PERMISSIONS.includes(p)) return true;
  return p.endsWith('.*') && Object.prototype.hasOwnProperty.call(PERMISSION_GROUPS, p.slice(0, -2));
}

module.exports = { PERMISSION_GROUPS, ALL_PERMISSIONS, isValidPermission };
