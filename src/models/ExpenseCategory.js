'use strict';

const BaseModel = require('./BaseModel');

class ExpenseCategory extends BaseModel {
  static table = 'expense_categories';
  static columns = ['name'];
  static defaultOrder = 'name ASC';
}

module.exports = ExpenseCategory;
