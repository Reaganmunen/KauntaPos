'use strict';

/**
 * What a shop may do right now. One place decides it, so the API gate, the public store, login and
 * the billing screen can never disagree.
 *
 * Access states (worked out from tenants.status and the dates, never from the status alone):
 *
 *   trial           free trial still running                      full access
 *   active          paid, period not over                         full access
 *   grace           period just ended (or marked past_due)        full access, with a "pay now" notice
 *   trial_expired   free trial over                               LOCKED
 *   expired         period over and the grace days are used up    LOCKED
 *   cancelled       cancelled by the shop or by Kaunta            LOCKED
 *   inactive        any status this code does not know            LOCKED
 *   suspended       locked by Kaunta staff                        locked out, except the payment screens
 *
 * LOCKED means staff can log in but see only the pay screen: every other API request is refused with
 * 402 subscription_expired until a payment is confirmed (see middleware/subscription.js).
 *
 *   SUBSCRIPTION_GRACE_DAYS   days of full access after a paid period ends (default 3)
 *   SUBSCRIPTION_PERIOD_DAYS  days one confirmed payment adds (default 30)
 */
const DAY = 86400000;

const graceDays = () => {
  const n = parseInt(process.env.SUBSCRIPTION_GRACE_DAYS || '3', 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
};

const periodDays = () => {
  const n = parseInt(process.env.SUBSCRIPTION_PERIOD_DAYS || '30', 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
};

const OPERATING = new Set(['trial', 'active', 'grace']);

const time = (value) => {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
};

/** tenants row (or the cached tenant context) -> access state. */
function accessState(tenant, now = Date.now()) {
  if (!tenant) return 'inactive';
  const { status } = tenant;
  if (status === 'suspended') return 'suspended';
  if (status === 'cancelled') return 'cancelled';

  if (status === 'trial') {
    const ends = time(tenant.trial_ends_at);
    return ends === null || ends > now ? 'trial' : 'trial_expired';
  }

  if (status !== 'active' && status !== 'past_due') return 'inactive';

  const end = time(tenant.current_period_end);
  if (end === null) return status === 'past_due' ? 'grace' : 'active'; // no dates recorded: trust the status
  if (now <= end) return status === 'past_due' ? 'grace' : 'active';
  return now <= end + graceDays() * DAY ? 'grace' : 'expired';
}

const canOperate = (state) => OPERATING.has(state);

/**
 * Everything the apps need to show the right notice:
 *   { state, can_operate, locked, read_only (same as locked, kept for older pages), ends_at, days_left, grace_ends_at }
 * days_left is negative once the end date has passed.
 */
function describeAccess(tenant, now = Date.now()) {
  const state = accessState(tenant, now);
  const trial = tenant && tenant.status === 'trial';
  const endsAt = time(trial ? tenant.trial_ends_at : tenant && tenant.current_period_end);
  const graceEnds = !trial && endsAt !== null ? endsAt + graceDays() * DAY : null;
  return {
    state,
    can_operate: canOperate(state),
    locked: !canOperate(state),
    read_only: !canOperate(state) && state !== 'suspended',
    ends_at: endsAt === null ? null : new Date(endsAt).toISOString(),
    days_left: endsAt === null ? null : Math.ceil((endsAt - now) / DAY),
    grace_ends_at: graceEnds === null ? null : new Date(graceEnds).toISOString(),
  };
}

// What the API says to a locked shop.
const LOCKED_MESSAGES = {
  trial_expired: 'Your free trial has ended. Subscribe to continue.',
  expired: 'Your subscription has ended. Renew to continue.',
  cancelled: 'Your subscription is cancelled. Subscribe again to continue.',
  inactive: 'Your subscription is not active. Renew to continue.',
};

// ---------- plan modules ----------

// Modules a shop owner may switch on and off (kept here so the plan check and the toggle agree).
const MODULES = [
  'batch_expiry', 'prescriptions', 'restaurant', 'modifiers', 'recipes',
  'variants', 'storefront', 'credit_sales', 'multi_branch',
];

/**
 * Does the plan include this module? Plans list what they leave out in plans.features:
 *   { "restaurant": false, "storefront": false }
 * A module that is not mentioned is included. No plan (older shops) means nothing is held back.
 */
function planAllows(plan, key) {
  if (!plan) return true;
  const features = plan.features;
  if (!features || typeof features !== 'object' || Array.isArray(features)) return true;
  return features[key] !== false;
}

/** Add-ons that exist only when the plan lists them as true (e.g. custom_domain). */
function planHas(plan, key) {
  return Boolean(plan && plan.features && typeof plan.features === 'object' && plan.features[key]);
}

/** { restaurant: true, ... } as the shop switched it, minus what the plan does not include. */
function effectiveFeatures(flags, plan) {
  const out = {};
  for (const [key, value] of Object.entries(flags || {})) {
    out[key] = value === true && planAllows(plan, key);
  }
  return out;
}

module.exports = {
  accessState,
  canOperate,
  describeAccess,
  LOCKED_MESSAGES,
  MODULES,
  planAllows,
  planHas,
  effectiveFeatures,
  graceDays,
  periodDays,
};
