'use strict';

/** Small lookup lists: brands, units of measure, tax classes. */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/respond');
const { run } = require('../utils/context');
const { audit } = require('../utils/audit');
const { makeCrud } = require('../utils/crud');
const { Brand, Unit, TaxClass } = require('../models');

exports.brands = makeCrud(Brand, { label: 'Brand' });
exports.units = makeCrud(Unit, { label: 'Unit' });
exports.taxClasses = makeCrud(TaxClass, { label: 'Tax class' });

// POST /tax-classes/:id/default
exports.setDefaultTaxClass = asyncHandler(async (req, res) => {
  const row = await run(req, async (db) => {
    const record = await TaxClass.setDefault(db, req.params.id);
    if (!record) throw ApiError.notFound('Tax class not found');
    await audit(db, req, 'tax_class.set_default', 'tax_class', record.id, null);
    return record;
  });
  return ok(res, row);
});
