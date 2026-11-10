'use strict';

/**
 * /auth: sign up, log in, token refresh, password recovery.
 * Public routes work out the shop from the subdomain / X-Tenant header, or from `shop` in the
 * body (see authController). These routes are NOT behind the subscription gate: a shop whose trial
 * ended must still be able to log in and pay.
 */
const express = require('express');
const { rateLimit, resolveTenant, tenantFromToken, authenticate } = require('../middleware');
const ctl = require('../controllers/authController');

const router = express.Router();

router.post('/register', rateLimit.register, ctl.register);

router.post('/login', rateLimit.login, resolveTenant(), ctl.login);
router.post('/pin-login', rateLimit.login, resolveTenant(), ctl.pinLogin);
router.post('/refresh', rateLimit.auth, resolveTenant(), ctl.refresh);
router.post('/logout', rateLimit.auth, resolveTenant(), tenantFromToken, ctl.logout);

router.post('/forgot-password', rateLimit.recovery, resolveTenant(), ctl.forgotPassword);
router.post('/reset-password', rateLimit.recovery, resolveTenant(), ctl.resetPassword);

router.get('/me', rateLimit.auth, resolveTenant(), authenticate, ctl.me);
router.post('/change-password', rateLimit.auth, resolveTenant(), authenticate, ctl.changePassword);

module.exports = router;
