'use strict';

const BaseModel = require('./BaseModel');
const { withTransaction } = require('../config/database');

const MAX_ATTEMPTS = 8;

/**
 * KRA eTIMS submission queue + audit trail. The sale is saved first; a row here is created in
 * the same transaction and a background worker submits it to Digitax with retries.
 *   pending -> submitting -> submitted
 *                         -> failed   (retryable, next_attempt_at set with backoff)
 *                         -> rejected (needs a human fix: bad data, missing PIN, ...)
 *   skipped = tenant has no active eTIMS config
 */
class EtimsInvoice extends BaseModel {
  static table = 'etims_invoices';
  static columns = [
    'sale_id', 'invoice_type', 'status', 'attempts', 'next_attempt_at', 'last_error',
    'request_payload', 'response_payload', 'provider_reference', 'kra_invoice_no',
    'cu_serial_no', 'cu_invoice_no', 'receipt_signature', 'qr_code_data', 'submitted_at',
  ];
  static jsonColumns = ['request_payload', 'response_payload'];

  /** Queue a sale for submission (inside the sale transaction). One row per sale. */
  static async enqueue(db, { sale_id, invoice_type = 'sale', skip = false }) {
    const { rows } = await db.query(
      `INSERT INTO etims_invoices (tenant_id, sale_id, invoice_type, status)
       VALUES (current_tenant_id(), $1, $2, $3)
       ON CONFLICT (sale_id) DO NOTHING
       RETURNING *`,
      [sale_id, invoice_type, skip ? 'skipped' : 'pending']
    );
    return rows[0] || this.findBySale(db, sale_id);
  }

  static async findBySale(db, saleId) {
    return this.findOne(db, { sale_id: saleId });
  }

  /**
   * Worker step 1: claim due jobs across ALL tenants (no tenant context needed).
   * Returns [{ id, tenant_id }]; then process each with withTenant(tenant_id).
   */
  static async claimDue(limit = 20) {
    return withTransaction(async (db) => {
      const { rows } = await db.query('SELECT * FROM claim_etims_jobs($1)', [limit]);
      return rows;
    });
  }

  static async markSubmitted(db, id, result) {
    const { rows } = await db.query(
      `UPDATE etims_invoices
          SET status = 'submitted', last_error = NULL, submitted_at = now(),
              request_payload = COALESCE($2::jsonb, request_payload),
              response_payload = $3::jsonb,
              provider_reference = $4, kra_invoice_no = $5, cu_serial_no = $6,
              cu_invoice_no = $7, receipt_signature = $8, qr_code_data = $9
        WHERE id = $1
        RETURNING *`,
      [
        id,
        result.request_payload ? JSON.stringify(result.request_payload) : null,
        result.response_payload ? JSON.stringify(result.response_payload) : null,
        result.provider_reference || null, result.kra_invoice_no || null, result.cu_serial_no || null,
        result.cu_invoice_no || null, result.receipt_signature || null, result.qr_code_data || null,
      ]
    );
    return rows[0] || null;
  }

  /** Temporary failure (network, 5xx): retry with exponential backoff; after MAX_ATTEMPTS needs attention. */
  static async markFailed(db, id, error, { request_payload, response_payload } = {}) {
    const current = await this.findById(db, id);
    const attempts = current ? current.attempts : 1;
    const exhausted = attempts >= MAX_ATTEMPTS;
    const delayMinutes = Math.min(2 ** attempts, 360);   // 2, 4, 8 ... capped at 6 hours

    const { rows } = await db.query(
      `UPDATE etims_invoices
          SET status = $2, last_error = $3,
              next_attempt_at = now() + ($4::int * interval '1 minute'),
              request_payload = COALESCE($5::jsonb, request_payload),
              response_payload = COALESCE($6::jsonb, response_payload)
        WHERE id = $1
        RETURNING *`,
      [
        id,
        exhausted ? 'rejected' : 'failed',
        String(error).slice(0, 2000),
        delayMinutes,
        request_payload ? JSON.stringify(request_payload) : null,
        response_payload ? JSON.stringify(response_payload) : null,
      ]
    );
    return rows[0] || null;
  }

  /** Permanent failure: KRA/Digitax rejected the data. A person must fix it, then retry(). */
  static async markRejected(db, id, error, { request_payload, response_payload } = {}) {
    const { rows } = await db.query(
      `UPDATE etims_invoices
          SET status = 'rejected', last_error = $2,
              request_payload = COALESCE($3::jsonb, request_payload),
              response_payload = COALESCE($4::jsonb, response_payload)
        WHERE id = $1
        RETURNING *`,
      [
        id,
        String(error).slice(0, 2000),
        request_payload ? JSON.stringify(request_payload) : null,
        response_payload ? JSON.stringify(response_payload) : null,
      ]
    );
    return rows[0] || null;
  }

  /** Manual retry from the dashboard (failed / rejected / skipped -> pending). */
  static async retry(db, id) {
    const { rows } = await db.query(
      `UPDATE etims_invoices
          SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
        WHERE id = $1 AND status IN ('failed', 'rejected', 'skipped')
        RETURNING *`,
      [id]
    );
    return rows[0] || null;
  }

  /** Invoice + sale + lines + customer details, everything the submit step needs. */
  static async getForSubmission(db, id) {
    const { rows } = await db.query(
      `SELECT e.*, s.sale_number, s.sale_type, s.original_sale_id, s.refund_reason, s.customer_name,
              s.customer_kra_pin, s.customer_phone, s.total, s.subtotal, s.discount_total, s.tax_total,
              s.prices_include_tax, s.sold_at, s.branch_id, b.etims_branch_id,
              orig.sale_number AS original_sale_number,
              orig_e.kra_invoice_no AS original_kra_invoice_no
         FROM etims_invoices e
         JOIN sales s ON s.id = e.sale_id
         JOIN branches b ON b.id = s.branch_id
         LEFT JOIN sales orig ON orig.id = s.original_sale_id
         LEFT JOIN etims_invoices orig_e ON orig_e.sale_id = s.original_sale_id
        WHERE e.id = $1`,
      [id]
    );
    if (!rows[0]) return null;

    const items = await db.query(
      'SELECT * FROM sale_items WHERE sale_id = $1 ORDER BY line_no',
      [rows[0].sale_id]
    );
    return { ...rows[0], items: items.rows };
  }

  static async search(db, { status, from, to, page = 1, limit = 25 } = {}) {
    const where = [];
    const values = [];
    const add = (sql, v) => {
      values.push(v);
      where.push(sql.replace('?', `$${values.length}`));
    };
    if (status) add('e.status = ?', status);
    if (from) add('e.created_at >= ?::timestamptz', from);
    if (to) add('e.created_at < ?::timestamptz', to);

    return this.runPaged(db, {
      select: 'e.*, s.sale_number, s.total, s.sold_at',
      from: 'etims_invoices e JOIN sales s ON s.id = e.sale_id',
      where,
      values,
      order: 'e.created_at DESC',
      page,
      limit,
    });
  }

  static async statusCounts(db) {
    const { rows } = await db.query(
      'SELECT status, COUNT(*)::int AS count FROM etims_invoices GROUP BY status'
    );
    return rows.reduce((acc, r) => {
      acc[r.status] = r.count;
      return acc;
    }, {});
  }
}

EtimsInvoice.MAX_ATTEMPTS = MAX_ATTEMPTS;

module.exports = EtimsInvoice;
