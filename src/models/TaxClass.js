'use strict';

const BaseModel = require('./BaseModel');

/** eTIMS tax codes (A exempt, B 16%, C zero-rated, D non-VAT, E 8%) seeded per tenant. */
class TaxClass extends BaseModel {
  static table = 'tax_classes';
  static columns = ['code', 'name', 'rate', 'is_default'];
  static defaultOrder = 'code ASC';

  static async getDefault(db) {
    return this.findOne(db, { is_default: true });
  }

  static async findByCode(db, code) {
    return this.findOne(db, { code });
  }

  static async setDefault(db, id) {
    await db.query('UPDATE tax_classes SET is_default = false WHERE id <> $1', [id]);
    const { rows } = await db.query('UPDATE tax_classes SET is_default = true WHERE id = $1 RETURNING *', [id]);
    return rows[0] || null;
  }
}

module.exports = TaxClass;
