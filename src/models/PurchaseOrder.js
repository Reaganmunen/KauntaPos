'use strict';

const BaseModel = require('./BaseModel');
const DocumentSequence = require('./DocumentSequence');
const { round2 } = require('../utils/money');

class PurchaseOrder extends BaseModel {
  static table = 'purchase_orders';
  static columns = [
    'branch_id', 'supplier_id', 'po_number', 'status', 'order_date', 'expected_date',
    'supplier_invoice_no', 'subtotal', 'tax_total', 'total', 'amount_paid',
    'payment_status', 'notes', 'created_by',
  ];

  /**
   * Costs are treated as EXCLUSIVE of tax: line_total = qty * unit_cost,
   * tax = line_total * tax_rate%, total = subtotal + tax.
   * items: [{ variant_id, quantity_ordered, unit_cost, tax_rate, batch_no, expiry_date }]
   */
  static async createWithItems(db, data, items = []) {
    if (!items.length) throw new Error('A purchase order needs at least one item');

    const lines = items.map((it) => {
      const quantity = Number(it.quantity_ordered ?? it.quantity);
      const unitCost = Number(it.unit_cost);
      const taxRate = Number(it.tax_rate || 0);
      return { ...it, quantity_ordered: quantity, unit_cost: unitCost, tax_rate: taxRate, line_total: round2(quantity * unitCost) };
    });
    const subtotal = round2(lines.reduce((s, l) => s + l.line_total, 0));
    const taxTotal = round2(lines.reduce((s, l) => s + (l.line_total * l.tax_rate) / 100, 0));

    const po_number = data.po_number || (await DocumentSequence.next(db, 'po', 'all', 'PO-'));
    const po = await this.create(db, {
      ...data,
      po_number,
      subtotal,
      tax_total: taxTotal,
      total: round2(subtotal + taxTotal),
    });

    po.items = [];
    for (const l of lines) {
      const { rows } = await db.query(
        `INSERT INTO purchase_order_items
           (tenant_id, purchase_order_id, variant_id, quantity_ordered, unit_cost, tax_rate, line_total, batch_no, expiry_date)
         VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [po.id, l.variant_id, l.quantity_ordered, l.unit_cost, l.tax_rate, l.line_total, l.batch_no || null, l.expiry_date || null]
      );
      po.items.push(rows[0]);
    }
    return po;
  }

  static async getItems(db, poId) {
    const { rows } = await db.query(
      `SELECT i.*, v.sku, v.name AS variant_name, p.name AS product_name
         FROM purchase_order_items i
         JOIN product_variants v ON v.id = i.variant_id
         JOIN products p ON p.id = v.product_id
        WHERE i.purchase_order_id = $1
        ORDER BY p.name, v.name`,
      [poId]
    );
    return rows;
  }

  static async getWithItems(db, id) {
    const { rows } = await db.query(
      `SELECT po.*, s.name AS supplier_name, b.name AS branch_name
         FROM purchase_orders po
         JOIN suppliers s ON s.id = po.supplier_id
         JOIN branches b ON b.id = po.branch_id
        WHERE po.id = $1`,
      [id]
    );
    if (!rows[0]) return null;
    return { ...rows[0], items: await this.getItems(db, id) };
  }

  static async list(db, { status, supplier_id, branch_id, page = 1, limit = 25 } = {}) {
    const where = [];
    const values = [];
    const add = (sql, v) => {
      values.push(v);
      where.push(sql.replace('?', `$${values.length}`));
    };
    if (status) add('po.status = ?', status);
    if (supplier_id) add('po.supplier_id = ?', supplier_id);
    if (branch_id) add('po.branch_id = ?', branch_id);

    return this.runPaged(db, {
      select: 'po.*, s.name AS supplier_name',
      from: 'purchase_orders po JOIN suppliers s ON s.id = po.supplier_id',
      where,
      values,
      order: 'po.created_at DESC',
      page,
      limit,
    });
  }

  /**
   * Books goods received against order lines and updates the order status.
   * receipts: [{ item_id, quantity }]. Returns the updated lines; the service records
   * the stock movements (and batches for pharmacy) for each received line.
   */
  static async applyReceipt(db, poId, receipts = []) {
    const updated = [];
    for (const r of receipts) {
      const { rows } = await db.query(
        `UPDATE purchase_order_items
            SET quantity_received = quantity_received + $2
          WHERE id = $1 AND purchase_order_id = $3
          RETURNING *`,
        [r.item_id, r.quantity, poId]
      );
      if (rows[0]) updated.push(rows[0]);
    }

    const { rows } = await db.query(
      `UPDATE purchase_orders po
          SET status = CASE
                WHEN EXISTS (SELECT 1 FROM purchase_order_items i
                              WHERE i.purchase_order_id = po.id AND i.quantity_received < i.quantity_ordered)
                THEN 'partially_received' ELSE 'received' END
        WHERE po.id = $1
        RETURNING *`,
      [poId]
    );
    return { order: rows[0] || null, items: updated };
  }

  static async recordPayment(db, id, amount) {
    const { rows } = await db.query(
      `UPDATE purchase_orders
          SET amount_paid = amount_paid + $2::numeric,
              payment_status = CASE
                WHEN amount_paid + $2::numeric >= total THEN 'paid'
                WHEN amount_paid + $2::numeric > 0 THEN 'partial'
                ELSE 'unpaid' END
        WHERE id = $1
        RETURNING *`,
      [id, amount]
    );
    return rows[0] || null;
  }

  static async cancel(db, id) {
    const { rows } = await db.query(
      `UPDATE purchase_orders SET status = 'cancelled'
        WHERE id = $1 AND status IN ('draft', 'ordered') RETURNING *`,
      [id]
    );
    return rows[0] || null;
  }
}

module.exports = PurchaseOrder;
