'use strict';

const BaseModel = require('./BaseModel');

class Plan extends BaseModel {
  static table = 'plans';
  static tenantScoped = false;
  static columns = [
    'code', 'name', 'price_monthly', 'price_yearly', 'currency',
    'max_branches', 'max_users', 'max_products', 'features', 'is_active',
  ];
  static jsonColumns = ['features'];
  static defaultOrder = 'price_monthly ASC';

  static async findByCode(db, code) {
    return this.findOne(db, { code });
  }

  static async listActive(db) {
    return this.findAll(db, { filters: { is_active: true } });
  }
}

module.exports = Plan;
