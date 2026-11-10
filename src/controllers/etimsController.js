'use strict';

/**
 * KRA eTIMS through Digitax: connection settings, the submission queue, retries and item sync.
 * Invoices are created by the sale flow and submitted by a background worker; this controller
 * is the dashboard for it.
 */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, paginated } = require('../utils/respond');
const { oneOf } = require('../utils/validate');
const { run, pageParams } = require('../utils/context');
const { audit } = require('../utils/audit');
const { encrypt } = require('../utils/crypto');
const { TenantEtimsConfig, EtimsInvoice } = require('../models');
const EtimsService = require('../services/EtimsService');

// GET /etims/config
exports.getConfig = asyncHandler(async (req, res) => {
  const config = await run(req, (db) => TenantEtimsConfig.get(db));
  return ok(res, TenantEtimsConfig.sanitize(config));
});

// PUT /etims/config  { provider, environment: 'sandbox'|'live', api_key, auto_submit, provider_business_id }
// A new API key switches the connection off until it has been verified.
exports.saveConfig = asyncHandler(async (req, res) => {
  const data = {};
  if (req.body.provider) data.provider = oneOf(req.body.provider, ['digitax', 'direct_oscu', 'other'], 'provider');
  if (req.body.environment) data.environment = oneOf(req.body.environment, ['sandbox', 'live'], 'environment');
  if (req.body.auto_submit !== undefined) data.auto_submit = Boolean(req.body.auto_submit);
  if (req.body.provider_business_id !== undefined) data.provider_business_id = req.body.provider_business_id;
  if (req.body.api_key) {
    data.api_key_enc = encrypt(String(req.body.api_key).trim());
    data.is_active = false;
  }
  if (!Object.keys(data).length) throw ApiError.unprocessable('Nothing to save');

  const config = await run(req, async (db) => {
    const record = await TenantEtimsConfig.save(db, data);
    await audit(db, req, 'etims.config_save', 'tenant_etims_config', record.id, {
      environment: data.environment,
      api_key_changed: Boolean(req.body.api_key),
    });
    return record;
  });
  return ok(res, TenantEtimsConfig.sanitize(config));
});

// POST /etims/verify   tests the saved key against Digitax; on success the connection is switched on
exports.verify = asyncHandler(async (req, res) => {
  const result = await run(req, async (db) => {
    const config = await TenantEtimsConfig.get(db);
    if (!config || !config.api_key_enc) throw ApiError.unprocessable('Save your Digitax API key first');

    const outcome = await EtimsService.verify(db);
    if (outcome.ok) await TenantEtimsConfig.markVerified(db, config.id);
    await audit(db, req, 'etims.verify', 'tenant_etims_config', config.id, { ok: outcome.ok });
    return outcome;
  });
  return ok(res, result);
});

// GET /etims/invoices?status=&from=&to=
exports.listInvoices = asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const result = await run(req, (db) =>
    EtimsInvoice.search(db, { status: req.query.status, from: req.query.from, to: req.query.to, page, limit })
  );
  return paginated(res, result);
});

// GET /etims/invoices/:id   includes what was sent to and received from KRA
exports.getInvoice = asyncHandler(async (req, res) => {
  const invoice = await run(req, (db) => EtimsInvoice.getForSubmission(db, req.params.id));
  if (!invoice) throw ApiError.notFound('Invoice not found');
  return ok(res, invoice);
});

// GET /etims/status   { pending: 2, submitted: 340, failed: 1, rejected: 0, ... }
exports.statusCounts = asyncHandler(async (req, res) => {
  const counts = await run(req, (db) => EtimsInvoice.statusCounts(db));
  return ok(res, counts);
});

// POST /etims/invoices/:id/retry   puts a failed / rejected / skipped invoice back in the queue
exports.retry = asyncHandler(async (req, res) => {
  const invoice = await run(req, async (db) => {
    const record = await EtimsInvoice.retry(db, req.params.id);
    if (!record) throw ApiError.conflict('Only failed, rejected or skipped invoices can be retried');
    await audit(db, req, 'etims.retry', 'etims_invoice', record.id, null);
    return record;
  });
  return ok(res, invoice);
});

// POST /etims/invoices/:id/submit   retries and submits right now instead of waiting for the worker
exports.submitNow = asyncHandler(async (req, res) => {
  const invoice = await run(req, async (db) => {
    const current = await EtimsInvoice.findById(db, req.params.id);
    if (!current) throw ApiError.notFound('Invoice not found');
    if (current.status !== 'submitted') await EtimsInvoice.retry(db, current.id);
    await EtimsService.processInvoice(db, current.id);
    await audit(db, req, 'etims.submit_now', 'etims_invoice', current.id, null);
    return EtimsInvoice.findById(db, current.id);
  });
  return ok(res, invoice);
});

// POST /etims/retry-all   re-queues every failed and rejected invoice (max 200 at a time)
exports.retryAll = asyncHandler(async (req, res) => {
  const result = await run(req, async (db) => {
    const stuck = await EtimsInvoice.findAll(db, {
      filters: { status: ['failed', 'rejected'] },
      orderBy: 'created_at:asc',
      limit: 200,
    });
    let requeued = 0;
    for (const invoice of stuck) {
      if (await EtimsInvoice.retry(db, invoice.id)) requeued += 1;
    }
    await audit(db, req, 'etims.retry_all', 'etims_invoice', null, { requeued });
    return { requeued };
  });
  return ok(res, result);
});

// POST /etims/sync-items  { variant_ids?: [] }   registers products with KRA (default: all not yet synced)
exports.syncItems = asyncHandler(async (req, res) => {
  const result = await run(req, async (db) => {
    const outcome = await EtimsService.syncItems(db, { variant_ids: req.body.variant_ids });
    await audit(db, req, 'etims.sync_items', 'product_variant', null, outcome);
    return outcome;
  });
  return ok(res, result);
});
