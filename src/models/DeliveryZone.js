'use strict';

const BaseModel = require('./BaseModel');

class DeliveryZone extends BaseModel {
  static table = 'delivery_zones';
  static columns = ['name', 'fee', 'min_order_amount', 'estimated_minutes', 'areas', 'is_active'];  // areas is text[]
  static defaultOrder = 'name ASC';

  static async listActive(db) {
    return this.findAll(db, { filters: { is_active: true } });
  }
}

module.exports = DeliveryZone;
