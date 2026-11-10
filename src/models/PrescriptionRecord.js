'use strict';

const BaseModel = require('./BaseModel');

/** Pharmacy: who a prescription medicine was dispensed to, on whose prescription. */
class PrescriptionRecord extends BaseModel {
  static table = 'prescription_records';
  static columns = [
    'sale_id', 'sale_item_id', 'variant_id', 'quantity', 'patient_name', 'patient_id_no',
    'prescriber_name', 'prescriber_reg_no', 'prescription_ref', 'dispensed_by', 'dispensed_at',
  ];
  static defaultOrder = 'dispensed_at DESC';

  static async forSale(db, saleId) {
    return this.findAll(db, { filters: { sale_id: saleId } });
  }

  /** Dispensing register for audits (e.g. controlled drugs). */
  static async register(db, { from, to, drug_schedule, page = 1, limit = 50 } = {}) {
    const where = [];
    const values = [];
    const add = (sql, v) => {
      values.push(v);
      where.push(sql.replace('?', `$${values.length}`));
    };
    if (from) add('r.dispensed_at >= ?::timestamptz', from);
    if (to) add('r.dispensed_at < ?::timestamptz', to);
    if (drug_schedule) add('pp.drug_schedule = ?', drug_schedule);

    return this.runPaged(db, {
      select: `r.*, p.name AS product_name, v.name AS variant_name, s.sale_number,
               pp.drug_schedule, u.full_name AS dispensed_by_name`,
      from: `prescription_records r
             JOIN product_variants v ON v.id = r.variant_id
             JOIN products p ON p.id = v.product_id
             LEFT JOIN product_pharma pp ON pp.product_id = p.id
             JOIN sales s ON s.id = r.sale_id
             LEFT JOIN users u ON u.id = r.dispensed_by`,
      where,
      values,
      order: 'r.dispensed_at DESC',
      page,
      limit,
    });
  }
}

module.exports = PrescriptionRecord;
