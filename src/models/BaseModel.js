'use strict';

const { slugify } = require('../utils/slugify');

/**
 * Base class for all models.
 *
 * - Every method takes `db` as its first argument: a pg client from withTenant()
 *   (tenant data) or the pool/transaction helpers (platform data). Models never
 *   open connections themselves, so everything runs inside the caller's transaction.
 * - Tenant tables: tenant_id is filled in by the database (current_tenant_id()),
 *   and Row Level Security filters every read. You never pass tenant_id.
 * - Only whitelisted `columns` can be written; filters and sort keys are checked
 *   against whitelists, so column names are never taken raw from user input.
 */
class BaseModel {
  static table = null;
  static columns = [];            // writable columns
  static jsonColumns = [];        // jsonb columns (JS objects/arrays are JSON.stringify'd)
  static tenantScoped = true;     // table has tenant_id
  static softDelete = false;      // table has deleted_at
  static filterable = null;       // defaults to ['id', ...columns]
  static sortable = null;         // defaults to ['id', 'created_at', 'updated_at', ...columns]
  static defaultOrder = 'created_at DESC';

  // ---------- helpers ----------

  static pick(data = {}) {
    const out = {};
    for (const col of this.columns) {
      if (data[col] === undefined) continue;
      const value = data[col];
      out[col] = this.jsonColumns.includes(col) && value !== null ? JSON.stringify(value) : value;
    }
    return out;
  }

  /** Escapes % and _ for ILIKE and wraps with wildcards. */
  static like(q) {
    return `%${String(q).replace(/[\\%_]/g, '\\$&')}%`;
  }

  static buildWhere(filters = {}) {
    const allowed = new Set(this.filterable || ['id', ...this.columns]);
    const clauses = [];
    const values = [];

    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined) continue;
      if (!allowed.has(key)) {
        throw new Error(`Invalid filter "${key}" for ${this.table}`);
      }
      if (value === null) {
        clauses.push(`${key} IS NULL`);
      } else if (Array.isArray(value)) {
        values.push(value);
        clauses.push(`${key} = ANY($${values.length})`);
      } else {
        values.push(value);
        clauses.push(`${key} = $${values.length}`);
      }
    }
    if (this.softDelete) clauses.push('deleted_at IS NULL');

    return { clause: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
  }

  /** orderBy: 'name' or 'name:desc'. Unknown columns fall back to defaultOrder. */
  static resolveOrder(orderBy) {
    if (!orderBy) return this.defaultOrder;
    const [col, dir] = String(orderBy).split(':');
    const sortable = new Set(this.sortable || ['id', 'created_at', 'updated_at', ...this.columns]);
    if (!sortable.has(col)) return this.defaultOrder;
    return `${col} ${String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`;
  }

  // ---------- reads ----------

  static async findById(db, id) {
    const sql = `SELECT * FROM ${this.table} WHERE id = $1${this.softDelete ? ' AND deleted_at IS NULL' : ''}`;
    const { rows } = await db.query(sql, [id]);
    return rows[0] || null;
  }

  static async findOne(db, filters = {}) {
    const { clause, values } = this.buildWhere(filters);
    const { rows } = await db.query(`SELECT * FROM ${this.table} ${clause} LIMIT 1`, values);
    return rows[0] || null;
  }

  static async findAll(db, { filters = {}, orderBy, limit, offset } = {}) {
    const { clause, values } = this.buildWhere(filters);
    let sql = `SELECT * FROM ${this.table} ${clause} ORDER BY ${this.resolveOrder(orderBy)}`;
    if (limit) {
      values.push(limit);
      sql += ` LIMIT $${values.length}`;
    }
    if (offset) {
      values.push(offset);
      sql += ` OFFSET $${values.length}`;
    }
    const { rows } = await db.query(sql, values);
    return rows;
  }

  static async count(db, filters = {}) {
    const { clause, values } = this.buildWhere(filters);
    const { rows } = await db.query(`SELECT COUNT(*)::int AS count FROM ${this.table} ${clause}`, values);
    return rows[0].count;
  }

  static async exists(db, filters = {}) {
    const { clause, values } = this.buildWhere(filters);
    const { rows } = await db.query(`SELECT 1 FROM ${this.table} ${clause} LIMIT 1`, values);
    return rows.length > 0;
  }

  static async paginate(db, { filters = {}, orderBy, page = 1, limit = 25 } = {}) {
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const size = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 200);
    const total = await this.count(db, filters);
    const rows = await this.findAll(db, { filters, orderBy, limit: size, offset: (pageNum - 1) * size });
    return { rows, total, page: pageNum, limit: size, pages: Math.ceil(total / size) };
  }

  /**
   * Paged custom query. `where` is an array of SQL fragments using $n placeholders
   * that match `values`. `countFrom` lets a joined/grouped query count a simpler FROM.
   */
  static async runPaged(db, { select, from, where = [], values = [], groupBy = '', order, page = 1, limit = 25, countFrom }) {
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const size = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 200);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await db.query(`SELECT COUNT(*)::int AS count FROM ${countFrom || from} ${whereSql}`, values);
    const total = countRes.rows[0].count;

    const params = [...values, size, (pageNum - 1) * size];
    const { rows } = await db.query(
      `SELECT ${select} FROM ${from} ${whereSql} ${groupBy} ORDER BY ${order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      params
    );
    return { rows, total, page: pageNum, limit: size, pages: Math.ceil(total / size) };
  }

  // ---------- writes ----------

  static async create(db, data = {}) {
    const picked = this.pick(data);
    const names = Object.keys(picked);
    const values = Object.values(picked);
    const placeholders = names.map((_, i) => `$${i + 1}`);

    if (this.tenantScoped) {
      names.push('tenant_id');
      placeholders.push('current_tenant_id()');
    }

    const sql = names.length
      ? `INSERT INTO ${this.table} (${names.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`
      : `INSERT INTO ${this.table} DEFAULT VALUES RETURNING *`;
    const { rows } = await db.query(sql, values);
    return rows[0];
  }

  static async createMany(db, list = []) {
    const created = [];
    for (const item of list) {
      created.push(await this.create(db, item));
    }
    return created;
  }

  static async update(db, id, data = {}) {
    const picked = this.pick(data);
    const names = Object.keys(picked);
    if (!names.length) return this.findById(db, id);

    const sets = names.map((name, i) => `${name} = $${i + 1}`);
    const values = [...Object.values(picked), id];
    const sql = `UPDATE ${this.table} SET ${sets.join(', ')} WHERE id = $${values.length}${
      this.softDelete ? ' AND deleted_at IS NULL' : ''
    } RETURNING *`;
    const { rows } = await db.query(sql, values);
    return rows[0] || null;
  }

  /** Hard delete, or soft delete when the model has deleted_at. */
  static async remove(db, id) {
    const sql = this.softDelete
      ? `UPDATE ${this.table} SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING *`
      : `DELETE FROM ${this.table} WHERE id = $1 RETURNING *`;
    const { rows } = await db.query(sql, [id]);
    return rows[0] || null;
  }

  /** Unique slug within the tenant: 'blue-shirt', 'blue-shirt-2', ... */
  static async uniqueSlug(db, base, { excludeId = null } = {}) {
    const root = slugify(base) || 'item';
    let slug = root;
    let n = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const params = excludeId ? [slug, excludeId] : [slug];
      const { rows } = await db.query(
        `SELECT 1 FROM ${this.table} WHERE slug = $1${excludeId ? ' AND id <> $2' : ''} LIMIT 1`,
        params
      );
      if (!rows.length) return slug;
      n += 1;
      slug = `${root}-${n}`;
    }
  }
}

module.exports = BaseModel;
