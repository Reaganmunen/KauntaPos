'use strict';

const BaseModel = require('./BaseModel');

class Expense extends BaseModel {
  static table = 'expenses';
  static columns = [
    'branch_id', 'category_id', 'supplier_id', 'amount', 'expense_date', 'payment_method',
    'reference', 'supplier_etims_invoice_no', 'description', 'receipt_url', 'created_by',
  ];
  static defaultOrder = 'expense_date DESC, created_at DESC';

  static async search(db, { branch_id, category_id, from, to, q, page = 1, limit = 25 } = {}) {
    const where = [];
    const values = [];
    const add = (sql, v) => {
      values.push(v);
      where.push(sql.replace('?', `$${values.length}`));
    };
    if (branch_id) add('e.branch_id = ?', branch_id);
    if (category_id) add('e.category_id = ?', category_id);
    if (from) add('e.expense_date >= ?::date', from);
    if (to) add('e.expense_date <= ?::date', to);
    if (q) {
      values.push(this.like(q));
      where.push(`(e.description ILIKE $${values.length} OR e.reference ILIKE $${values.length})`);
    }

    return this.runPaged(db, {
      select: 'e.*, c.name AS category_name, s.name AS supplier_name',
      from: `expenses e
             LEFT JOIN expense_categories c ON c.id = e.category_id
             LEFT JOIN suppliers s ON s.id = e.supplier_id`,
      where,
      values,
      order: 'e.expense_date DESC, e.created_at DESC',
      page,
      limit,
    });
  }

  static async summaryByCategory(db, { from, to, branch_id } = {}) {
    const values = [from, to];
    let branchClause = '';
    if (branch_id) {
      values.push(branch_id);
      branchClause = `AND e.branch_id = $${values.length}`;
    }
    const { rows } = await db.query(
      `SELECT COALESCE(c.name, 'Uncategorised') AS category, SUM(e.amount) AS total, COUNT(*)::int AS count
         FROM expenses e
         LEFT JOIN expense_categories c ON c.id = e.category_id
        WHERE e.expense_date >= $1::date AND e.expense_date <= $2::date ${branchClause}
        GROUP BY 1
        ORDER BY total DESC`,
      values
    );
    return rows;
  }
}

module.exports = Expense;
