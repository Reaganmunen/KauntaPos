'use strict';

const BaseModel = require('./BaseModel');

class Brand extends BaseModel {
  static table = 'brands';
  static columns = ['name'];
  static defaultOrder = 'name ASC';

  static async findOrCreateByName(db, name) {
    const clean = String(name).trim();
    const existing = await this.findOne(db, { name: clean });
    return existing || this.create(db, { name: clean });
  }
}

module.exports = Brand;
