'use strict';

/**
 * The "Get started" checklist on the dashboard. Nothing is stored per step: every step is worked
 * out from real data each time, so it ticks itself off the moment the shop does the thing.
 *
 *   products   at least one product exists
 *   first_sale at least one till sale exists (voiding it later does not untick the step)
 *   mpesa      at least one active M-Pesa configuration is saved
 *   etims      the Digitax connection is saved and verified. Only listed for shops that need it:
 *              VAT-registered, a KRA PIN on file, or an eTIMS connection already started
 *   storefront the online store is published, or the owner has added a tagline, logo, announcement
 *              or contact details. Optional.
 *              Only listed when the storefront module is on for the shop
 *
 * The only thing stored is tenants.settings.onboarding_dismissed (the owner closed the card).
 * `complete` means every listed step is done; the dashboard hides the card when it is true.
 */
const { Tenant, TenantFeature } = require('../models');

const exists = async (db, sql) => (await db.query(`SELECT EXISTS (${sql}) AS yes`)).rows[0].yes === true;

async function getChecklist(db, tenantId) {
  const tenant = await Tenant.findById(db, tenantId);
  const settings = (tenant && tenant.settings) || {};

  const [hasProducts, hasSale, hasMpesa, etims, storefront, storefrontOn] = await Promise.all([
    exists(db, 'SELECT 1 FROM products WHERE deleted_at IS NULL'),
    exists(db, "SELECT 1 FROM sales WHERE channel = 'pos' AND sale_type <> 'credit_note'"),
    exists(db, 'SELECT 1 FROM mpesa_configs WHERE is_active'),
    db.query('SELECT is_active, api_key_enc IS NOT NULL AS has_key FROM tenant_etims_config LIMIT 1'),
    db.query('SELECT is_published, tagline, logo_url, announcement, contact_phone, whatsapp_number, address FROM storefront_settings LIMIT 1'),
    TenantFeature.isEnabled(db, 'storefront'),
  ]);

  const etimsRow = etims.rows[0];
  const etimsNeeded = Boolean(tenant && (tenant.vat_registered || tenant.kra_pin)) || Boolean(etimsRow);
  const store = storefront.rows[0];

  const steps = [
    {
      key: 'products', title: 'Add your products and prices', optional: false, done: hasProducts,
      hint: 'The one thing you need before you can sell. Add them one by one, or import many at once.',
      href: 'products.html', cta: 'Add products',
    },
    {
      key: 'first_sale', title: 'Make a test sale in cash', optional: false, done: hasSale,
      hint: 'Works straight away, no setup. See how a sale and receipt look.',
      href: 'test-sale.html', cta: 'Make a test sale',
    },
    {
      key: 'mpesa', title: 'Connect M-Pesa', optional: false, done: hasMpesa,
      hint: 'Take payments by till or paybill and match them to sales automatically.',
      href: 'mpesa.html', cta: 'Connect M-Pesa',
    },
  ];
  if (etimsNeeded) {
    steps.push({
      key: 'etims', title: 'Set up eTIMS', optional: false,
      done: Boolean(etimsRow && etimsRow.is_active && etimsRow.has_key),
      hint: 'Send every sale to KRA as an eTIMS receipt.',
      href: 'etims.html', cta: 'Set up eTIMS',
    });
  }
  if (storefrontOn) {
    steps.push({
      key: 'storefront', title: 'Customize your online store', optional: true,
      done: Boolean(store && (store.is_published || store.tagline || store.logo_url || store.announcement ||
        store.contact_phone || store.whatsapp_number || store.address)),
      hint: 'Optional. Add your name, logo and details, then put your shop online.',
      href: 'storefront.html', cta: 'Customize store',
    });
  }

  const done = steps.filter((s) => s.done).length;
  return {
    steps,
    done,
    total: steps.length,
    complete: done === steps.length,
    dismissed: settings.onboarding_dismissed === true,
    etims_hidden: !etimsNeeded, // lets the dashboard offer "my shop is VAT-registered"
  };
}

module.exports = { getChecklist };
