'use strict';

/** Payments against an existing sale (part payments, settling a restaurant tab, paying a credit sale). */
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/respond');
const { requireFields, oneOf, positive } = require('../utils/validate');
const { run } = require('../utils/context');
const { audit } = require('../utils/audit');
const { Payment } = require('../models');
const PaymentService = require('../services/PaymentService');

const METHODS = ['cash', 'mpesa', 'card', 'bank_transfer', 'credit', 'voucher', 'other'];

// GET /sales/:id/payments
exports.listForSale = asyncHandler(async (req, res) => {
  const rows = await run(req, (db) => Payment.forSale(db, req.params.id));
  return ok(res, rows);
});

// POST /sales/:id/payments
// { client_uuid, method, amount, tendered (cash), reference, mpesa_transaction_id }
// Cash: change is worked out from `tendered`. M-Pesa: link a received payment with mpesa_transaction_id
// (STK Push and till payments are matched through the M-Pesa endpoints). Credit: needs a customer
// on the sale and respects their credit limit.
exports.add = asyncHandler(async (req, res) => {
  requireFields(req.body, ['method', 'amount']);
  oneOf(req.body.method, METHODS, 'method');
  positive(req.body.amount, 'amount');

  const result = await run(req, async (db) => {
    const outcome = await PaymentService.addPayment(db, req.user, req.params.id, req.body);
    await audit(db, req, 'payment.add', 'sale', req.params.id, {
      method: req.body.method,
      amount: req.body.amount,
    });
    return outcome; // { sale, payment, replayed? }
  });
  return (result.replayed ? ok : created)(res, result);
});
