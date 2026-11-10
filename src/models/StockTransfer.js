'use strict';

const BaseModel = require('./BaseModel');
const DocumentSequence = require('./DocumentSequence');

/**
 * Branch-to-branch transfers (items live in stock_transfer_items).
 * This model tracks documents and status only; the service records the stock movements
 * (transfer_out when sent, transfer_in when received).
 */
class StockTransfer extends BaseModel {
  static table = 'stock_transfers';
  static columns = [
    'transfer_number', 'from_branch_id', 'to_branch_id', 'status', 'notes',
    'created_by', 'sent_at', 'received_at', 'received_by',
  ];

  static async createWithItems(db, data, items = []) {
    if (!items.length) throw new Error('A transfer needs at least one item');
    const transfer_number = data.transfer_number || (await DocumentSequence.next(db, 'transfer', 'all', 'TRF-'));
    const transfer = await this.create(db, { ...data, transfer_number, status: 'draft' });
    transfer.items = await this.addItems(db, transfer.id, items);
    return transfer;
  }

  static async addItems(db, transferId, items) {
    const out = [];
    for (const item of items) {
      const { rows } = await db.query(
        `INSERT INTO stock_transfer_items (tenant_id, transfer_id, variant_id, batch_id, quantity_sent)
         VALUES (current_tenant_id(), $1, $2, $3, $4)
         RETURNING *`,
        [transferId, item.variant_id, item.batch_id || null, item.quantity_sent ?? item.quantity]
      );
      out.push(rows[0]);
    }
    return out;
  }

  static async getItems(db, transferId) {
    const { rows } = await db.query(
      `SELECT i.*, v.sku, v.name AS variant_name, p.name AS product_name, sb.batch_no
         FROM stock_transfer_items i
         JOIN product_variants v ON v.id = i.variant_id
         JOIN products p ON p.id = v.product_id
         LEFT JOIN stock_batches sb ON sb.id = i.batch_id
        WHERE i.transfer_id = $1
        ORDER BY p.name, v.name`,
      [transferId]
    );
    return rows;
  }

  static async getWithItems(db, id) {
    const { rows } = await db.query(
      `SELECT t.*, fb.name AS from_branch_name, tb.name AS to_branch_name
         FROM stock_transfers t
         JOIN branches fb ON fb.id = t.from_branch_id
         JOIN branches tb ON tb.id = t.to_branch_id
        WHERE t.id = $1`,
      [id]
    );
    if (!rows[0]) return null;
    return { ...rows[0], items: await this.getItems(db, id) };
  }

  static async list(db, { status, branch_id, page = 1, limit = 25 } = {}) {
    const where = [];
    const values = [];
    if (status) {
      values.push(status);
      where.push(`t.status = $${values.length}`);
    }
    if (branch_id) {
      values.push(branch_id);
      where.push(`(t.from_branch_id = $${values.length} OR t.to_branch_id = $${values.length})`);
    }
    return this.runPaged(db, {
      select: 't.*, fb.name AS from_branch_name, tb.name AS to_branch_name',
      from: `stock_transfers t
             JOIN branches fb ON fb.id = t.from_branch_id
             JOIN branches tb ON tb.id = t.to_branch_id`,
      where,
      values,
      order: 't.created_at DESC',
      page,
      limit,
    });
  }

  static async markSent(db, id) {
    const { rows } = await db.query(
      `UPDATE stock_transfers SET status = 'in_transit', sent_at = now()
        WHERE id = $1 AND status = 'draft' RETURNING *`,
      [id]
    );
    return rows[0] || null;
  }

  static async setItemReceived(db, itemId, quantityReceived) {
    const { rows } = await db.query(
      'UPDATE stock_transfer_items SET quantity_received = $2 WHERE id = $1 RETURNING *',
      [itemId, quantityReceived]
    );
    return rows[0] || null;
  }

  static async markReceived(db, id, userId) {
    const { rows } = await db.query(
      `UPDATE stock_transfers SET status = 'received', received_at = now(), received_by = $2
        WHERE id = $1 AND status = 'in_transit' RETURNING *`,
      [id, userId]
    );
    return rows[0] || null;
  }

  static async cancel(db, id) {
    const { rows } = await db.query(
      `UPDATE stock_transfers SET status = 'cancelled'
        WHERE id = $1 AND status IN ('draft', 'in_transit') RETURNING *`,
      [id]
    );
    return rows[0] || null;
  }
}

module.exports = StockTransfer;
