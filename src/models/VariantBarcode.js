'use strict';

const BaseModel = require('./BaseModel');
const ApiError = require('../utils/ApiError');

/**
 * Extra barcodes that sell one variant: { barcode, label, pack_quantity }.
 * The variant's own barcode stays on product_variants.barcode; a code may live in only one of the two places,
 * and in only one variant, so a scan always means one thing.
 */
class VariantBarcode extends BaseModel {
  static table = 'variant_barcodes';
  static columns = ['variant_id', 'barcode', 'label', 'pack_quantity'];
  static defaultOrder = 'pack_quantity ASC, created_at ASC';

  static async forVariants(db, variantIds) {
    if (!variantIds.length) return new Map();
    const { rows } = await db.query(
      `SELECT id, variant_id, barcode, label, pack_quantity
         FROM variant_barcodes WHERE variant_id = ANY($1::uuid[])
        ORDER BY pack_quantity ASC, created_at ASC`,
      [variantIds]
    );
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.variant_id)) map.set(r.variant_id, []);
      map.get(r.variant_id).push(r);
    }
    return map;
  }

  /** Throws 409 when `barcode` already belongs to another variant (as its main code or as an extra). */
  static async assertFree(db, barcode, { exceptVariantId = null } = {}) {
    if (!barcode) return;
    const { rows } = await db.query(
      `SELECT p.name AS product_name, v.name AS variant_name
         FROM product_variants v JOIN products p ON p.id = v.product_id
        WHERE v.barcode = $1 AND v.deleted_at IS NULL AND ($2::uuid IS NULL OR v.id <> $2)
        UNION ALL
       SELECT p.name, v.name
         FROM variant_barcodes b
         JOIN product_variants v ON v.id = b.variant_id
         JOIN products p ON p.id = v.product_id
        WHERE b.barcode = $1 AND v.deleted_at IS NULL AND ($2::uuid IS NULL OR v.id <> $2)
        LIMIT 1`,
      [String(barcode), exceptVariantId]
    );
    if (rows[0]) {
      const v = rows[0].variant_name && rows[0].variant_name !== 'Default' ? ` (${rows[0].variant_name})` : '';
      throw ApiError.conflict(`The barcode ${barcode} already belongs to ${rows[0].product_name}${v}`, { barcode }, 'duplicate_barcode');
    }
  }

  /** Cleans the list a request sent. Throws 422 for anything that is not a usable barcode. */
  static clean(list, ownBarcode) {
    if (!Array.isArray(list)) throw ApiError.unprocessable('extra_barcodes must be a list');
    if (list.length > 12) throw ApiError.unprocessable('A variant can have up to 12 extra barcodes');
    const seen = new Set(ownBarcode ? [String(ownBarcode)] : []);
    return list.map((raw) => {
      const barcode = String((raw && raw.barcode) == null ? '' : raw.barcode).trim();
      if (barcode.length < 4 || barcode.length > 32 || /\s/.test(barcode)) {
        throw ApiError.unprocessable('A barcode is 4 to 32 characters with no spaces', { barcode });
      }
      if (seen.has(barcode)) throw ApiError.unprocessable(`The barcode ${barcode} is listed twice`, { barcode });
      seen.add(barcode);
      const pack = Number(raw.pack_quantity == null || raw.pack_quantity === '' ? 1 : raw.pack_quantity);
      if (!Number.isFinite(pack) || pack <= 0 || pack > 100000) {
        throw ApiError.unprocessable(`Units in the pack for ${barcode} must be more than 0`, { barcode });
      }
      const label = String(raw.label || '').trim().slice(0, 30) || (pack === 1 ? 'Single' : 'Pack');
      return { barcode, label, pack_quantity: Math.round(pack * 1000) / 1000 };
    });
  }

  /** Makes the variant's extra barcodes exactly `list`. Returns the saved rows. */
  static async replaceFor(db, variantId, list, ownBarcode) {
    const cleaned = this.clean(list, ownBarcode);
    for (const c of cleaned) await this.assertFree(db, c.barcode, { exceptVariantId: variantId });
    await db.query('DELETE FROM variant_barcodes WHERE variant_id = $1', [variantId]);
    const saved = [];
    for (const c of cleaned) saved.push(await this.create(db, { variant_id: variantId, ...c }));
    // the till downloads variants that changed since it last synced, so touch the variant
    await db.query('UPDATE product_variants SET updated_at = now() WHERE id = $1', [variantId]);
    return saved;
  }

  static async removeForVariants(db, variantIds) {
    if (variantIds.length) await db.query('DELETE FROM variant_barcodes WHERE variant_id = ANY($1::uuid[])', [variantIds]);
  }
}

module.exports = VariantBarcode;
