'use strict';

/**
 * /tenant: the shop's own account: profile, settings, modules, domains, subscription.
 * Billing (subscription payments) is owner-only. The plans list and the subscription status stay
 * open to every logged-in user so the app can show the "trial ends in N days" banner.
 */
const express = require('express');
const { can, requireOwner } = require('../middleware');
const ctl = require('../controllers/tenantController');

const router = express.Router();

router.get('/', ctl.getProfile);
router.patch('/', can('settings.manage'), ctl.updateProfile);
router.patch('/settings', can('settings.manage'), ctl.mergeSettings);

// get-started checklist (the dashboard card)
router.get('/onboarding', can('settings.manage'), ctl.getOnboarding);
router.post('/onboarding/dismiss', can('settings.manage'), ctl.dismissOnboarding);

// modules
router.get('/features', ctl.getFeatures);
router.put('/features', can('settings.manage'), ctl.setFeatures);

// custom domains
router.get('/domains', can('settings.manage'), ctl.listDomains);
router.post('/domains', can('settings.manage'), ctl.addDomain);
router.post('/domains/:id/verify', can('settings.manage'), ctl.verifyDomain);
router.post('/domains/:id/primary', can('settings.manage'), ctl.setPrimaryDomain);
router.delete('/domains/:id', can('settings.manage'), ctl.removeDomain);

// subscription
router.get('/plans', ctl.listPlans);
router.get('/subscription', ctl.getSubscription);
router.get('/subscription/payments', requireOwner, ctl.listPayments);
router.post('/subscription/payments', requireOwner, ctl.submitPayment);

module.exports = router;
