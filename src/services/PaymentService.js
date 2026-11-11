'use strict';

/**
 * Recording money against a sale: cash (with change), M-Pesa, card, bank, credit ("deni"), voucher.
 * Runs inside the caller's tenant transaction. After every payment the sale's totals are refreshed
 * and SaleService.afterPayment() closes tabs / online orders that are now fully paid.
 *
 * Customer credit: a 'credit' payment counts as paid on the sale and adds a credit_sale entry to the
 * customer's ledger. The customer later settles that debt through /customers/:id/payments.
 */
const ApiError = require('../utils/ApiError');
const { round2 } = require('../utils/money');
const { Sale, Payment, Shift, Customer, CustomerLedger, MpesaTransaction } = require('../models');

const EPS = 0.005;

const balanceOf = (sale) => round2(Number(sale.total) - Number(sale.amount_paid));

async function lockSale(db, saleId) {
  const { rows } = await db.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [saleId]);
  if (!rows[0]) throw ApiError.notFound('Sale not found');
  return rows[0];
}

async function shiftFor(db, user, sale) {
  if (user) {
    const shift = await Shift.findOpenForUser(db, user.id);
    if (shift) return shift.id;
  }
  return sale.shift_id || null;
}

/**
 * Core: validates and stores one payment against a locked sale row. Returns the payment.
 * `input`: { method, amount, tendered, reference, mpesa_transaction_id, client_uuid }
 */
async function applyPayment(db, user, sale, input) {
  if (sale.status === 'void') throw ApiError.conflict('This sale was voided');
  if (sale.sale_type === 'credit_note') throw ApiError.conflict('Payments cannot be added to a credit note');

  const balance = balanceOf(sale);
  if (balance <= EPS) throw ApiError.conflict('This sale is already fully paid', undefined, 'already_paid');

  const method = input.method;
  const amount = round2(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw ApiError.unprocessable('amount must be greater than 0');

  let applied = amount;
  let tendered = null;
  let change = 0;
  let reference = input.reference ? String(input.reference).trim() : null;
  let mpesaTx = null;

  if (method === 'cash') {
    // The cashier may type what the customer handed over: only the balance is applied, the rest is change.
    applied = Math.min(amount, balance);
    tendered = input.tendered !== undefined && input.tendered !== null && input.tendered !== ''
      ? round2(Number(input.tendered))
      : amount;
    if (!Number.isFinite(tendered) || tendered + EPS < applied) {
      throw ApiError.unprocessable('The amount handed over is less than the amount being paid');
    }
    change = round2(Math.max(tendered - applied, 0));
  } else {
    if (amount > balance + EPS) {
      throw ApiError.unprocessable(`Only ${balance.toFixed(2)} is still due on this sale`, { balance_due: balance });
    }
    applied = Math.min(amount, balance);
  }

  if (method === 'mpesa') {
    if (input.mpesa_transaction_id) {
      const { rows } = await db.query('SELECT * FROM mpesa_transactions WHERE id = $1 FOR UPDATE', [input.mpesa_transaction_id]);
      mpesaTx = rows[0];
      if (!mpesaTx) throw ApiError.notFound('M-Pesa transaction not found');
      if (mpesaTx.status !== 'success') throw ApiError.conflict('That M-Pesa payment was not completed');
      if (mpesaTx.sale_id && mpesaTx.sale_id !== sale.id) throw ApiError.conflict('That M-Pesa payment belongs to another sale');
      if (await Payment.findOne(db, { mpesa_transaction_id: mpesaTx.id })) {
        throw ApiError.conflict('That M-Pesa payment has already been recorded', undefined, 'duplicate_payment');
      }
      if (applied > Number(mpesaTx.amount) + EPS) {
        throw ApiError.unprocessable(`That M-Pesa payment was only ${Number(mpesaTx.amount).toFixed(2)}`);
      }
      reference = reference || mpesaTx.mpesa_receipt || null;
    } else {
      // typed in by hand from the customer's SMS: the receipt code is the proof
      if (!reference) throw ApiError.unprocessable('Enter the M-Pesa receipt code');
      reference = reference.toUpperCase();
      if (await MpesaTransaction.findByReceipt(db, reference)) {
        throw ApiError.conflict(
          'That receipt code was already received by the till. Use the unmatched M-Pesa payments list to attach it.',
          undefined, 'use_claim'
        );
      }
    }
  }

  if (method === 'credit') {
    if (!sale.customer_id) throw ApiError.unprocessable('Choose a customer to sell on credit', undefined, 'customer_required');
    const { rows } = await db.query('SELECT * FROM customers WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [sale.customer_id]);
    const customer = rows[0];
    if (!customer) throw ApiError.unprocessable('That customer no longer exists');
    if (!Customer.canExtendCredit(customer, applied)) {
      const room = Math.max(Number(customer.credit_limit) - Number(customer.balance), 0);
      throw ApiError.unprocessable(
        `${customer.name} can only take ${room.toFixed(2)} more on credit`,
        { credit_limit: customer.credit_limit, balance: customer.balance },
        'credit_limit_exceeded'
      );
    }
  }

  const payment = await Payment.create(db, {
    sale_id: sale.id,
    client_uuid: input.client_uuid || undefined,
    method,
    amount: applied,
    tendered: tendered === null ? undefined : tendered,
    change_given: change,
    reference: reference || undefined,
    mpesa_transaction_id: mpesaTx ? mpesaTx.id : input.mpesa_transaction_id || undefined,
    status: 'completed',
    shift_id: (await shiftFor(db, user, sale)) || undefined,
    received_by: user ? user.id : undefined,
  });

  if (method === 'credit') {
    await CustomerLedger.create(db, {
      customer_id: sale.customer_id,
      entry_type: 'credit_sale',
      amount: Math.abs(applied),
      sale_id: sale.id,
      payment_id: payment.id,
      created_by: user ? user.id : null,
      note: sale.sale_number,
    });
  }
  if (mpesaTx && !mpesaTx.sale_id) await MpesaTransaction.attachToSale(db, mpesaTx.id, sale.id);

  return payment;
}

/** POST /sales/:id/payments */
async function addPayment(db, user, saleId, input) {
  if (input.client_uuid) {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pay:${input.client_uuid}`]);
    const existing = await Payment.findByClientUuid(db, input.client_uuid);
    if (existing) {
      return { sale: await Sale.getFull(db, existing.sale_id), payment: existing, replayed: true };
    }
  }

  const sale = await lockSale(db, saleId);
  const payment = await applyPayment(db, user, sale, input);
  await Sale.refreshPaymentTotals(db, sale.id);

  const SaleService = require('./SaleService'); // lazy: SaleService requires this file
  await SaleService.afterPayment(db, user, sale.id);

  return { sale: await Sale.getFull(db, sale.id), payment, replayed: false };
}

/** Used while a sale is being created. `sale` is the row just inserted (already locked by us). */
async function recordMany(db, user, sale, payments) {
  let current = sale;
  const out = [];
  for (const p of payments) {
    const payment = await applyPayment(db, user, current, p);
    out.push(payment);
    current = await Sale.refreshPaymentTotals(db, sale.id);
  }
  return { payments: out, sale: current };
}

/**
 * A successful M-Pesa payment (STK Push or till) becomes a payment on the sale.
 * user may be null (Safaricom callback). Returns { payment, sale } or { payment: null, reason }.
 * Safe to call twice for the same transaction.
 */
async function recordMpesaReceipt(db, user, { sale_id, transaction }) {
  const existing = await Payment.findOne(db, { mpesa_transaction_id: transaction.id });
  if (existing) return { payment: existing, sale: await Sale.findById(db, existing.sale_id), duplicate: true };

  const sale = await lockSale(db, sale_id);
  if (sale.status === 'void') return { payment: null, reason: 'The sale was voided' };
  const balance = balanceOf(sale);
  if (balance <= EPS) return { payment: null, reason: 'The sale is already fully paid' };

  const amount = Math.min(Number(transaction.amount), balance);
  const payment = await applyPayment(db, user, sale, {
    method: 'mpesa',
    amount,
    reference: transaction.mpesa_receipt || `STK-${String(transaction.checkout_request_id || transaction.id).slice(-12)}`,
    mpesa_transaction_id: transaction.id,
  });
  const updated = await Sale.refreshPaymentTotals(db, sale.id);

  const SaleService = require('./SaleService');
  await SaleService.afterPayment(db, user, sale.id);
  return { payment, sale: updated, overpaid: round2(Number(transaction.amount) - amount) };
}

module.exports = { addPayment, applyPayment, recordMany, recordMpesaReceipt, balanceOf };
