'use strict';

/**
 * Gap-free-ish document numbering per tenant (and optionally per branch).
 * Composite primary key, so this model does not extend BaseModel.
 * Call inside the same transaction that saves the document.
 */
class DocumentSequence {
  /** next(db, 'sale', branchId, 'INV-') -> 'INV-000123' */
  static async next(db, docType, scope = 'all', prefix = '') {
    const { rows } = await db.query('SELECT next_document_number($1, $2, $3) AS number', [
      docType,
      String(scope),
      prefix,
    ]);
    return rows[0].number;
  }

  static async list(db) {
    const { rows } = await db.query('SELECT * FROM document_sequences ORDER BY doc_type, scope_key');
    return rows;
  }

  static async setPrefix(db, docType, prefix, scope = 'all') {
    const { rows } = await db.query(
      `INSERT INTO document_sequences (tenant_id, doc_type, scope_key, prefix, next_number)
       VALUES (current_tenant_id(), $1, $2, $3, 1)
       ON CONFLICT (tenant_id, doc_type, scope_key) DO UPDATE SET prefix = EXCLUDED.prefix
       RETURNING *`,
      [docType, String(scope), prefix]
    );
    return rows[0];
  }
}

module.exports = DocumentSequence;
