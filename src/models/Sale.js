'use strict';

const BaseModel = require('./BaseModel');
const DocumentSequence = require('./DocumentSequence');

/**
 * Sales AND credit notes (sale_type), POS AND online (channel), restaurant tabs (status 'open').
 * balance_due is a generated column and cannot be written.
 */
class Sale extends BaseModel {
  static table = 'sales';
  static columns = [
    'branch_id', 'sale_number', 'client_uuid', 'sale_type', 'original_sale_id', 'refund_reason',
    'channel', 'service_type', 'status', 'table_id', 'covers',
    'customer_id', 'customer_name', 'customer_phone', 'customer_kra_pin',
    'terminal_id', 'shift_id', 'cashier_id', 'currency', 'prices_include_tax',
    'subtotal', 'discount_total', 'tax_total', 'total', 'amount_paid', 'change_due',
    'payment_status', 'notes', 'sold_at', 'voided_at', 'voided_by', 'void_reason',
  ];
  static defaultOrder = 'sold_at DESC';

  /** Offline / retry safety: the same client_uuid always returns the sale already saved. */
  static async findByClientUuid(db, clientUuid) {
    return this.findOne(db, { client_uuid: clientUuid });
  }

  /** 'INV-000123' for sales, 'CN-000045' for credit notes. Numbering is per tenant. */
  static async nextNumber(db, saleType = 'sale') {
    return saleType === 'credit_note'
      ? DocumentSequence.next(db, 'credit_note', 'all', 'CN-')
      : DocumentSequence.next(db, 'sale', 'all', 'INV-');
  }

  /**
   * Inserts the sale header and its lines (with modifiers) together.
   * items: [{ variant_id, batch_id, product_name, variant_name, sku, quantity, unit_price,
   *           discount_amount, tax_code, tax_rate, tax_amount, line_total, unit_cost,
   *           etims_item_class_code, etims_unit_code, kitchen_status, notes,
   *           modifiers: [{ modifier_id, name, price_delta }] }]
   * Totals are computed by the service and passed in `data`.
   */
  static async createWithItems(db, data, items = []) {
    const sale_number = data.sale_number || (await this.nextNumber(db, data.sale_type));
    const sale = await this.create(db, { ...data, sale_number });
    sale.items = await this.addItems(db, sale.id, items);
    return sale;
  }

  static async addItems(db, saleId, items = [], startLine = 1) {
    const out = [];
    let lineNo = startLine;
    for (const it of items) {
      const { rows } = await db.query(
        `INSERT INTO sale_items
           (tenant_id, sale_id, line_no, variant_id, batch_id, product_name, variant_name, sku,
            quantity, unit_price, discount_amount, tax_code, tax_rate, tax_amount, line_total,
            unit_cost, etims_item_class_code, etims_unit_code, kitchen_status, sent_to_kitchen_at, notes)
         VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15, $16, $17, $18, $19, $20)
         RETURNING *`,
        [
          saleId, lineNo++, it.variant_id, it.batch_id || null, it.product_name, it.variant_name || null,
          it.sku || null, it.quantity, it.unit_price, it.discount_amount || 0, it.tax_code || null,
          it.tax_rate || 0, it.tax_amount || 0, it.line_total, it.unit_cost || 0,
          it.etims_item_class_code || null, it.etims_unit_code || null,
          it.kitchen_status || null, it.sent_to_kitchen_at || null, it.notes || null,
        ]
      );
      const row = rows[0];
      row.modifiers = [];
      for (const m of it.modifiers || []) {
        const mod = await db.query(
          `INSERT INTO sale_item_modifiers (tenant_id, sale_item_id, modifier_id, name, price_delta)
           VALUES (current_tenant_id(), $1, $2, $3, $4)
           RETURNING *`,
          [row.id, m.modifier_id || null, m.name, m.price_delta || 0]
        );
        row.modifiers.push(mod.rows[0]);
      }
      out.push(row);
    }
    return out;
  }

  static async getItems(db, saleId) {
    const { rows } = await db.query(
      `SELECT i.*,
              COALESCE((SELECT json_agg(json_build_object(
                          'id', m.id, 'modifier_id', m.modifier_id, 'name', m.name, 'price_delta', m.price_delta))
                          FROM sale_item_modifiers m WHERE m.sale_item_id = i.id), '[]'::json) AS modifiers
         FROM sale_items i
        WHERE i.sale_id = $1
        ORDER BY i.line_no`,
      [saleId]
    );
    return rows;
  }

  /** Everything needed to print a receipt or show a sale: lines, payments, eTIMS details, branch, cashier. */
  static async getFull(db, id) {
    const { rows } = await db.query(
      `SELECT s.*, b.name AS branch_name, b.phone AS branch_phone, b.address AS branch_address,
              u.full_name AS cashier_name, t.name AS table_name,
              e.status AS etims_status, e.kra_invoice_no, e.cu_serial_no, e.cu_invoice_no,
              e.receipt_signature, e.qr_code_data, e.submitted_at AS etims_submitted_at
         FROM sales s
         JOIN branches b ON b.id = s.branch_id
         LEFT JOIN users u ON u.id = s.cashier_id
         LEFT JOIN dining_tables t ON t.id = s.table_id
         LEFT JOIN etims_invoices e ON e.sale_id = s.id
        WHERE s.id = $1`,
      [id]
    );
    if (!rows[0]) return null;

    const payments = await db.query('SELECT * FROM payments WHERE sale_id = $1 ORDER BY paid_at', [id]);
    return { ...rows[0], items: await this.getItems(db, id), payments: payments.rows };
  }

  static async search(db, filters = {}) {
    const {
      q, branch_id, status, channel, sale_type, payment_status, customer_id, cashier_id,
      from, to, page = 1, limit = 25,
    } = filters;
    const where = [];
    const values = [];
    const add = (sql, v) => {
      values.push(v);
      where.push(sql.replace('?', `$${values.length}`));
    };

    if (branch_id) add('s.branch_id = ?', branch_id);
    if (status) add('s.status = ?', status);
    if (channel) add('s.channel = ?', channel);
    if (sale_type) add('s.sale_type = ?', sale_type);
    if (payment_status) add('s.payment_status = ?', payment_status);
    if (customer_id) add('s.customer_id = ?', customer_id);
    if (cashier_id) add('s.cashier_id = ?', cashier_id);
    if (from) add('s.sold_at >= ?::timestamptz', from);
    if (to) add('s.sold_at < ?::timestamptz', to);
    if (q) {
      values.push(this.like(q));
      where.push(`(s.sale_number ILIKE $${values.length} OR s.customer_name ILIKE $${values.length} OR s.customer_phone ILIKE $${values.length})`);
    }

    return this.runPaged(db, {
      select: 's.*, b.name AS branch_name, u.full_name AS cashier_name',
      from: 'sales s JOIN branches b ON b.id = s.branch_id LEFT JOIN users u ON u.id = s.cashier_id',
      where,
      values,
      order: 's.sold_at DESC',
      page,
      limit,
    });
  }

  /** Updates paid amount and status after a payment is recorded or reversed. */
  static async refreshPaymentTotals(db, saleId) {
    const { rows } = await db.query(
      `UPDATE sales s
          SET amount_paid = LEAST(p.paid, s.total),
              change_due = GREATEST(p.paid - s.total, 0),
              payment_status = CASE
                WHEN p.paid >= s.total AND s.total > 0 THEN 'paid'
                WHEN p.paid > 0 THEN 'partial'
                ELSE 'unpaid' END
         FROM (SELECT COALESCE(SUM(amount), 0) AS paid
                 FROM payments WHERE sale_id = $1 AND status = 'completed') p
        WHERE s.id = $1
        RETURNING s.*`,
      [saleId]
    );
    return rows[0] || null;
  }

  static async void(db, id, { voided_by, void_reason }) {
    const { rows } = await db.query(
      `UPDATE sales
          SET status = 'void', voided_at = now(), voided_by = $2, void_reason = $3
        WHERE id = $1 AND status <> 'void'
        RETURNING *`,
      [id, voided_by, void_reason || null]
    );
    return rows[0] || null;
  }

  /** Quantity already credited per original line (to stop over-refunding). */
  static async creditedQuantities(db, originalSaleId) {
    const { rows } = await db.query(
      `SELECT ci.variant_id, SUM(ci.quantity) AS quantity
         FROM sale_items ci
         JOIN sales cn ON cn.id = ci.sale_id
        WHERE cn.original_sale_id = $1 AND cn.sale_type = 'credit_note' AND cn.status <> 'void'
        GROUP BY ci.variant_id`,
      [originalSaleId]
    );
    return rows;
  }

  /** Open restaurant tabs for a branch (or one table). */
  static async openTabs(db, branchId, { tableId } = {}) {
    const values = [branchId];
    let tableClause = '';
    if (tableId) {
      values.push(tableId);
      tableClause = `AND s.table_id = $${values.length}`;
    }
    const { rows } = await db.query(
      `SELECT s.*, t.name AS table_name
         FROM sales s
         LEFT JOIN dining_tables t ON t.id = s.table_id
        WHERE s.branch_id = $1 AND s.status = 'open' ${tableClause}
        ORDER BY s.created_at ASC`,
      values
    );
    return rows;
  }

  /** Kitchen display: items waiting or in preparation, oldest first. */
  static async kitchenQueue(db, branchId, { station } = {}) {
    const values = [branchId];
    let stationClause = '';
    if (station) {
      values.push(station);
      stationClause = `AND p.kitchen_station = $${values.length}`;
    }
    const { rows } = await db.query(
      `SELECT i.id, i.sale_id, i.product_name, i.variant_name, i.quantity, i.notes, i.kitchen_status,
              i.sent_to_kitchen_at, s.sale_number, s.service_type, t.name AS table_name,
              COALESCE((SELECT json_agg(m.name) FROM sale_item_modifiers m WHERE m.sale_item_id = i.id), '[]'::json) AS modifiers
         FROM sale_items i
         JOIN sales s ON s.id = i.sale_id
         JOIN product_variants v ON v.id = i.variant_id
         JOIN products p ON p.id = v.product_id
         LEFT JOIN dining_tables t ON t.id = s.table_id
        WHERE s.branch_id = $1 AND s.status <> 'void'
          AND i.kitchen_status IN ('new', 'preparing', 'ready') ${stationClause}
        ORDER BY i.sent_to_kitchen_at ASC NULLS LAST, i.line_no ASC`,
      values
    );
    return rows;
  }

  static async setItemKitchenStatus(db, itemId, status) {
    const { rows } = await db.query(
      'UPDATE sale_items SET kitchen_status = $2 WHERE id = $1 RETURNING *',
      [itemId, status]
    );
    return rows[0] || null;
  }

  /** Sends all unsent 'new' lines of a tab to the kitchen. */
  static async sendToKitchen(db, saleId) {
    const { rows } = await db.query(
      `UPDATE sale_items SET sent_to_kitchen_at = now()
        WHERE sale_id = $1 AND kitchen_status = 'new' AND sent_to_kitchen_at IS NULL
        RETURNING *`,
      [saleId]
    );
    return rows;
  }

  /** Real-world payment-method breakdown for a period (credit notes negative). */
  static async paymentBreakdown(db, { from, to, branch_id } = {}) {
    const values = [from, to];
    let branchClause = '';
    if (branch_id) {
      values.push(branch_id);
      branchClause = `AND s.branch_id = $${values.length}`;
    }
    const { rows } = await db.query(
      `SELECT p.method,
              SUM(CASE WHEN s.sale_type = 'credit_note' THEN -p.amount ELSE p.amount END) AS total,
              COUNT(*)::int AS count
         FROM payments p
         JOIN sales s ON s.id = p.sale_id
        WHERE p.status = 'completed' AND s.status <> 'void'
          AND p.paid_at >= $1::timestamptz AND p.paid_at < $2::timestamptz ${branchClause}
        GROUP BY p.method
        ORDER BY total DESC`,
      values
    );
    return rows;
  }
}

module.exports = Sale;
