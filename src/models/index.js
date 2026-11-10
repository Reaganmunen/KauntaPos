'use strict';

module.exports = {
  // platform
  Plan: require('./Plan'),
  Tenant: require('./Tenant'),
  TenantDomain: require('./TenantDomain'),
  TenantFeature: require('./TenantFeature'),
  SubscriptionPayment: require('./SubscriptionPayment'),
  PlatformAdmin: require('./PlatformAdmin'),

  // tenant structure and auth
  Branch: require('./Branch'),
  Role: require('./Role'),
  User: require('./User'),
  RefreshToken: require('./RefreshToken'),
  UserToken: require('./UserToken'),
  PosTerminal: require('./PosTerminal'),
  DocumentSequence: require('./DocumentSequence'),
  AuditLog: require('./AuditLog'),

  // catalog
  TaxClass: require('./TaxClass'),
  Category: require('./Category'),
  Brand: require('./Brand'),
  Unit: require('./Unit'),
  Product: require('./Product'),
  ProductVariant: require('./ProductVariant'),
  ProductImage: require('./ProductImage'),
  ProductPharma: require('./ProductPharma'),
  PriceList: require('./PriceList'),
  ModifierGroup: require('./ModifierGroup'),
  Modifier: require('./Modifier'),
  RecipeItem: require('./RecipeItem'),

  // people
  Customer: require('./Customer'),
  CustomerLedger: require('./CustomerLedger'),
  Supplier: require('./Supplier'),

  // inventory and purchasing
  StockLevel: require('./StockLevel'),
  StockBatch: require('./StockBatch'),
  StockMovement: require('./StockMovement'),
  StockTransfer: require('./StockTransfer'),
  StockCount: require('./StockCount'),
  PurchaseOrder: require('./PurchaseOrder'),
  ExpenseCategory: require('./ExpenseCategory'),
  Expense: require('./Expense'),

  // sales
  DiningTable: require('./DiningTable'),
  Shift: require('./Shift'),
  Sale: require('./Sale'),
  Payment: require('./Payment'),
  PrescriptionRecord: require('./PrescriptionRecord'),

  // M-Pesa and eTIMS
  MpesaConfig: require('./MpesaConfig'),
  MpesaTransaction: require('./MpesaTransaction'),
  TenantEtimsConfig: require('./TenantEtimsConfig'),
  EtimsInvoice: require('./EtimsInvoice'),

  // storefront
  StorefrontSettings: require('./StorefrontSettings'),
  StorefrontBanner: require('./StorefrontBanner'),
  StorefrontPage: require('./StorefrontPage'),
  DeliveryZone: require('./DeliveryZone'),
  Cart: require('./Cart'),
  OnlineOrder: require('./OnlineOrder'),
  StockReservation: require('./StockReservation'),

  BaseModel: require('./BaseModel'),
};
