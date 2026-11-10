'use strict';

/**
 * M-Pesa per shop: each tenant stores its own Daraja credentials (encrypted). The public webhook
 * handlers at the bottom are called by Safaricom, not by the app: they sit behind a secret
 * token in the URL, which maps the callback to the right shop.
 *
 * Webhook paths deliberately avoid the words "mpesa" / "safaricom", which Daraja rejects
 * when registering C2B URLs.
 */
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok, created, paginated } = require('../utils/respond');
const { requireFields, positive } = require('../utils/validate');
const { run, branchId, pageParams } = require('../utils/context');
const { audit } = require('../utils/audit');
const { encrypt } = require('../utils/crypto');
const { MpesaConfig, MpesaTransaction } = require('../models');
const MpesaService = require('../services/MpesaService');

const SECRET_FIELDS = {
  consumer_key: 'consumer_key_enc',
  consumer_secret: 'consumer_secret_enc',
  passkey: 'passkey_enc',
  initiator_credential: 'initiator_credential_enc',
};
const PLAIN_FIELDS = [
  'branch_id', 'label', 'provider', 'environment', 'shortcode', 'shortcode_type',
  'initiator_name', 'provider_settings', 'is_default', 'is_active',
];

function baseUrl(req) {
  return (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function callbackUrls(req, config) {
  const root = `${baseUrl(req)}/api/hooks/pay/${config.callback_token}`;
  return {
    stk_callback: `${root}/stk`,
    c2b_validation: `${root}/validation`,
    c2b_confirmation: `${root}/confirmation`,
  };
}

// Secrets never go back to the browser: only "has_*" flags and the callback URLs.
function present(req, config) {
  return { ...MpesaConfig.sanitize(config), callback_urls: callbackUrls(req, config) };
}

function buildData(body) {
  const data = {};
  for (const key of PLAIN_FIELDS) if (body[key] !== undefined) data[key] = body[key];
  for (const [input, column] of Object.entries(SECRET_FIELDS)) {
    if (body[input]) data[column] = encrypt(body[input]); // blank = keep the stored value
  }
  return data;
}

// ---------- configuration ----------

// GET /mpesa/configs
exports.listConfigs = asyncHandler(async (req, res) => {
  const rows = await run(req, (db) => MpesaConfig.findAll(db));
  return ok(res, rows.map((c) => present(req, c)));
});

// POST /mpesa/configs
// { label, shortcode, shortcode_type: 'till'|'paybill', environment, consumer_key, consumer_secret,
//   passkey, initiator_name, initiator_credential, branch_id?, is_default? }
exports.createConfig = asyncHandler(async (req, res) => {
  requireFields(req.body, ['shortcode']);
  const config = await run(req, async (db) => {
    const record = await MpesaConfig.create(db, buildData(req.body));
    if (req.body.is_default) await MpesaConfig.setDefault(db, record.id);
    await audit(db, req, 'mpesa.config_create', 'mpesa_config', record.id, { shortcode: record.shortcode });
    return MpesaConfig.findById(db, record.id);
  });
  return created(res, present(req, config));
});

// PATCH /mpesa/configs/:id
exports.updateConfig = asyncHandler(async (req, res) => {
  const config = await run(req, async (db) => {
    const record = await MpesaConfig.update(db, req.params.id, buildData(req.body));
    if (!record) throw ApiError.notFound('M-Pesa configuration not found');
    if (req.body.is_default === true) await MpesaConfig.setDefault(db, record.id);
    await audit(db, req, 'mpesa.config_update', 'mpesa_config', record.id, {
      fields: Object.keys(req.body).filter((k) => !SECRET_FIELDS[k]),
      secrets_changed: Object.keys(SECRET_FIELDS).filter((k) => req.body[k]),
    });
    return MpesaConfig.findById(db, record.id);
  });
  return ok(res, present(req, config));
});

// POST /mpesa/configs/:id/deactivate   (configs with payment history are kept, not deleted)
exports.deactivateConfig = asyncHandler(async (req, res) => {
  await run(req, async (db) => {
    const record = await MpesaConfig.update(db, req.params.id, { is_active: false, is_default: false });
    if (!record) throw ApiError.notFound('M-Pesa configuration not found');
    await audit(db, req, 'mpesa.config_deactivate', 'mpesa_config', record.id, null);
  });
  return ok(res, { deactivated: true });
});

// POST /mpesa/configs/:id/test   checks the credentials by requesting a Daraja access token
exports.testConfig = asyncHandler(async (req, res) => {
  const result = await run(req, (db) => MpesaService.testConnection(db, req.params.id));
  return ok(res, result);
});

// POST /mpesa/configs/:id/register-c2b   registers the confirmation/validation URLs with Safaricom
exports.registerC2b = asyncHandler(async (req, res) => {
  const result = await run(req, async (db) => {
    const config = await MpesaConfig.findById(db, req.params.id);
    if (!config) throw ApiError.notFound('M-Pesa configuration not found');
    const outcome = await MpesaService.registerC2bUrls(db, config.id, callbackUrls(req, config));
    await audit(db, req, 'mpesa.register_c2b', 'mpesa_config', config.id, null);
    return outcome;
  });
  return ok(res, result);
});

// ---------- taking payments ----------

// POST /mpesa/stk-push  { sale_id, phone, amount? }   amount defaults to the sale's balance due
exports.stkPush = asyncHandler(async (req, res) => {
  requireFields(req.body, ['sale_id', 'phone']);
  if (req.body.amount !== undefined) positive(req.body.amount, 'amount');
  const branch = branchId(req, { required: false });

  const tx = await run(req, async (db) => {
    const record = await MpesaService.stkPush(db, req.user, {
      sale_id: req.body.sale_id,
      phone: req.body.phone,
      amount: req.body.amount,
      branch_id: branch,
    });
    await audit(db, req, 'mpesa.stk_push', 'sale', req.body.sale_id, { amount: record.amount });
    return record;
  });
  return created(res, tx);
});

// GET /mpesa/transactions/:id   poll for the result (checks Safaricom if still pending after a while)
exports.transactionStatus = asyncHandler(async (req, res) => {
  const tx = await run(req, (db) => MpesaService.queryStatus(db, req.params.id));
  if (!tx) throw ApiError.notFound('Transaction not found');
  return ok(res, tx);
});

// GET /mpesa/transactions?status=&direction=
exports.listTransactions = asyncHandler(async (req, res) => {
  const { page, limit } = pageParams(req);
  const filters = {};
  if (req.query.status) filters.status = req.query.status;
  if (req.query.direction) filters.direction = req.query.direction;
  const result = await run(req, (db) => MpesaTransaction.paginate(db, { filters, page, limit }));
  return paginated(res, result);
});

// GET /mpesa/sales/:saleId/transactions
exports.forSale = asyncHandler(async (req, res) => {
  const rows = await run(req, (db) => MpesaTransaction.forSale(db, req.params.saleId));
  return ok(res, rows);
});

// GET /mpesa/unmatched   customers who paid the till/paybill; staff attach each to a sale
exports.unmatched = asyncHandler(async (req, res) => {
  const rows = await run(req, (db) => MpesaTransaction.unmatched(db, { limit: 50 }));
  return ok(res, rows);
});

// POST /mpesa/transactions/:id/claim  { sale_id }   attaches the payment and records it on the sale
exports.claim = asyncHandler(async (req, res) => {
  requireFields(req.body, ['sale_id']);
  const result = await run(req, async (db) => {
    const outcome = await MpesaService.claimPayment(db, req.user, {
      transaction_id: req.params.id,
      sale_id: req.body.sale_id,
    });
    await audit(db, req, 'mpesa.claim', 'sale', req.body.sale_id, { transaction_id: req.params.id });
    return outcome;
  });
  return ok(res, result);
});

// ---------- webhooks (public: called by Safaricom) ----------
// Always answer "Accepted" quickly. If processing fails we log it and still accept: the raw
// payload is stored first by the service, and answering with an error only makes Safaricom retry.

const ACCEPTED = { ResultCode: 0, ResultDesc: 'Accepted' };

exports.stkCallback = asyncHandler(async (req, res) => {
  try {
    await MpesaService.handleStkCallback(req.params.token, req.body);
  } catch (err) {
    console.error('M-Pesa STK callback failed:', err);
  }
  return res.status(200).json(ACCEPTED);
});

exports.c2bValidation = asyncHandler(async (req, res) => {
  try {
    const decision = await MpesaService.handleC2bValidation(req.params.token, req.body);
    if (decision && decision.accept === false) {
      return res.status(200).json({ ResultCode: 'C2B00011', ResultDesc: 'Rejected' });
    }
  } catch (err) {
    console.error('M-Pesa C2B validation failed:', err);
  }
  return res.status(200).json({ ResultCode: '0', ResultDesc: 'Accepted' });
});

exports.c2bConfirmation = asyncHandler(async (req, res) => {
  try {
    await MpesaService.handleC2bConfirmation(req.params.token, req.body);
  } catch (err) {
    console.error('M-Pesa C2B confirmation failed:', err);
  }
  return res.status(200).json({ ResultCode: '0', ResultDesc: 'Accepted' });
});
