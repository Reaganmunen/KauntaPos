'use strict';

const BaseModel = require('./BaseModel');
const { round2 } = require('../utils/money');

/** Cashier shifts: opening float, cash in/out during the shift, count at close. */
class Shift extends BaseModel {
  static table = 'shifts';
  static columns = [
    'branch_id', 'terminal_id', 'user_id', 'status', 'opened_at', 'closed_at',
    'opening_float', 'expected_cash', 'counted_cash', 'variance', 'notes',
  ];
  static defaultOrder = 'opened_at DESC';

  static async findOpenForUser(db, userId) {
    const { rows } = await db.query(
      `SELECT * FROM shifts WHERE user_id = $1 AND status = 'open' ORDER BY opened_at DESC LIMIT 1`,
      [userId]
    );
    return rows[0] || null;
  }

  static async findOpenForTerminal(db, terminalId) {
    const { rows } = await db.query(
      `SELECT * FROM shifts WHERE terminal_id = $1 AND status = 'open' LIMIT 1`,
      [terminalId]
    );
    return rows[0] || null;
  }

  static async open(db, { branch_id, terminal_id, user_id, opening_float = 0 }) {
    return this.create(db, { branch_id, terminal_id, user_id, opening_float, status: 'open' });
  }

  static async addCashMovement(db, shiftId, { movement_type, amount, reason, created_by }) {
    const { rows } = await db.query(
      `INSERT INTO shift_cash_movements (tenant_id, shift_id, movement_type, amount, reason, created_by)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5)
       RETURNING *`,
      [shiftId, movement_type, amount, reason || null, created_by || null]
    );
    return rows[0];
  }

  static async cashMovements(db, shiftId) {
    const { rows } = await db.query(
      'SELECT * FROM shift_cash_movements WHERE shift_id = $1 ORDER BY created_at',
      [shiftId]
    );
    return rows;
  }

  /** Cash expected in the drawer: float + cash sales - cash refunds + pay-ins - pay-outs - drops. */
  static async expectedCash(db, shift) {
    const { rows } = await db.query(
      `SELECT
         COALESCE((SELECT SUM(CASE WHEN s.sale_type = 'credit_note' THEN -p.amount ELSE p.amount END)
                     FROM payments p
                     JOIN sales s ON s.id = p.sale_id
                    WHERE p.shift_id = $1 AND p.method = 'cash' AND p.status = 'completed'), 0) AS cash_sales,
         COALESCE((SELECT SUM(CASE WHEN movement_type = 'pay_in' THEN amount ELSE -amount END)
                     FROM shift_cash_movements
                    WHERE shift_id = $1), 0) AS cash_movements`,
      [shift.id]
    );
    const { cash_sales, cash_movements } = rows[0];
    return round2(Number(shift.opening_float) + Number(cash_sales) + Number(cash_movements));
  }

  /** Totals by payment method for the shift (credit notes count negative). */
  static async summary(db, shiftId) {
    const { rows } = await db.query(
      `SELECT p.method,
              SUM(CASE WHEN s.sale_type = 'credit_note' THEN -p.amount ELSE p.amount END) AS total,
              COUNT(*)::int AS count
         FROM payments p
         JOIN sales s ON s.id = p.sale_id
        WHERE p.shift_id = $1 AND p.status = 'completed'
        GROUP BY p.method
        ORDER BY p.method`,
      [shiftId]
    );
    return rows;
  }

  static async close(db, id, { counted_cash, notes }) {
    const shift = await this.findById(db, id);
    if (!shift || shift.status !== 'open') return null;

    const expected = await this.expectedCash(db, shift);
    const counted = Number(counted_cash);
    const { rows } = await db.query(
      `UPDATE shifts
          SET status = 'closed', closed_at = now(), expected_cash = $2, counted_cash = $3,
              variance = $4, notes = COALESCE($5, notes)
        WHERE id = $1 AND status = 'open'
        RETURNING *`,
      [id, expected, counted, round2(counted - expected), notes || null]
    );
    return rows[0] || null;
  }

  static async listForBranch(db, { branch_id, user_id, status, page = 1, limit = 25 } = {}) {
    const where = [];
    const values = [];
    const add = (sql, v) => {
      values.push(v);
      where.push(sql.replace('?', `$${values.length}`));
    };
    if (branch_id) add('sh.branch_id = ?', branch_id);
    if (user_id) add('sh.user_id = ?', user_id);
    if (status) add('sh.status = ?', status);

    return this.runPaged(db, {
      select: 'sh.*, u.full_name AS user_name, t.name AS terminal_name',
      from: 'shifts sh JOIN users u ON u.id = sh.user_id LEFT JOIN pos_terminals t ON t.id = sh.terminal_id',
      where,
      values,
      order: 'sh.opened_at DESC',
      page,
      limit,
    });
  }
}

module.exports = Shift;
