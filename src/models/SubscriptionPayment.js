'use strict';

const BaseModel = require('./BaseModel');

class SubscriptionPayment extends BaseModel {
  static table = 'subscription_payments';
  static columns = [
    'plan_id', 'amount', 'method', 'mpesa_receipt', 'reference', 'period_start',
    'period_end', 'status', 'confirmed_by', 'confirmed_at', 'notes',
  ];
  static defaultOrder = 'created_at DESC';

  static async listForTenant(db, { page = 1, limit = 25 } = {}) {
    return this.paginate(db, { page, limit });
  }

  /**
   * Manual activation flow (platform admin): confirm the payment and extend the tenant's
   * subscription. Run as the platform/owner role, since it updates the tenants row.
   */
  static async confirmAndActivate(db, id, adminId) {
    const payment = await this.update(db, id, {
      status: 'confirmed',
      confirmed_by: adminId,
      confirmed_at: new Date(),
    });
    if (!payment) return null;

    await db.query(
      `UPDATE tenants
          SET status = 'active',
              plan_id = COALESCE($2, plan_id),
              current_period_start = COALESCE($3::timestamptz, current_period_start),
              current_period_end = COALESCE(($4::date + 1)::timestamptz, current_period_end)
        WHERE id = $1`,
      [payment.tenant_id, payment.plan_id, payment.period_start, payment.period_end]
    );
    return payment;
  }

  static async markFailed(db, id) {
    return this.update(db, id, { status: 'failed' });
  }
}

module.exports = SubscriptionPayment;
