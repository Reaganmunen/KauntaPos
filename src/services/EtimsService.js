'use strict';

/**
 * KRA eTIMS through Digitax.
 *
 *  - verify()         checks the saved API key
 *  - syncItems()      registers products with KRA (an invoice line needs a registered item)
 *  - processInvoice() submits one queued invoice / credit note and stores KRA's answer
 *  - processDue()     worker step: claims due invoices across all shops and submits them
 *
 * !! Digitax's request and response shapes live in the DIGITAX block below (paths, payload builders,
 * !! response keys). They were written WITHOUT access to Digitax's API reference, so check that block
 * !! against https://ke.docs.digitax.tech/reference before going live. Nothing else in this file
 * !! depends on those shapes.
 *
 * Failure handling (EtimsInvoice states):
 *   network error, 429, 5xx          -> markFailed   (retried with backoff, then needs attention)
 *   other 4xx (bad data, bad PIN...) -> markRejected (a person fixes it, then retries)
 */
const ApiError = require('../utils/ApiError');
const { decrypt } = require('../utils/crypto');
const { withTenant } = require('../config/database');
const { TenantEtimsConfig, EtimsInvoice, ProductVariant } = require('../models');

const HTTP_TIMEOUT_MS = 20000;
const SYNC_BATCH = 200;

// =====================================================================================
// DIGITAX block: adjust to the real API here.
// =====================================================================================
const DIGITAX = {
  baseUrl: () => (process.env.DIGITAX_BASE_URL || 'https://api.digitax.tech/ke/v2').replace(/\/$/, ''),
  authHeader: 'X-API-Key',
  paths: {
    verify: '/business',
    items: '/items',
    invoices: '/invoices',
    creditNotes: '/credit-notes',
  },

  itemPayload(v, defaults) {
    return {
      item_code: v.etims_item_code || v.sku || String(v.id).replace(/-/g, '').slice(0, 20).toUpperCase(),
      item_name: v.variant_name && v.variant_name !== 'Default' ? `${v.product_name} - ${v.variant_name}` : v.product_name,
      item_class_code: v.etims_item_class_code || v.category_item_class_code || defaults.item_class_code || null,
      packaging_unit_code: v.etims_pkg_unit_code || defaults.packaging_unit_code || 'NT',
      quantity_unit_code: v.etims_unit_code || defaults.quantity_unit_code || 'U',
      tax_type_code: v.tax_code || 'B',
      origin_country_code: v.origin_country || 'KE',
      item_type_code: v.product_type === 'service' ? '3' : '2',
      unit_price: Number(v.selling_price),
    };
  },

  invoicePayload(inv) {
    const isCredit = inv.invoice_type === 'credit_note';
    return {
      reference: inv.sale_number,
      issued_at: new Date(inv.sold_at).toISOString(),
      branch_id: inv.etims_branch_id || undefined,
      prices_include_tax: Boolean(inv.prices_include_tax),
      customer: {
        name: inv.customer_name || undefined,
        pin: inv.customer_kra_pin || undefined,
        phone: inv.customer_phone || undefined,
      },
      items: inv.items.map((i) => ({
        item_code: i.etims_item_code,
        name: i.product_name,
        quantity: Number(i.quantity),
        unit_price: Number(i.unit_price),
        discount: Number(i.discount_amount),
        tax_type_code: i.tax_code || 'B',
        tax_rate: Number(i.tax_rate),
        tax_amount: Number(i.tax_amount),
        total: Number(i.line_total),
        item_class_code: i.etims_item_class_code || undefined,
        quantity_unit_code: i.etims_unit_code || undefined,
      })),
      totals: {
        subtotal: Number(inv.subtotal),
        discount: Number(inv.discount_total),
        tax: Number(inv.tax_total),
        total: Number(inv.total),
      },
      ...(isCredit
        ? { original_invoice_number: inv.original_kra_invoice_no, original_reference: inv.original_sale_number, reason: inv.refund_reason }
        : {}),
    };
  },

  /** Looks through the whole response for the first of these keys (case-insensitive). */
  resultOf(json) {
    const find = (names) => {
      const wanted = names.map((n) => n.toLowerCase());
      const stack = [json];
      while (stack.length) {
        const node = stack.shift();
        if (!node || typeof node !== 'object') continue;
        for (const [k, v] of Object.entries(node)) {
          if (wanted.includes(k.toLowerCase()) && v !== null && v !== undefined && typeof v !== 'object') return String(v);
          if (v && typeof v === 'object') stack.push(v);
        }
      }
      return null;
    };
    return {
      provider_reference: find(['id', 'uuid', 'reference_id']),
      kra_invoice_no: find(['kra_invoice_no', 'invoice_number', 'invoiceNumber', 'rcpt_no', 'receipt_number']),
      cu_serial_no: find(['cu_serial_no', 'cu_serial_number', 'scu_id', 'sdc_id']),
      cu_invoice_no: find(['cu_invoice_no', 'cu_invoice_number', 'cu_receipt_no']),
      receipt_signature: find(['receipt_signature', 'rcpt_sign', 'signature']),
      qr_code_data: find(['qr_code_data', 'qr_code', 'qrcode', 'qr_url', 'receipt_url']),
    };
  },

  itemCodeOf(json, fallback) {
    return (json && (json.item_code || (json.data && json.data.item_code))) || fallback;
  },

  errorOf(res) {
    const j = res.json || {};
    return String(j.message || j.error || (j.errors && JSON.stringify(j.errors)) || `HTTP ${res.status}`).slice(0, 1500);
  },
};
// =====================================================================================

async function call(config, method, path, body) {
  const key = decrypt(config.api_key_enc);
  if (!key) throw ApiError.unprocessable('Save your Digitax API key first');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${DIGITAX.baseUrl()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', [DIGITAX.authHeader]: key },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (err) {
      json = { message: text.slice(0, 500) };
    }
    return { status: res.status, ok: res.ok, json, network: false };
  } catch (err) {
    return { status: 0, ok: false, json: { message: err && err.name === 'AbortError' ? 'Digitax did not answer in time' : 'Could not reach Digitax' }, network: true };
  } finally {
    clearTimeout(timer);
  }
}

/** true when trying again later might work */
const isRetryable = (res) => res.network || res.status === 429 || res.status === 408 || res.status >= 500;

// ---------- connection check ----------

async function verify(db) {
  const config = await TenantEtimsConfig.get(db);
  if (!config || !config.api_key_enc) throw ApiError.unprocessable('Save your Digitax API key first');

  const res = await call(config, 'GET', DIGITAX.paths.verify);
  if (res.ok) return { ok: true, environment: config.environment, message: 'Connected to Digitax.' };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, environment: config.environment, message: 'Digitax rejected the API key.' };
  }
  return { ok: false, environment: config.environment, message: DIGITAX.errorOf(res) };
}

// ---------- items ----------

async function tenantDefaults(db) {
  const { rows } = await db.query('SELECT settings FROM tenants WHERE id = current_tenant_id()');
  const s = (rows[0] && rows[0].settings) || {};
  return {
    item_class_code: s.etims_default_item_class_code,
    packaging_unit_code: s.etims_default_packaging_unit_code,
    quantity_unit_code: s.etims_default_quantity_unit_code,
  };
}

/**
 * Registers variants with KRA. No ids = every variant not yet synced (at most 200 per call).
 * Returns { synced, failed, errors: [{ variant_id, sku, error }] }.
 */
async function syncItems(db, { variant_ids } = {}) {
  const config = await TenantEtimsConfig.get(db);
  if (!config || !config.is_active || !config.api_key_enc) {
    throw ApiError.unprocessable('Connect and verify eTIMS first', undefined, 'etims_not_connected');
  }
  const defaults = await tenantDefaults(db);

  const wanted = Array.isArray(variant_ids) && variant_ids.length;
  const { rows } = await db.query(
    `SELECT v.id, v.sku, v.name AS variant_name, v.selling_price, v.etims_item_code,
            p.name AS product_name, p.product_type, p.etims_pkg_unit_code, p.origin_country,
            COALESCE(p.etims_item_class_code, c.etims_item_class_code) AS etims_item_class_code,
            t.code AS tax_code, u.etims_unit_code
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN tax_classes t ON t.id = p.tax_class_id
       LEFT JOIN units u ON u.id = p.unit_id
      WHERE v.deleted_at IS NULL AND p.deleted_at IS NULL
        AND ${wanted ? 'v.id = ANY($1::uuid[])' : `COALESCE(v.etims_sync_status, 'pending') <> 'synced'`}
      ORDER BY v.created_at
      LIMIT ${SYNC_BATCH}`,
    wanted ? [variant_ids] : []
  );

  let synced = 0;
  const errors = [];
  for (const v of rows) {
    const payload = DIGITAX.itemPayload(v, defaults);
    const res = await call(config, 'POST', DIGITAX.paths.items, payload);
    if (res.ok) {
      await ProductVariant.markEtimsSynced(db, v.id, DIGITAX.itemCodeOf(res.json, payload.item_code));
      synced += 1;
    } else {
      await ProductVariant.markEtimsFailed(db, v.id);
      errors.push({ variant_id: v.id, sku: v.sku, error: DIGITAX.errorOf(res) });
      if (res.network || res.status === 401 || res.status === 403) break; // no point trying the rest
    }
  }
  return { synced, failed: errors.length, errors };
}

// ---------- invoices ----------

/**
 * Submits one invoice / credit note. Safe to call for an invoice a worker has claimed ('submitting')
 * and for a manual "submit now" (pending / failed). Never throws for a KRA / network problem:
 * it records the outcome on the invoice and returns it.
 */
async function processInvoice(db, invoiceId) {
  const current = await EtimsInvoice.findById(db, invoiceId);
  if (!current) throw ApiError.notFound('Invoice not found');
  if (current.status === 'submitted' || current.status === 'skipped') return current;

  const config = await TenantEtimsConfig.get(db);
  if (!config || !config.is_active || !config.api_key_enc) {
    return EtimsInvoice.update(db, current.id, { status: 'skipped', last_error: 'eTIMS is not connected for this shop' });
  }

  if (current.status === 'pending' || current.status === 'failed') {
    await db.query(
      `UPDATE etims_invoices SET status = 'submitting', attempts = attempts + 1
        WHERE id = $1 AND status IN ('pending', 'failed')`,
      [current.id]
    );
  }

  const inv = await EtimsInvoice.getForSubmission(db, current.id);
  if (!inv) return current;

  // A credit note needs the original invoice's KRA number.
  if (inv.invoice_type === 'credit_note' && !inv.original_kra_invoice_no) {
    if (!inv.original_sale_id) return EtimsInvoice.markRejected(db, inv.id, 'The credit note has no original sale');
    return EtimsInvoice.markFailed(db, inv.id, 'The original invoice has not reached KRA yet');
  }

  // Every line must be a registered item.
  const variantIds = [...new Set(inv.items.map((i) => i.variant_id))];
  const { rows: codes } = await db.query(
    'SELECT id, etims_item_code, etims_sync_status FROM product_variants WHERE id = ANY($1::uuid[])',
    [variantIds]
  );
  if (codes.some((c) => c.etims_sync_status !== 'synced' || !c.etims_item_code)) {
    const outcome = await syncItems(db, { variant_ids: variantIds });
    if (outcome.failed) {
      const message = `Could not register items with KRA: ${outcome.errors[0].error}`;
      return EtimsInvoice.markFailed(db, inv.id, message);
    }
    const { rows: again } = await db.query('SELECT id, etims_item_code FROM product_variants WHERE id = ANY($1::uuid[])', [variantIds]);
    codes.splice(0, codes.length, ...again);
  }
  const codeById = new Map(codes.map((c) => [c.id, c.etims_item_code]));
  inv.items = inv.items.map((i) => ({ ...i, etims_item_code: codeById.get(i.variant_id) }));

  const payload = DIGITAX.invoicePayload(inv);
  const path = inv.invoice_type === 'credit_note' ? DIGITAX.paths.creditNotes : DIGITAX.paths.invoices;
  const res = await call(config, 'POST', path, payload);

  if (res.ok) {
    return EtimsInvoice.markSubmitted(db, inv.id, {
      request_payload: payload,
      response_payload: res.json,
      ...DIGITAX.resultOf(res.json),
    });
  }

  const message = DIGITAX.errorOf(res);
  const detail = { request_payload: payload, response_payload: res.json };
  return isRetryable(res)
    ? EtimsInvoice.markFailed(db, inv.id, message, detail)
    : EtimsInvoice.markRejected(db, inv.id, message, detail);
}

// ---------- background worker ----------

/** Claims due invoices across every shop and submits them. Returns how many were attempted. */
async function processDue(limit = 20) {
  const jobs = await EtimsInvoice.claimDue(limit);
  for (const job of jobs) {
    try {
      await withTenant(job.tenant_id, (db) => processInvoice(db, job.id));
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'eTIMS submit failed', invoice: job.id, error: err.message }));
    }
  }
  return jobs.length;
}

/**
 * Optional: call once from server.js after the app starts, e.g.
 *   require('./services/EtimsService').startWorker();
 * Returns a function that stops it. With several server instances claim_etims_jobs hands each job
 * to one of them.
 */
function startWorker(intervalMs = 30000) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      while ((await processDue(20)) === 20) { /* keep going while there is a backlog */ }
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'eTIMS worker failed', error: err.message }));
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { verify, syncItems, processInvoice, processDue, startWorker };
