'use strict';

const BaseModel = require('./BaseModel');

class Unit extends BaseModel {
  static table = 'units';
  static columns = ['name', 'abbreviation', 'etims_unit_code'];
  static defaultOrder = 'name ASC';

  static async findByAbbreviation(db, abbreviation) {
    return this.findOne(db, { abbreviation });
  }
}

module.exports = Unit;
