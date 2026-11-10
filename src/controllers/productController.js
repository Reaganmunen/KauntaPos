'use strict';

/**
 * Products and their variants (every product has at least one variant: sales and stock
 * always point at a variant). Also images, pharmacy details, POS lookup and bulk import.
 */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/respond');
const { requireFields, nonEmptyArray } = require('../utils/validate');
const { run, branchId, pageParams, toBool } = require('../utils/context');
const { audit } = require('../utils/audit');
const { assertWithinLimit, remainingQuota } = require('../utils/limits');
const {
  Product, ProductVariant, ProductImage, ProductPharma, ModifierGroup,
  TaxClass, Category, Brand, Unit,
} = require('../models');
const InventoryService = require('../services/InventoryService');

// A product created without a variants array gets one "Default" variant built from these fields.
function variantSpecsFrom(body) {
  if (Array.isArray(body.variants) && body.variants.length) return body.variants;
  return [{
    name: 'Default',
    sku: body.sku,
    barcode: body.barcode,
    cost_price: body.cost_price,
    selling_price: body.selling_price,
    wholesale_price: body.wholesale_price,
    reorder_level: body.reorder_level,
    opening_quantity: body.opening_quantity,
  }];
}

// SKU / barcode are unique per shop even for deleted variants, so free them when removing.
async function releaseVariantCodes(db, productId) {
  await db.query(
    'UPDATE product_variants SET sku = NULL, barcode = NULL, is_default = false WHERE product_id = $1',
    [productId]
  );
}

// ---------- products ----------

// GET /products?q=&category_id=&is_online=&is_active=&product_type=&sort=name:asc
exports.list = asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const result = await run(req, (db) =>
    Product.search(db, {
      q: req.query.q,
      category_id: req.query.category_id,
      is_online: toBool(req.query.is_online),
      is_active: toBool(req.query.is_active),
      product_type: req.query.product_type,
      orderBy: req.query.sort,
      page,
      limit,
    })
  );
  return paginated(res, result);
});

// GET /products/:id
exports.get = asyncHandler(async (req, res) => {
  const product = await run(req, async (db) => {
    const found = await Product.getWithVariants(db, req.params.id);
    if (!found) return null;
    return { ...found, modifier_groups: await ModifierGroup.forProduct(db, found.id) };
  });
  if (!product) throw ApiError.notFound('Product not found');
  return ok(res, product);
});

// POST /products
// { name, category_id, brand_id, unit_id, tax_class_id, product_type, track_stock, tags, attributes,
//   is_online, ..., variants: [{ name, sku, barcode, cost_price, selling_price, opening_quantity }],
//   (or sku/barcode/cost_price/selling_price/opening_quantity on the product for a single-variant item),
//   images: [{ url, alt_text }], pharma: {...}, modifier_group_ids: [] }
// Opening stock is booked to the branch given in X-Branch-Id / branch_id.
exports.create = asyncHandler(async (req, res) => {
  requireFields(req.body, ['name']);
  const body = req.body;
  const branch = branchId(req, { required: false });
  const specs = variantSpecsFrom(body);

  const product = await run(req, async (db) => {
    await assertWithinLimit(db, req.tenantId, 'products');

    const data = { ...body, created_by: req.user.id };
    if (!data.tax_class_id) {
      const defaultTax = await TaxClass.getDefault(db);
      if (defaultTax) data.tax_class_id = defaultTax.id;
    }

    const record = await Product.createWithVariants(db, data, specs);

    const images = Array.isArray(body.images) ? body.images : [];
    for (let i = 0; i < images.length; i++) {
      await ProductImage.create(db, {
        product_id: record.id,
        url: images[i].url,
        alt_text: images[i].alt_text || null,
        sort_order: i,
        is_primary: i === 0,
      });
    }
    if (body.pharma) await ProductPharma.upsert(db, record.id, body.pharma);
    if (Array.isArray(body.modifier_group_ids)) {
      await ModifierGroup.attachToProduct(db, record.id, body.modifier_group_ids);
    }

    if (branch && record.track_stock && record.product_type !== 'service') {
      for (let i = 0; i < record.variants.length; i++) {
        const qty = Number(specs[i].opening_quantity || 0);
        if (qty > 0) {
          await InventoryService.openingStock(db, req.user, {
            branch_id: branch,
            variant_id: record.variants[i].id,
            quantity: qty,
            unit_cost: record.variants[i].cost_price,
          });
        }
      }
    }

    await audit(db, req, 'product.create', 'product', record.id, { name: record.name });
    return Product.getWithVariants(db, record.id);
  });
  return created(res, product);
});

// PATCH /products/:id  (also accepts pharma: {...} and modifier_group_ids: [])
exports.update = asyncHandler(async (req, res) => {
  const product = await run(req, async (db) => {
    const existing = await Product.findById(db, req.params.id);
    if (!existing) throw ApiError.notFound('Product not found');

    const data = { ...req.body };
    delete data.created_by;
    if (data.slug) data.slug = await Product.uniqueSlug(db, data.slug, { excludeId: existing.id });

    await Product.update(db, existing.id, data);
    if (req.body.pharma) await ProductPharma.upsert(db, existing.id, req.body.pharma);
    if (Array.isArray(req.body.modifier_group_ids)) {
      await ModifierGroup.attachToProduct(db, existing.id, req.body.modifier_group_ids);
    }
    await audit(db, req, 'product.update', 'product', existing.id, { after: req.body });
    return Product.getWithVariants(db, existing.id);
  });
  return ok(res, product);
});

// DELETE /products/:id  (soft delete; sales history keeps its snapshots)
exports.remove = asyncHandler(async (req, res) => {
  await run(req, async (db) => {
    await releaseVariantCodes(db, req.params.id);
    const record = await Product.remove(db, req.params.id);
    if (!record) throw ApiError.notFound('Product not found');
    await audit(db, req, 'product.delete', 'product', record.id, { name: record.name });
  });
  return ok(res, { deleted: true });
});

// ---------- variants ----------

// GET /products/:id/variants
exports.listVariants = asyncHandler(async (req, res) => {
  const rows = await run(req, (db) => ProductVariant.forProduct(db, req.params.id));
  return ok(res, rows);
});

// POST /products/:id/variants  { name, sku, barcode, option_values, cost_price, selling_price, ... }
exports.createVariant = asyncHandler(async (req, res) => {
  requireFields(req.body, ['name']);
  const variant = await run(req, async (db) => {
    const product = await Product.findById(db, req.params.id);
    if (!product) throw ApiError.notFound('Product not found');

    const record = await ProductVariant.create(db, {
      ...req.body,
      product_id: product.id,
      is_default: false,
    });
    if (!product.has_variants) await Product.update(db, product.id, { has_variants: true });

    const qty = Number(req.body.opening_quantity || 0);
    const branch = branchId(req, { required: false });
    if (qty > 0 && branch && product.track_stock) {
      await InventoryService.openingStock(db, req.user, {
        branch_id: branch,
        variant_id: record.id,
        quantity: qty,
        unit_cost: record.cost_price,
      });
    }
    await audit(db, req, 'variant.create', 'product_variant', record.id, { product_id: product.id });
    return record;
  });
  return created(res, variant);
});

// PATCH /products/:id/variants/:variantId
exports.updateVariant = asyncHandler(async (req, res) => {
  const variant = await run(req, async (db) => {
    const existing = await ProductVariant.findById(db, req.params.variantId);
    if (!existing || existing.product_id !== req.params.id) throw ApiError.notFound('Variant not found');

    const { product_id, is_default, ...data } = req.body; // moving or re-defaulting has its own endpoint
    const record = await ProductVariant.update(db, existing.id, data);
    await audit(db, req, 'variant.update', 'product_variant', existing.id, { after: data });
    return record;
  });
  return ok(res, variant);
});

// POST /products/:id/variants/:variantId/default
exports.setDefaultVariant = asyncHandler(async (req, res) => {
  const variant = await run(req, async (db) => {
    const existing = await ProductVariant.findById(db, req.params.variantId);
    if (!existing || existing.product_id !== req.params.id) throw ApiError.notFound('Variant not found');
    // the unique index allows one default per product, so clear the old one first
    await db.query('UPDATE product_variants SET is_default = false WHERE product_id = $1 AND is_default', [
      existing.product_id,
    ]);
    return ProductVariant.update(db, existing.id, { is_default: true });
  });
  return ok(res, variant);
});

// DELETE /products/:id/variants/:variantId
exports.removeVariant = asyncHandler(async (req, res) => {
  await run(req, async (db) => {
    const variants = await ProductVariant.forProduct(db, req.params.id);
    const target = variants.find((v) => v.id === req.params.variantId);
    if (!target) throw ApiError.notFound('Variant not found');
    if (variants.length <= 1) {
      throw ApiError.unprocessable('A product needs at least one variant. Delete the product instead.');
    }

    // free the SKU/barcode and the "default" slot, then soft delete
    await ProductVariant.update(db, target.id, { sku: null, barcode: null, is_default: false });
    await ProductVariant.remove(db, target.id);

    if (target.is_default) {
      const next = variants.find((v) => v.id !== target.id);
      await ProductVariant.update(db, next.id, { is_default: true });
    }
    if (variants.length - 1 <= 1) await Product.update(db, req.params.id, { has_variants: false });
    await audit(db, req, 'variant.delete', 'product_variant', target.id, { product_id: req.params.id });
  });
  return ok(res, { deleted: true });
});

// ---------- images ----------

// POST /products/:id/images  { url, alt_text, variant_id, is_primary }
exports.addImage = asyncHandler(async (req, res) => {
  requireFields(req.body, ['url']);
  const image = await run(req, async (db) => {
    const product = await Product.findById(db, req.params.id);
    if (!product) throw ApiError.notFound('Product not found');
    const existing = await ProductImage.forProduct(db, product.id);
    const record = await ProductImage.create(db, {
      product_id: product.id,
      variant_id: req.body.variant_id || null,
      url: req.body.url,
      alt_text: req.body.alt_text || null,
      sort_order: existing.length,
      is_primary: existing.length === 0,
    });
    if (req.body.is_primary && existing.length) await ProductImage.setPrimary(db, product.id, record.id);
    return record;
  });
  return created(res, image);
});

// POST /products/:id/images/:imageId/primary
exports.setPrimaryImage = asyncHandler(async (req, res) => {
  const image = await run(req, (db) => ProductImage.setPrimary(db, req.params.id, req.params.imageId));
  if (!image) throw ApiError.notFound('Image not found');
  return ok(res, image);
});

// DELETE /products/:id/images/:imageId
exports.removeImage = asyncHandler(async (req, res) => {
  await run(req, async (db) => {
    const image = await ProductImage.findById(db, req.params.imageId);
    if (!image || image.product_id !== req.params.id) throw ApiError.notFound('Image not found');
    await ProductImage.remove(db, image.id);
  });
  return ok(res, { deleted: true });
});

// ---------- POS lookups ----------

// GET /products/pos/search?q=...   scan a barcode or type a name/SKU; stock shown for the branch
exports.posSearch = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) throw ApiError.badRequest('q is required');
  const branch = branchId(req);
  const rows = await run(req, (db) =>
    ProductVariant.posSearch(db, q, branch, { limit: Math.min(parseInt(req.query.limit, 10) || 30, 100) })
  );
  return ok(res, rows);
});

// GET /products/low-stock
exports.lowStock = asyncHandler(async (req, res) => {
  const branch = branchId(req);
  const rows = await run(req, (db) => ProductVariant.lowStock(db, branch));
  return ok(res, rows);
});

// ---------- bulk import ----------

async function resolveCached(cache, key, finder) {
  const k = String(key).trim().toLowerCase();
  if (!cache.has(k)) cache.set(k, await finder(String(key).trim()));
  return cache.get(k);
}

// POST /products/import
// { rows: [{ name, sku, barcode, category, brand, unit, tax_code, cost_price, selling_price,
//            opening_quantity, track_stock, reorder_level }] }   (max 1000 rows)
// Each row is imported on its own savepoint, so one bad row does not undo the others.
exports.bulkImport = asyncHandler(async (req, res) => {
  const rows = nonEmptyArray(req.body.rows, 'rows');
  if (rows.length > 1000) throw ApiError.unprocessable('Import at most 1000 rows at a time');
  const branch = branchId(req, { required: false });

  const summary = await run(req, async (db) => {
    const quota = await remainingQuota(db, req.tenantId, 'products');
    if (quota < rows.length) {
      throw ApiError.forbidden(`Your plan allows ${quota} more product(s); this file has ${rows.length}.`);
    }

    const defaultTax = await TaxClass.getDefault(db);
    const caches = { category: new Map(), brand: new Map(), unit: new Map(), tax: new Map() };
    const errors = [];
    let imported = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      await db.query('SAVEPOINT import_row');
      try {
        if (!row.name) throw new Error('name is required');

        const category = row.category
          ? await resolveCached(caches.category, row.category, async (name) =>
              (await Category.findOne(db, { name })) || Category.createWithSlug(db, { name }))
          : null;
        const brand = row.brand
          ? await resolveCached(caches.brand, row.brand, (name) => Brand.findOrCreateByName(db, name))
          : null;
        const unit = row.unit
          ? await resolveCached(caches.unit, row.unit, (abbr) => Unit.findByAbbreviation(db, abbr))
          : null;
        const tax = row.tax_code
          ? await resolveCached(caches.tax, row.tax_code, (code) => TaxClass.findByCode(db, code.toUpperCase()))
          : defaultTax;
        if (row.tax_code && !tax) throw new Error(`unknown tax code "${row.tax_code}"`);

        const product = await Product.createWithVariants(
          db,
          {
            name: row.name,
            category_id: category ? category.id : null,
            brand_id: brand ? brand.id : null,
            unit_id: unit ? unit.id : null,
            tax_class_id: tax ? tax.id : null,
            track_stock: row.track_stock === undefined ? true : toBool(row.track_stock) !== false,
            created_by: req.user.id,
          },
          [{
            name: 'Default',
            sku: row.sku || null,
            barcode: row.barcode || null,
            cost_price: row.cost_price || 0,
            selling_price: row.selling_price || 0,
            reorder_level: row.reorder_level || 0,
          }]
        );

        const qty = Number(row.opening_quantity || 0);
        if (qty > 0 && branch && product.track_stock) {
          await InventoryService.openingStock(db, req.user, {
            branch_id: branch,
            variant_id: product.variants[0].id,
            quantity: qty,
            unit_cost: product.variants[0].cost_price,
          });
        }
        await db.query('RELEASE SAVEPOINT import_row');
        imported += 1;
      } catch (err) {
        await db.query('ROLLBACK TO SAVEPOINT import_row');
        errors.push({ row: i + 1, name: row.name || null, error: err.message });
      }
    }

    await audit(db, req, 'product.import', 'product', null, { imported, failed: errors.length });
    return { imported, failed: errors.length, errors };
  });
  return ok(res, summary);
});
