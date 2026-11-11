'use strict';

/**
 * M-Pesa through Safaricom Daraja, one set of credentials per shop (mpesa_configs).
 *  - STK Push (the prompt on the customer's phone) and its callback
 *  - C2B (customer pays the till / paybill) validation + confirmation callbacks
 *  - claiming an unmatched payment onto a sale
 *
 * Secrets are decrypted only here, at the moment of the Daraja call, and never logged.
 *
 * Webhooks: the URL token (mpesa_configs.callback_token) identifies the shop. The handlers store the
 * payload FIRST in one transaction, then apply it to the sale in a second one, so a problem while
 * recording the payment can never lose what Safaricom told us.
 *
 * Tills (Buy Goods): BusinessShortCode is provider_settings.store_number when set (the head-office
 * number Daraja wants), otherwise the shortcode; PartyB is the till number (shortcode).
 */
const ApiError = require('../utils/ApiError');
const { round2 } = require('../utils/money');
const { decrypt } = require('../utils/crypto');
const { withTenant, withTransaction } = require('../config/database');
const { MpesaConfig, MpesaTransaction, Sale } = require('../models');
const PaymentService = require('./PaymentService');

const HOSTS = { sandbox: 'https://sandbox.safaricom.co.ke', live: 'https://api.safaricom.co.ke' };
const HTTP_TIMEOUT_MS = 15000;
const STK_QUERY_AFTER_MS = 25000;
const STK_ASSUME_PAID_AFTER_MS = 90000;

// ---------- helpers ----------

const hostFor = (config) => (config.environment === 'sandbox' ? HOSTS.sandbox : HOSTS.live);

/** 07xx / 01xx / +254... / 254... -> 2547XXXXXXXX, or null when it is not a Kenyan mobile number. */
function normalisePhone(input) {
  const digits = String(input || '').replace(/[^\d]/g, '');
  let msisdn = null;
  if (/^0[17]\d{8}$/.test(digits)) msisdn = `254${digits.slice(1)}`;
  else if (/^254[17]\d{8}$/.test(digits)) msisdn = digits;
  else if (/^[17]\d{8}$/.test(digits)) msisdn = `254${digits}`;
  return msisdn;
}

function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
}

/** Daraja sends times as YYYYMMDDHHmmss in East Africa Time. */
function parseDarajaTime(value) {
  const s = String(value || '');
  if (!/^\d{14}$/.test(s)) return null;
  return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}+03:00`);
}

function assertSupported(config) {
  if (config.provider && config.provider !== 'daraja') {
    throw ApiError.unprocessable(`M-Pesa provider "${config.provider}" is not supported yet`, undefined, 'provider_unsupported');
  }
}

async function http(method, url, { headers = {}, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (err) {
      json = { raw: text.slice(0, 500) };
    }
    return { status: res.status, ok: res.ok, json };
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    throw ApiError.unprocessable(timedOut ? 'Safaricom did not answer in time. Try again.' : 'Could not reach Safaricom. Try again.', undefined, 'mpesa_unreachable');
  } finally {
    clearTimeout(timer);
  }
}

const tokenCache = new Map(); // `${configId}:${environment}:${keyTail}` -> { token, expires }

async function accessToken(config) {
  const key = decrypt(config.consumer_key_enc);
  const secret = decrypt(config.consumer_secret_enc);
  if (!key || !secret) throw ApiError.unprocessable('Add the consumer key and secret first', undefined, 'mpesa_not_configured');

  const cacheKey = `${config.id}:${config.environment}:${key.slice(-6)}`;
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.token;

  const res = await http('GET', `${hostFor(config)}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` },
  });
  if (!res.ok || !res.json || !res.json.access_token) {
    throw ApiError.unprocessable('Safaricom rejected the consumer key / secret', undefined, 'mpesa_bad_credentials');
  }
  const ttl = Math.max((parseInt(res.json.expires_in, 10) || 3599) - 60, 30);
  tokenCache.set(cacheKey, { token: res.json.access_token, expires: Date.now() + ttl * 1000 });
  return res.json.access_token;
}

async function daraja(config, path, body) {
  const token = await accessToken(config);
  return http('POST', `${hostFor(config)}${path}`, { headers: { Authorization: `Bearer ${token}` }, body });
}

function stkCredentials(config) {
  const passkey = decrypt(config.passkey_enc);
  if (!passkey) throw ApiError.unprocessable('Add the Lipa na M-Pesa passkey first', undefined, 'mpesa_not_configured');
  const settings = config.provider_settings || {};
  const shortcode = String(settings.store_number || config.shortcode);
  const ts = timestamp();
  return { shortcode, ts, password: Buffer.from(`${shortcode}${passkey}${ts}`).toString('base64') };
}

function callbackBase(config) {
  const prefix = (process.env.API_PREFIX || '/api').replace(/\/$/, '');
  const root = (process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
  if (!root) throw ApiError.unprocessable('PUBLIC_API_URL is not set, so Safaricom cannot reach this server', undefined, 'public_url_missing');
  return `${root}${prefix}/hooks/pay/${config.callback_token}`;
}

// ---------- configuration checks ----------

async function testConnection(db, configId) {
  const config = await MpesaConfig.findById(db, configId);
  if (!config) throw ApiError.notFound('M-Pesa configuration not found');
  assertSupported(config);
  try {
    await accessToken(config);
    return { ok: true, environment: config.environment, message: 'Connected to Safaricom.' };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, environment: config.environment, message: err.message };
    throw err;
  }
}

/** Registers the confirmation / validation URLs for customers paying the till or paybill. */
async function registerC2bUrls(db, configId, urls) {
  const config = await MpesaConfig.findById(db, configId);
  if (!config) throw ApiError.notFound('M-Pesa configuration not found');
  assertSupported(config);

  const res = await daraja(config, '/mpesa/c2b/v2/registerurl', {
    ShortCode: config.shortcode,
    ResponseType: 'Completed',
    ConfirmationURL: urls.c2b_confirmation,
    ValidationURL: urls.c2b_validation,
  });
  const body = res.json || {};
  const success = res.ok && (String(body.ResponseCode) === '0' || /success/i.test(String(body.ResponseDescription || '')));
  if (success) await MpesaConfig.update(db, config.id, { c2b_registered_at: new Date() });
  return {
    ok: success,
    message: body.ResponseDescription || body.errorMessage || (success ? 'URLs registered.' : 'Safaricom did not accept the URLs.'),
  };
}

// ---------- STK Push ----------

/**
 * Sends the payment prompt. amount defaults to the sale's balance; M-Pesa takes whole shillings, so
 * cents are rounded up (the payment applied to the sale never exceeds the balance).
 * user may be null (online store).
 */
async function stkPush(db, user, { sale_id, phone, amount, branch_id }) {
  const { rows } = await db.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [sale_id]);
  const sale = rows[0];
  if (!sale) throw ApiError.notFound('Sale not found');
  if (sale.status === 'void') throw ApiError.conflict('This sale was voided');
  if (sale.sale_type !== 'sale') throw ApiError.conflict('Payments cannot be requested for a credit note');

  const balance = round2(Number(sale.total) - Number(sale.amount_paid));
  if (balance <= 0.005) throw ApiError.conflict('This sale is already fully paid', undefined, 'already_paid');
  const wanted = amount === undefined || amount === null ? balance : round2(Number(amount));
  if (wanted > balance + 0.005) throw ApiError.unprocessable(`Only ${balance.toFixed(2)} is still due on this sale`);
  const stkAmount = Math.max(Math.ceil(wanted - 0.0001), 1);

  const msisdn = normalisePhone(phone);
  if (!msisdn) throw ApiError.unprocessable('Enter a valid Safaricom number, e.g. 0712 345 678', undefined, 'invalid_phone');

  const config = await MpesaConfig.forBranch(db, branch_id || sale.branch_id);
  if (!config) throw ApiError.unprocessable('M-Pesa is not set up for this shop yet', undefined, 'mpesa_not_configured');
  assertSupported(config);

  const { rows: pending } = await db.query(
    `SELECT 1 FROM mpesa_transactions
      WHERE sale_id = $1 AND direction = 'stk_push' AND status = 'pending'
        AND created_at > now() - interval '2 minutes' LIMIT 1`,
    [sale.id]
  );
  if (pending.length) {
    throw ApiError.conflict('A payment request was just sent for this sale. Wait for the customer to respond.', undefined, 'stk_pending');
  }

  const { shortcode, ts, password } = stkCredentials(config);
  const isTill = config.shortcode_type === 'till';
  const request = {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: ts,
    TransactionType: isTill ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
    Amount: stkAmount,
    PartyA: msisdn,
    PartyB: String(config.shortcode),
    PhoneNumber: msisdn,
    CallBackURL: `${callbackBase(config)}/stk`,
    AccountReference: String(sale.sale_number).slice(0, 12),
    TransactionDesc: 'Payment',
  };

  const tx = await MpesaTransaction.create(db, {
    config_id: config.id,
    direction: 'stk_push',
    status: 'pending',
    sale_id: sale.id,
    phone: msisdn,
    amount: stkAmount,
    account_reference: request.AccountReference,
    transaction_desc: request.TransactionDesc,
    request_payload: { ...request, Password: '[hidden]' },
    initiated_by: user ? user.id : undefined,
  });

  const res = await daraja(config, '/mpesa/stkpush/v1/processrequest', request);
  const body = res.json || {};
  if (!res.ok || String(body.ResponseCode) !== '0') {
    throw ApiError.unprocessable(
      `Could not send the M-Pesa prompt: ${body.errorMessage || body.ResponseDescription || 'Safaricom refused the request'}`,
      undefined,
      'stk_failed'
    );
  }
  return MpesaTransaction.update(db, tx.id, {
    merchant_request_id: body.MerchantRequestID,
    checkout_request_id: body.CheckoutRequestID,
  });
}

/** Maps a Daraja result code to our status. 0 = paid; everything else is a failed attempt. */
const statusForResult = (code) => (Number(code) === 0 ? 'success' : 'failed');

/**
 * Poll endpoint. A pending prompt is checked with Safaricom once it is older than a few seconds
 * (the callback normally arrives first). Returns null when the transaction does not exist.
 */
async function queryStatus(db, transactionId) {
  const tx = await MpesaTransaction.findById(db, transactionId);
  if (!tx || tx.status !== 'pending' || tx.direction !== 'stk_push' || !tx.checkout_request_id) return tx;

  const age = Date.now() - new Date(tx.created_at).getTime();
  if (age < STK_QUERY_AFTER_MS) return tx;

  const config = await MpesaConfig.findById(db, tx.config_id);
  if (!config) return tx;

  let body;
  try {
    const { shortcode, ts, password } = stkCredentials(config);
    const res = await daraja(config, '/mpesa/stkpushquery/v1/query', {
      BusinessShortCode: shortcode, Password: password, Timestamp: ts, CheckoutRequestID: tx.checkout_request_id,
    });
    body = res.json || {};
  } catch (err) {
    return tx; // Safaricom unreachable: the caller simply polls again
  }

  // While the customer is still deciding Daraja answers with an error and no ResultCode.
  if (body.ResultCode === undefined || body.ResultCode === null) return tx;
  const code = Number(body.ResultCode);

  if (code !== 0) {
    const settled = await MpesaTransaction.settleStk(db, tx.id, {
      status: 'failed', result_code: code, result_desc: body.ResultDesc,
    });
    return settled || MpesaTransaction.findById(db, tx.id);
  }

  // Paid, but a status query carries no receipt number. Give the callback a moment to bring it;
  // if it never does, record the payment under the checkout id so the shop is not left waiting.
  if (age < STK_ASSUME_PAID_AFTER_MS) return tx;
  const settled = await MpesaTransaction.settleStk(db, tx.id, {
    status: 'success', result_code: 0, result_desc: body.ResultDesc || 'Paid (confirmed by status query)',
  });
  if (settled && settled.sale_id) {
    await PaymentService.recordMpesaReceipt(db, null, { sale_id: settled.sale_id, transaction: settled });
  }
  return settled || MpesaTransaction.findById(db, tx.id);
}

// ---------- claiming a till payment ----------

/** Staff attach a payment the customer made to the till / paybill to a sale. */
async function claimPayment(db, user, { transaction_id, sale_id }) {
  const { rows } = await db.query('SELECT * FROM mpesa_transactions WHERE id = $1 FOR UPDATE', [transaction_id]);
  const tx = rows[0];
  if (!tx) throw ApiError.notFound('Transaction not found');
  if (tx.status !== 'success') throw ApiError.conflict('Only a completed M-Pesa payment can be claimed');
  if (tx.sale_id) throw ApiError.conflict('That payment is already linked to a sale', undefined, 'already_claimed');

  const sale = await Sale.findById(db, sale_id);
  if (!sale) throw ApiError.notFound('Sale not found');

  const attached = await MpesaTransaction.attachToSale(db, tx.id, sale.id);
  if (!attached) throw ApiError.conflict('That payment was just claimed by someone else', undefined, 'already_claimed');

  const result = await PaymentService.recordMpesaReceipt(db, user, { sale_id: sale.id, transaction: attached });
  if (!result.payment) throw ApiError.conflict(result.reason || 'The payment could not be applied to that sale');
  return {
    transaction: attached,
    payment: result.payment,
    sale: await Sale.getFull(db, sale.id),
    overpaid: result.overpaid || 0,
  };
}

// ---------- webhooks (no login: the URL token is the key) ----------

async function resolveToken(token) {
  const found = await withTransaction((db) => MpesaConfig.resolveCallback(db, token));
  if (!found) return null;
  // resolve_mpesa_callback returns the shop and the configuration; accept the usual column names
  const tenantId = found.tenant_id;
  const configId = found.config_id || found.mpesa_config_id || found.id;
  if (!tenantId || !configId) return null;
  return { tenantId, configId, active: found.is_active !== false };
}

function metadataOf(callback) {
  const items = (callback.CallbackMetadata && callback.CallbackMetadata.Item) || [];
  return Object.fromEntries(items.map((i) => [i.Name, i.Value]));
}

async function handleStkCallback(token, body) {
  const target = await resolveToken(token);
  if (!target) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'M-Pesa STK callback for unknown token' }));
    return;
  }
  const cb = body && body.Body && body.Body.stkCallback;
  if (!cb || !cb.CheckoutRequestID) return;

  const meta = metadataOf(cb);
  const code = Number(cb.ResultCode);
  const status = statusForResult(code);

  // 1) store what Safaricom said
  const settled = await withTenant(target.tenantId, async (db) => {
    const tx = await MpesaTransaction.findByCheckoutRequestId(db, target.configId, cb.CheckoutRequestID);
    if (!tx) return { unknown: true };

    const fresh = await MpesaTransaction.settleStk(db, tx.id, {
      status,
      result_code: code,
      result_desc: cb.ResultDesc,
      mpesa_receipt: meta.MpesaReceiptNumber,
      transaction_time: parseDarajaTime(meta.TransactionDate),
      callback_payload: body,
    });
    if (fresh) return { tx: fresh };

    // A status query already marked it paid without a receipt: add the receipt now.
    if (status === 'success' && tx.status === 'success' && !tx.mpesa_receipt && meta.MpesaReceiptNumber) {
      await db.query(
        'UPDATE mpesa_transactions SET mpesa_receipt = $2, transaction_time = $3, callback_payload = $4::jsonb WHERE id = $1',
        [tx.id, meta.MpesaReceiptNumber, parseDarajaTime(meta.TransactionDate), JSON.stringify(body)]
      );
      await db.query('UPDATE payments SET reference = $2 WHERE mpesa_transaction_id = $1', [tx.id, meta.MpesaReceiptNumber]);
    }
    return { duplicate: true };
  });
  if (settled.unknown) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'M-Pesa STK callback for unknown checkout id', checkout: cb.CheckoutRequestID }));
    return;
  }
  if (!settled.tx || status !== 'success' || !settled.tx.sale_id) return;

  // 2) apply it to the sale; if that fails, free the payment so staff can claim it by hand
  try {
    await withTenant(target.tenantId, (db) =>
      PaymentService.recordMpesaReceipt(db, null, { sale_id: settled.tx.sale_id, transaction: settled.tx })
    );
  } catch (err) {
    console.error('Could not record the M-Pesa payment on the sale:', err);
    await withTenant(target.tenantId, (db) =>
      db.query('UPDATE mpesa_transactions SET sale_id = NULL WHERE id = $1', [settled.tx.id])
    );
  }
}

/** Customer is about to pay the till / paybill. Accept for any known, active configuration. */
async function handleC2bValidation(token) {
  const target = await resolveToken(token);
  return { accept: Boolean(target && target.active) };
}

async function handleC2bConfirmation(token, body) {
  const target = await resolveToken(token);
  if (!target || !body || !body.TransID) return;

  const payer = [body.FirstName, body.MiddleName, body.LastName].filter(Boolean).join(' ') || null;
  const stored = await withTenant(target.tenantId, (db) =>
    MpesaTransaction.recordC2b(db, {
      config_id: target.configId,
      phone: body.MSISDN,
      amount: Number(body.TransAmount),
      bill_ref_number: body.BillRefNumber,
      mpesa_receipt: body.TransID,
      transaction_time: parseDarajaTime(body.TransTime),
      payer_name: payer,
      callback_payload: body,
    })
  );
  if (!stored) return; // Safaricom retried: already recorded

  // Paybill customers type the invoice number as the account: match it when it is unambiguous.
  const reference = String(body.BillRefNumber || '').trim();
  if (!reference) return;
  try {
    await withTenant(target.tenantId, async (db) => {
      const sale = await Sale.findOne(db, { sale_number: reference.toUpperCase() });
      if (!sale || sale.status === 'void' || sale.sale_type !== 'sale') return;
      const balance = round2(Number(sale.total) - Number(sale.amount_paid));
      if (balance <= 0.005 || Number(stored.amount) > balance + 0.005) return; // leave for staff to claim
      const attached = await MpesaTransaction.attachToSale(db, stored.id, sale.id);
      if (attached) await PaymentService.recordMpesaReceipt(db, null, { sale_id: sale.id, transaction: attached });
    });
  } catch (err) {
    console.error('Could not auto-match the M-Pesa payment:', err);
  }
}

/**
 * For a scheduled job, run per shop inside withTenant(): marks prompts nobody answered as timed out.
 * There is no cross-shop list of pending prompts, so the caller loops over active shops.
 */
async function sweepStale(db, { minutes = 10 } = {}) {
  const stale = await MpesaTransaction.stalePending(db, minutes);
  let timedOut = 0;
  for (const tx of stale) if (await MpesaTransaction.markTimeout(db, tx.id)) timedOut += 1;
  return { timed_out: timedOut };
}

module.exports = {
  normalisePhone,
  testConnection,
  registerC2bUrls,
  stkPush,
  queryStatus,
  claimPayment,
  handleStkCallback,
  handleC2bValidation,
  handleC2bConfirmation,
  sweepStale,
};
