'use strict';

/**
 * Kaunta staff panel (mounted at /platform). Separate token, secret and audience from shop
 * logins; optionally limited to office IPs with PLATFORM_ALLOWED_IPS. These routes use the admin
 * database connection, which bypasses tenant isolation, so they must never sit behind shop auth.
 */
const express = require('express');
const { authenticatePlatform, rateLimit } = require('../middleware');
const ctl = require('../controllers/platformController');

const router = express.Router();

router.post('/login', rateLimit.login, ctl.login);

router.use(rateLimit.platform, authenticatePlatform);

router.get('/me', ctl.me);
router.get('/stats', ctl.stats);

router.get('/tenants', ctl.listTenants);
router.get('/tenants/:id', ctl.getTenant);
router.put('/tenants/:id/status', ctl.setTenantStatus);
router.post('/tenants/:id/extend-trial', ctl.extendTrial);
router.put('/tenants/:id/plan', ctl.changePlan);

router.get('/plans', ctl.listPlans);
router.post('/plans', ctl.createPlan);
router.patch('/plans/:id', ctl.updatePlan);

router.get('/payments', ctl.listPayments);
router.post('/payments', ctl.recordPayment);
router.post('/payments/:id/confirm', ctl.confirmPayment);
router.post('/payments/:id/reject', ctl.rejectPayment);

module.exports = router;
