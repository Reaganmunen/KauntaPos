'use strict';

const ApiError = require('./ApiError');
const { Role } = require('../models');

const DISCOUNT_KEYS = ['discount', 'discount_amount', 'discount_percent', 'discount_rate'];

const mayDo = (user, key) => Boolean(user) && (user.is_owner || Role.hasPermission(user.permissions, key));

function hasDiscount(obj) {
  return Boolean(obj) && DISCOUNT_KEYS.some((key) => Number(obj[key]) > 0);
}

/**
 * Rights a sale body needs beyond "may sell". Controllers only validate shape, so without this a
 * plain cashier could send a discount or a prescription sale straight to the API.
 *   - any discount (whole sale or a line)  -> pos.discount
 *   - a prescription block                 -> pharmacy.dispense
 * Throws a 403 ApiError listing what is missing. Owners pass everything.
 */
function assertSaleRights(user, sale) {
  const missing = [];
  const items = Array.isArray(sale && sale.items) ? sale.items : [];
  if ((hasDiscount(sale) || items.some(hasDiscount)) && !mayDo(user, 'pos.discount')) missing.push('pos.discount');
  if (sale && sale.prescription && !mayDo(user, 'pharmacy.dispense')) missing.push('pharmacy.dispense');
  if (missing.length) {
    throw ApiError.forbidden(`You do not have permission to do that (${missing.join(', ')})`, { missing });
  }
}

module.exports = { assertSaleRights, hasDiscount };
