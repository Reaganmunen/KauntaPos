'use strict';

/**
 * Public M-Pesa webhooks, called by Safaricom (mounted at /hooks/pay). No login: the secret token
 * in the URL identifies the shop's configuration. The paths avoid the words "mpesa" and
 * "safaricom" because Daraja rejects them when registering C2B URLs.
 */
const express = require('express');
const { rateLimit, mpesaWebhookGuard } = require('../middleware');
const mpesa = require('../controllers/mpesaController');

const router = express.Router();

router.use(rateLimit.webhook);
router.post('/:token/stk', mpesaWebhookGuard, mpesa.stkCallback);
router.post('/:token/validation', mpesaWebhookGuard, mpesa.c2bValidation);
router.post('/:token/confirmation', mpesaWebhookGuard, mpesa.c2bConfirmation);

module.exports = router;
