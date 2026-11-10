'use strict';

const BaseModel = require('./BaseModel');

class PosTerminal extends BaseModel {
  static table = 'pos_terminals';
  static columns = ['branch_id', 'name', 'device_id', 'last_seen_at', 'is_active'];
  static defaultOrder = 'name ASC';

  static async findByDevice(db, deviceId) {
    return this.findOne(db, { device_id: deviceId });
  }

  static async forBranch(db, branchId) {
    return this.findAll(db, { filters: { branch_id: branchId, is_active: true } });
  }

  static async touch(db, id) {
    await db.query('UPDATE pos_terminals SET last_seen_at = now() WHERE id = $1', [id]);
  }
}

module.exports = PosTerminal;
