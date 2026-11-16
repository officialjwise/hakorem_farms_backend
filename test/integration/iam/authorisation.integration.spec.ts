import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATION_METADATA, type OperationSpec } from '../../../src/platform/http/operation';
import {
  consoleGet,
  consolePost,
  createBranch,
  createUser,
  enrolAndLogin,
  login,
  relaxRateLimits,
  testStartTime,
  type RoleCode,
  type TestBranch,
} from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

interface RouteInfo {
  readonly method: string;
  readonly path: string;
  readonly handler: string;
  readonly spec: OperationSpec | undefined;
}

let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let dodowa: TestBranch;
let routes: RouteInfo[];

/** Every route of every controller the application mounted, with the operation it declares. */
function registeredRoutes(): RouteInfo[] {
  const found: RouteInfo[] = [];
  for (const module of api.app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const type = wrapper.metatype as (new (...args: never[]) => object) | null;
      if (type === null) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, type) ?? '');
      for (const name of Object.getOwnPropertyNames(type.prototype)) {
        const handler = (type.prototype as Record<string, unknown>)[name];
        if (name === 'constructor' || typeof handler !== 'function' || Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number]!;
        const path = `/v1/${[base, String(Reflect.getMetadata(PATH_METADATA, handler))].filter((p) => p !== '' && p !== '/').join('/')}`.replace(/\/+/g, '/');
        found.push({ method, path, handler: `${type.name}.${name}`, spec: Reflect.getMetadata(OPERATION_METADATA, handler) as OperationSpec | undefined });
      }
    }
  }
  return found;
}

/** A body that passes validation for each state-changing operation, so the refusal seen is the permission's. */
const VALID_BODY: Readonly<Record<string, object>> = {
  initiateMobileMoneyCharge: { id: randomUUID(), amountPesewas: 50_000, payerPhone: '+233244512876', network: 'MTN' },
  allocatePayment: { allocations: [{ billingDocumentId: randomUUID(), amountPesewas: 1_000 }] },
  unallocatePayment: { allocationId: randomUUID(), reason: 'Applied to the wrong invoice' },
  requestRefund: { originalPaymentId: randomUUID(), amountPesewas: 1_000, destination: 'ORIGINAL_METHOD', reasonCode: 'OVERCHARGED', note: 'Weighed short' },
  markRefundPaid: { paidAt: '2026-11-16T10:00:00Z', externalReference: 'MTN-REV-0001' },
  recordPayment: { id: randomUUID(), paymentMethodId: randomUUID(), amountPesewas: 100_000, receivedAt: '2026-11-16T09:00:00Z' },
  reversePayment: { reasonCode: 'CHEQUE_DISHONOURED', note: 'Returned by the bank unpaid' },
  clearCheque: { clearedOn: '2026-11-16' },
  importSettlementReport: { provider: 'PAYSTACK', fileId: randomUUID(), bankAccountId: randomUUID() },
  importBankStatement: { bankAccountId: randomUUID(), fileId: randomUUID(), periodStart: '2026-11-01', periodEnd: '2026-11-15' },
  matchBankStatementLine: { paymentId: randomUUID() },
  resolveReconciliationBreak: { note: 'Checked against the bank' },
  generateDeliverySlots: { zoneId: randomUUID(), from: '2026-12-01', to: '2026-12-07', weekdays: [2], times: [{ startsAt: '10:00', endsAt: '12:00', capacity: 8 }] },
  updateDeliverySlot: { version: 1, capacity: 10 },
  createAccount: { code: '6110', name: 'Generator fuel', type: 'EXPENSE', isPostable: true },
  updateAccount: { version: 1, name: 'Generator fuel and servicing' },
  reopenAccountingPeriod: { reason: 'Supplier invoice for October received late' },
  createManualJournal: {
    kind: 'MANUAL',
    postingDate: '2026-11-13',
    description: 'Accrue electricity for the cold room',
    lines: [
      { accountId: randomUUID(), side: 'D', amountPesewas: 65_000 },
      { accountId: randomUUID(), side: 'C', amountPesewas: 65_000 },
    ],
  },
  updateManualJournal: { version: 1, description: 'Accrue electricity for the cold room, November' },
  createPostingRule: { eventCode: 'inv.GoodsReceived', amountKey: 'value', side: 'C', accountId: randomUUID(), validFrom: '2026-12-01' },
  createAccountDetermination: { determinantType: 'TAX_LEVY', determinantKey: 'NHIL', role: 'OUTPUT', accountId: randomUUID(), validFrom: '2027-01-01' },
  createBankAccount: { kind: 'BANK', name: 'Fidelity savings', institution: 'Fidelity Bank', accountNo: '2040016620' },
  updateBankAccount: { version: 1, isActive: false },
  createFixedAsset: { name: 'Chest freezer', category: 'EQUIPMENT', branchId: randomUUID(), acquiredOn: '2026-11-10', costPesewas: 640_000, usefulLifeMonths: 60 },
  updateFixedAsset: { version: 1, name: 'Chest freezer, 300 l' },
  disposeFixedAsset: { disposedOn: '2026-11-10', proceedsPesewas: 0, note: 'Scrapped' },
  issueCreditNote: { reasonCode: 'OVERCHARGED', note: 'Refused', lines: [{ lineId: randomUUID(), amountPesewas: 1 }] },
  issueDebitNote: { reasonCode: 'UNDERCHARGED', note: 'Refused', lines: [{ description: 'Refused', amountPesewas: 1, taxCategoryId: randomUUID() }] },
  createTemplateVersion: { body: '<p>Refused</p>' },
  previewTemplateVersion: { data: { title: 'Refused' } },
  reprintBillingDocument: { channel: 'PDF' },
  createDepreciationRun: { periodId: randomUUID() },
  createProduct: { sku: 'MEAT-GOAT-5KG', name: 'Goat meat, 5 kg pack', categoryId: randomUUID(), stockPolicy: 'CATCH_WEIGHT', baseUom: 'KG', saleUom: 'PACK', onlineMode: 'LISTED' },
  revokeSession: { reason: 'Tablet left unattended overnight' },
  createUser: { displayName: 'Kojo Asante', email: 'kojo.asante@hakoremfarms.test', realm: 'STAFF', grants: [] },
  updateUser: { version: 1, displayName: 'Kojo Asante' },
  disableUser: { reason: 'Left the business' },
  enableUser: { reason: 'Came back' },
  unlockUser: { reason: 'Forgot the password' },
  resetUserPassword: { reason: 'Lost the password' },
  createGrant: { principalId: randomUUID(), roleId: randomUUID(), branchId: randomUUID() },
  revokeGrant: { reason: 'Moved to the farm' },
  resolvePrices: { channel: 'POS', branchId: randomUUID(), lines: [{ lineRef: '1', productId: randomUUID(), quantity: '1.000' }] },
  createPriceList: { code: 'BASE', name: 'Base prices', kind: 'BASE', taxInclusive: true },
  createPriceListVersion: { validFrom: '2026-12-01T00:00:00Z' },
  replacePriceListEntries: { version: 1, entries: [] },
  createTaxLevy: { code: 'TOURISM', name: 'Tourism Levy' },
  createTaxCategory: { code: 'SEEDS', name: 'Seeds and seedlings' },
  createTaxSchemeVersion: { validFrom: '2026-12-01', sourceNote: 'Rates from the accountant' },
  replaceTaxSchemeCells: { version: 1, cells: [] },
  calculateTax: { taxInclusive: false, taxDate: '2026-12-01', lines: [{ lineRef: '1', taxCategoryId: randomUUID(), amountPesewas: 100 }] },
  createPromotion: { code: 'XMAS-CHICKEN', name: 'Christmas chicken', kind: 'PERCENT_OFF', percentOff: '5', appliesTo: 'LINE', validFrom: '2026-12-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z', targets: [{ productId: randomUUID() }] },
  updatePromotion: { version: 1, name: 'Christmas chicken' },
  endPromotion: { reason: 'Stock ran out' },
  createCoupon: { code: 'XMAS-26' },
  createCategory: { code: 'SEASONAL', name: 'Seasonal produce', productLine: 'PRODUCE', glGroup: 'PRODUCE_EGGS', taxCategoryId: randomUUID() },
  updateCategory: { version: 1, name: 'Seasonal' },
  archiveCategory: { version: 1, reason: 'No longer used' },
  createSpecies: { code: 'CATTLE', name: 'Cattle', trackingDefault: 'SERIAL' },
  updateSpecies: { version: 1, name: 'Cattle' },
  createGrade: { speciesId: randomUUID(), code: 'A', name: 'Grade A' },
  updateGrade: { version: 1, name: 'Grade A' },
  archiveGrade: { version: 1, reason: 'No longer used' },
  createWeightBand: { speciesId: randomUUID(), code: 'GOAT-S', minKg: '8.000', maxKg: '18.000' },
  updateWeightBand: { version: 1, maxKg: '19.000' },
  archiveWeightBand: { version: 1, reason: 'No longer used' },
  createUomConversion: { productId: randomUUID(), fromUom: 'BAG', numerator: 50, denominator: 1 },
  archiveUomConversion: { version: 1, reason: 'Supplier now packs 25 kg bags' },
  createPurchaseOrder: { supplierId: randomUUID(), deliverToLocationId: randomUUID(), orderDate: '2026-11-15', lines: [{ productId: randomUUID(), qtyOrdered: '20.000', unitPricePesewas: 5500 }] },
  updatePurchaseOrder: { version: 1, expectedOn: '2026-11-20' },
  sendPurchaseOrder: { channels: ['WHATSAPP'] },
  closePurchaseOrder: { reason: 'Supplier ran short' },
  cancelPurchaseOrder: { reason: 'Supplier ran short' },
  createSupplierInvoice: {
    kind: 'INVOICE',
    supplierId: randomUUID(),
    supplierInvoiceNo: 'APF-0088',
    invoiceDate: '2026-11-15',
    branchId: randomUUID(),
    lines: [{ description: 'Broilers', qty: '20.000', unitPricePesewas: 5500, taxCategoryId: randomUUID() }],
  },
  updateSupplierInvoice: { version: 1, dueDate: '2026-11-30' },
  cancelSupplierInvoice: { reason: 'Entered twice' },
  requestSupplierInvoiceVariance: { reason: 'Awutu raised the price after the order' },
  createSupplierPayment: { supplierId: randomUUID(), method: 'MOBILE_MONEY', allocations: [{ supplierInvoiceId: randomUUID(), amountPesewas: 110000 }] },
  markSupplierPaymentPaid: { paidAt: '2026-11-15T10:00:00Z', externalReference: 'MOMO-7781' },
  cancelSupplierPayment: { reason: 'Paid in cash instead' },
  updateSupplierProfile: { version: 1, paymentTermsDays: 14 },
  addSupplierDocument: { kind: 'HEALTH_CERTIFICATE', fileId: randomUUID(), expiresOn: '2027-02-28' },
  createPurchaseRequisition: { lines: [{ productId: randomUUID(), qty: '20.000' }] },
  updatePurchaseRequisition: { version: 1, justification: 'Brooder pen 2 is empty' },
  rejectPurchaseRequisition: { reason: 'Bought at the market last week' },
  convertPurchaseRequisition: { supplierId: randomUUID(), deliverToLocationId: randomUUID(), lines: [{ lineId: randomUUID(), unitPricePesewas: 5500 }] },
  updateSetting: { value: 150000, version: 0 },
  updateProduct: { version: 1, name: 'Goat' },
  createBranch: { code: 'KSI', name: 'Kumasi' },
  updateBranch: { version: 1, name: 'Kumasi' },
  createLocation: { branchId: '01900000-0000-7000-8000-00000000f001', code: 'PEN2', name: 'Pen', kind: 'PEN' },
  updateLocation: { version: 1, name: 'Pen' },
  createGoodsReceipt: { kind: 'HARVEST', locationId: randomUUID(), receivedAt: '2026-11-10T07:00:00Z', lines: [] },
  updateGoodsReceipt: { version: 1, notes: 'Two birds died on the road' },
  cancelGoodsReceipt: { reason: 'Delivery turned back at the gate' },
  reverseStockMovement: { reasonCode: 'COUNT_ERROR', note: 'Posted twice from the cold room tablet' },
  createStockTransfer: { fromLocationId: randomUUID(), toLocationId: randomUUID(), lines: [] },
  receiveStockTransfer: { lines: [] },
  cancelStockTransfer: { reason: 'Van not available' },
  createStockAdjustment: { locationId: randomUUID(), reasonCode: 'COUNT_ERROR', lines: [] },
  createStockTake: { locationId: randomUUID(), scope: 'FULL' },
  recordStockTakeCounts: { counts: [] },
  cancelStockTake: { reason: 'Refused' },
  createStockHold: { stockUnitId: '019a7a91-2f3b-74f5-9a2d-582bcbe2d109', kind: 'INVESTIGATION', note: 'Refused' },
  releaseStockHold: { reasonCode: 'INVESTIGATION_CLOSED', note: 'Refused' },
  resolveStockException: { resolutionKind: 'WRITE_OFF', note: 'Refused' },
  releaseStockReservation: { reason: 'Refused' },
  createReorderRule: { productId: '019a7a8e-e37e-7913-ae4c-9a0dc3bf12eb', branchId: '019a7a83-2aef-79e3-9f1b-a708a7ae1fe6', minQty: '10.000', reorderPointQty: '15.000', maxQty: '60.000' },
  updateReorderRule: { version: 1, reorderPointQty: '20.000' },
  recordTemperatureReading: { locationId: '019a7a84-4156-72e2-a81a-36fbeee7afd9', readingC: '-18.0', measuredAt: '2026-11-13T10:00:00Z', source: 'MANUAL' },
  archiveLocation: { version: 1, reason: 'Closed' },
  createProcessingOrder: { locationId: randomUUID(), outputLocationId: randomUUID(), inputs: [{ stockUnitId: randomUUID(), weightKg: '28.000', weightSource: 'SCALE' }] },
  updateProcessingOrder: { version: 1 },
  recordProcessingOutputs: { version: 1, outputs: [] },
  addProcessingCost: { costKind: 'LABOUR', amountPesewas: 4000, description: 'Slaughter and dressing' },
  cancelProcessingOrder: { reason: 'Buyer wants the goat live' },
  createYieldStandard: { inputProductId: randomUUID(), outputProductId: randomUUID(), expectedPercent: '48' },
  updateYieldStandard: { version: 1, tolerancePercent: '6' },
  recordWeights: { records: [{ id: randomUUID(), stockUnitId: randomUUID(), weightKg: '18.400', weightSource: 'SCALE', measuredAt: '2026-11-10T08:00:00Z' }] },
  recordHealthEvent: { kind: 'TREATMENT', stockUnitId: randomUUID(), occurredAt: '2026-11-10T08:00:00Z' },
  reportMortality: { kind: 'DEATH', stockUnitId: randomUUID(), reasonCode: 'UNKNOWN_CAUSE', foundAt: '2026-11-10T06:00:00Z' },
  createRation: { name: 'Broiler grower', speciesId: randomUUID(), feedProductId: randomUUID(), qtyPerHeadPerDay: '0.120' },
  updateRation: { version: 1, qtyPerHeadPerDay: '0.130' },
  recordFeedConsumption: { locationId: randomUUID(), feedProductId: randomUUID(), qty: '10.000', consumedOn: '2026-11-10' },
  updateAnimal: { version: 1, purpose: 'BREEDING' },
  moveAnimal: { toLocationId: randomUUID() },
  createBatch: { batchNo: 'BRL-2611-01', speciesId: randomUUID(), startedOn: '2026-11-12', initialHead: 500, purpose: 'GROWING', locationId: randomUUID() },
  updateBatch: { version: 1, purpose: 'LAYING' },
  closeBatch: { reason: 'All birds sold' },
  createBreedingRecord: { damId: randomUUID(), matedOn: '2026-11-10' },
  updateBreedingRecord: { version: 1, status: 'CONFIRMED' },
  recordBirth: { actualBirthOn: '2026-11-02', litterSize: 2, offspring: [{ tagNo: 'G-0181', sex: 'MALE' }] },
  failBreedingRecord: { reason: 'Came back on heat' },
  createPacks: { outputLineNo: 1, packs: [{ weightKg: '15.000', weightSource: 'SCALE' }] },
  printPackLabels: { packIds: [randomUUID()] },
  recordCareHealthEvent: { kind: 'TREATMENT', stockUnitId: randomUUID(), occurredAt: '2026-11-10T08:00:00Z' },
  reportCareMortality: { kind: 'DEATH', stockUnitId: randomUUID(), reasonCode: 'UNKNOWN_CAUSE', foundAt: '2026-11-10T06:00:00Z' },
  recordCareFeedConsumption: { locationId: randomUUID(), feedProductId: randomUUID(), qty: '10.000', consumedOn: '2026-11-10' },
  updateCareAnimal: { version: 1, purpose: 'BREEDING' },
  moveCareAnimal: { toLocationId: randomUUID() },
  createCareBatch: { batchNo: 'BRL-2611-01', speciesId: randomUUID(), startedOn: '2026-11-12', initialHead: 500, purpose: 'GROWING', locationId: randomUUID() },
  updateCareBatch: { version: 1, purpose: 'LAYING' },
  closeCareBatch: { reason: 'All birds sold' },
  createCustomer: { kind: 'INDIVIDUAL', name: 'Ama' },
  updateCustomer: { version: 1, name: 'Ama' },
  archiveCustomer: { version: 1, reason: 'Duplicate' },
  createCustomerTier: { code: 'CATERING', name: 'Catering' },
  createCustomerAddress: { label: 'Home', recipientName: 'Ama', recipientPhone: '0244123456', line1: 'Market', area: 'Dodowa', city: 'Dodowa', region: 'Greater Accra' },
  updateCustomerAddress: { version: 1, label: 'Home' },
  archiveCustomerAddress: { version: 1, reason: 'Moved' },
  assignCustomerPriceList: { priceListId: '01900000-0000-7000-8000-00000000f002', validFrom: '2026-12-01T00:00:00Z' },
  archiveProduct: { version: 1, reason: 'No longer stocked' },
  addProductImage: { fileId: randomUUID(), altText: 'Front view' },
  createImportJob: { entity: 'CUSTOMER', fileId: randomUUID() },
  createExportJob: { entity: 'CUSTOMER', format: 'CSV' },
  updatePriceList: { version: 1, name: 'Base prices' },
  archivePriceList: { version: 1, reason: 'Replaced' },
  createSupplier: { name: 'Ashanti Feeds Ltd' },
  updateSupplier: { version: 1, name: 'Ashanti Feeds Ltd' },
  archiveSupplier: { version: 1, reason: 'Stopped trading' },
  updatePaymentMethod: { version: 1, isEnabled: false },
  createDeliveryZone: { branchId: randomUUID(), code: 'DODOWA', name: 'Dodowa', areas: ['Dodowa'], feePesewas: 1500, cutoffTime: '14:00' },
  updateDeliveryZone: { version: 1, feePesewas: 1500 },
  createRole: { code: 'SHOP_SUPERVISOR', name: 'Shop supervisor', requiresTotp: false, permissions: [] },
  updateRole: { version: 1, name: 'Shop supervisor' },
  rejectRequest: { reason: 'Not a mortality' },
  cancelApprovalRequest: { reason: 'Counted twice' },
};

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  dodowa = await createBranch(database);
  routes = registeredRoutes();
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('deny by default: the handler walk (ADR-0017, security architecture section 14)', () => {
  it('finds the B3, B4, B04 continued, B04d, B04d continued 1 to 3, B04e, B04e continued, B04e continued 2, B04e continued 3, B04e continued 4, B05 continued, B05 continued 3, B05x, B6, B06m, B06 continued, B06 continued 2, B06 continued 3, B06u, B7, B07 continued, B07 continued 1b, B06r, B07 continued 2, B08 continued, B08 continued 1b, B08 continued 1b2, B08 continued 1c, B08 continued 1c2, B08 continued 2, B08 continued 2b, B09a continued, B09a continued 1b and B09a continued 1c routes, and every one declares its operation', () => {
    expect(routes.map((route) => route.spec?.operationId).sort()).toEqual(
      [
        'changePassword', 'confirmTotpEnrolment', 'createProduct', 'getCurrentSession', 'getHealth', 'getProduct', 'listProducts', 'listSessions',
        'loginCustomer', 'loginInvestor', 'loginStaff', 'logout', 'refreshSession', 'revokeSession', 'startTotpEnrolment', 'stepUp', 'verifyTotp',
        'resolvePrices', 'createPriceList', 'getPriceList', 'createPriceListVersion', 'getPriceListVersion', 'replacePriceListEntries', 'submitPriceListVersion',
        'listTaxLevies', 'createTaxLevy', 'listTaxCategories', 'createTaxCategory', 'listTaxSchemeVersions', 'createTaxSchemeVersion', 'getTaxSchemeVersion',
        'replaceTaxSchemeCells', 'submitTaxSchemeVersion', 'calculateTax',
        'listPromotions', 'createPromotion', 'getPromotion', 'updatePromotion', 'submitPromotion', 'endPromotion', 'listCoupons', 'createCoupon', 'validateCoupon',
        'listCategories', 'createCategory', 'getCategory', 'updateCategory', 'archiveCategory', 'listUnitsOfMeasure', 'listSpeciesList', 'createSpecies',
        'updateSpecies', 'listGrades', 'createGrade', 'updateGrade', 'archiveGrade', 'listWeightBands', 'createWeightBand', 'updateWeightBand',
        'archiveWeightBand', 'updateProduct',
        'listBranches', 'createBranch', 'getBranch', 'updateBranch', 'listLocations', 'createLocation', 'getLocation', 'updateLocation', 'archiveLocation',
        'listCustomers', 'createCustomer', 'getCustomer', 'updateCustomer', 'archiveCustomer', 'listCustomerTiers', 'createCustomerTier',
        'listCustomerAddresses', 'createCustomerAddress', 'updateCustomerAddress', 'archiveCustomerAddress', 'assignCustomerPriceList',
        'listSuppliers', 'createSupplier', 'getSupplier', 'updateSupplier', 'archiveSupplier', 'listPaymentMethods', 'updatePaymentMethod',
        'listDeliveryZones', 'createDeliveryZone', 'getDeliveryZone', 'updateDeliveryZone', 'quoteDelivery', 'listReasonCodes',
        'listPriceLists', 'updatePriceList', 'archivePriceList', 'listPriceListVersions', 'listPriceListEntries', 'archiveProduct',
        'listUsers', 'createUser', 'getUser', 'updateUser', 'disableUser', 'enableUser', 'unlockUser', 'resetUserPassword',
        'listRoles', 'getRole', 'listPermissions', 'listGrants', 'createGrant', 'revokeGrant',
        'createRole', 'updateRole', 'listApprovals', 'getApproval', 'approveRequest', 'rejectRequest', 'cancelApprovalRequest',
        'registerCustomer', 'verifyCustomerPhone', 'requestPasswordReset', 'resetPassword',
        'uploadFile', 'getFile', 'createFileSignedUrl',
        'addProductImage', 'removeProductImage',
        'listImportJobs', 'createImportJob', 'getImportJob', 'listImportErrors', 'applyImportJob', 'cancelImportJob', 'createExportJob',
        'listStockOnHand', 'getStockUnit', 'traceStockUnit',
        'listGoodsReceipts', 'createGoodsReceipt', 'getGoodsReceipt', 'updateGoodsReceipt', 'postGoodsReceipt', 'cancelGoodsReceipt',
        'listMovementTypes', 'listStockMovements', 'getStockMovement', 'reverseStockMovement', 'listStockUnitMovements',
        'listStockTransfers', 'createStockTransfer', 'getStockTransfer', 'dispatchStockTransfer', 'receiveStockTransfer', 'cancelStockTransfer',
        'listStockAdjustments', 'createStockAdjustment', 'getStockAdjustment', 'submitStockAdjustment',
        'listStockTakes', 'createStockTake', 'getStockTake', 'startStockTake', 'listStockTakeLines', 'recordStockTakeCounts', 'closeStockTakeCounting',
        'submitStockTake', 'cancelStockTake',
        'listStockHolds', 'createStockHold', 'releaseStockHold',
        'listStockExceptions', 'getStockException', 'resolveStockException',
        'listStockReservations', 'releaseStockReservation', 'listStockAvailability', 'listStockUnits',
        'listReorderRules', 'createReorderRule', 'updateReorderRule', 'listStockAlerts', 'listTemperatureReadings', 'recordTemperatureReading',
        'getOwnerDashboard', 'getStockValueTile', 'getAnimalsOnHandTile', 'getLowStockTile', 'getPurchasesSeries', 'getStockUnitLabel', 'getProductLabel',
        'listProcessingOrders', 'createProcessingOrder', 'getProcessingOrder', 'updateProcessingOrder', 'startProcessingOrder', 'recordProcessingOutputs',
        'addProcessingCost', 'completeProcessingOrder', 'cancelProcessingOrder', 'listYieldStandards', 'createYieldStandard', 'updateYieldStandard',
        'previewPriceListVersion',
        'listAnimals', 'getAnimal', 'listWeightRecords', 'recordWeights', 'listHealthEvents', 'recordHealthEvent', 'getHealthEvent', 'listMortalityRecords',
        'reportMortality', 'getMortalityRecord', 'submitMortalityRecord', 'listRations', 'createRation', 'updateRation', 'listFeedConsumption',
        'recordFeedConsumption', 'getFeedConsumption',
        'updateAnimal', 'moveAnimal', 'listAnimalTimeline', 'listGrowth', 'listBatches', 'createBatch', 'getBatch', 'updateBatch', 'closeBatch',
        'listBreedingRecords', 'createBreedingRecord', 'getBreedingRecord', 'updateBreedingRecord', 'recordBirth', 'failBreedingRecord',
        'listCareAnimals', 'getCareAnimal', 'getCareAnimalByTag', 'updateCareAnimal', 'moveCareAnimal', 'listCareHealthEvents', 'recordCareHealthEvent', 'getCareHealthEvent',
        'reportCareMortality', 'submitCareMortalityRecord', 'listCareRations', 'recordCareFeedConsumption', 'listCareBatches', 'createCareBatch', 'getCareBatch',
        'updateCareBatch', 'closeCareBatch', 'listPacks', 'createPacks', 'printPackLabels',
        'listUomConversions', 'createUomConversion', 'archiveUomConversion',
        'listPurchaseOrders', 'createPurchaseOrder', 'getPurchaseOrder', 'updatePurchaseOrder', 'submitPurchaseOrder', 'sendPurchaseOrder', 'closePurchaseOrder',
        'cancelPurchaseOrder', 'listSupplierInvoices', 'createSupplierInvoice', 'getSupplierInvoice', 'updateSupplierInvoice', 'matchSupplierInvoice',
        'approveSupplierInvoice', 'cancelSupplierInvoice', 'listSupplierPayments', 'createSupplierPayment', 'getSupplierPayment', 'submitSupplierPayment',
        'markSupplierPaymentPaid', 'cancelSupplierPayment',
        'getSupplierProfile', 'updateSupplierProfile', 'getSupplierPayoutDetails', 'listSupplierDocuments', 'addSupplierDocument',
        'listPurchaseRequisitions', 'createPurchaseRequisition', 'getPurchaseRequisition', 'updatePurchaseRequisition', 'submitPurchaseRequisition',
        'rejectPurchaseRequisition', 'convertPurchaseRequisition', 'updateSetting',
        'submitSupplierCreditNote', 'requestSupplierInvoiceVariance', 'getSupplierPaymentRemittance', 'listSupplierScores',
        'listDeliverySlots', 'generateDeliverySlots', 'updateDeliverySlot',
        'listCatalogue', 'getCatalogueProduct', 'listShopCategories', 'createCart', 'getCart', 'addCartLine', 'updateCartLine', 'removeCartLine',
        'applyCartCoupon', 'removeCartCoupon', 'listDeliverySlotOptions', 'startCheckout', 'getCheckout', 'updateCheckout',
        'listAccounts', 'createAccount', 'updateAccount', 'listAccountingPeriods', 'lockAccountingPeriod', 'closeAccountingPeriod', 'reopenAccountingPeriod',
        'listJournalEntries', 'getJournalEntry', 'listAccountActivity', 'listManualJournals', 'createManualJournal', 'getManualJournal', 'updateManualJournal',
        'submitManualJournal', 'listPostingEventTypes', 'listPostingRules', 'createPostingRule', 'listAccountDeterminations', 'createAccountDetermination',
        'listBankAccounts', 'createBankAccount', 'updateBankAccount',
        'getTrialBalance', 'getProfitAndLoss', 'getBalanceSheet', 'getCashFlow', 'getCashPositionTile',
        'listFixedAssets', 'createFixedAsset', 'getFixedAsset', 'updateFixedAsset', 'disposeFixedAsset',
        'listDepreciationRuns', 'createDepreciationRun', 'getDepreciationRun', 'postDepreciationRun',
        'listBillingDocuments', 'getBillingDocument', 'issueCreditNote', 'issueDebitNote', 'getReceivablesTile',
        'listDocumentTemplates', 'getDocumentTemplate', 'listTemplateVersions', 'createTemplateVersion', 'getTemplateVersion', 'activateTemplateVersion',
        'listArchivedDocuments', 'getArchivedDocument', 'downloadArchivedDocument', 'reprintBillingDocument', 'listBillingDocumentReprints',
        'previewTemplateVersion',
        'listPayments', 'getPayment', 'initiateMobileMoneyCharge', 'checkPaymentStatus', 'allocatePayment', 'unallocatePayment', 'listUnmatchedPayments',
        'receivePaymentWebhook', 'listRefunds', 'requestRefund', 'getRefund', 'retryRefund', 'markRefundPaid',
        'recordPayment', 'reversePayment', 'clearCheque', 'getCustomerStoreCredit', 'getMyStoreCredit', 'listOpenItems',
        'listSettlementReports', 'importSettlementReport', 'getSettlementReport', 'matchSettlementReport',
        'listBankStatements', 'importBankStatement', 'getBankStatement', 'matchBankStatement', 'matchBankStatementLine',
        'listReconciliationBreaks', 'getReconciliationBreak', 'resolveReconciliationBreak',
      ].sort(),
    );
    expect(routes.filter((route) => route.spec === undefined).map((route) => route.handler)).toEqual([]);
  });

  it('declares a permission on every staff operation that is not on the caller\'s own account or public', () => {
    const own = new Set(['logout', 'getCurrentSession', 'changePassword', 'startTotpEnrolment', 'confirmTotpEnrolment', 'stepUp', 'getMyStoreCredit']);
    for (const route of routes) {
      const spec = route.spec!;
      if (spec.access === 'PUBLIC' || own.has(spec.operationId) || spec.permissionByPolicy === true) {
        expect(spec.permission, spec.operationId).toBeNull();
        expect(spec.permissionByPolicy === true, spec.operationId).toBe(['approveRequest', 'rejectRequest'].includes(spec.operationId));
      } else {
        expect(spec.permission, spec.operationId).toMatch(/^[a-z]+\.[a-z_]+\.[a-z_.]+$/);
      }
    }
  });

  /** Reads whose query has a required parameter: without it the request is refused as invalid before it is authorised. */
  const VALID_QUERY: Record<string, string> = { listStockAvailability: `?branchId=${randomUUID()}`, listGrowth: '?groupBy=PEN&from=2026-10-01&to=2026-10-31', listSupplierScores: '?periodStart=2026-10-01', listAccountActivity: '?from=2026-11-01&to=2026-11-30',
    getTrialBalance: '?from=2026-11-01&to=2026-11-30',
    getProfitAndLoss: '?from=2026-11-01&to=2026-11-30',
    getBalanceSheet: '?asOf=2026-11-30',
    getCashFlow: '?from=2026-11-01&to=2026-11-30',
  };

  it('refuses a staff user who holds no grant on every permissioned operation, with 403 FORBIDDEN', async () => {
    const nobody = await createUser(database, { name: 'Kwame Nkansah' });
    const session = await login(api.server, nobody);
    const guarded = routes.filter((route) => (route.spec?.permission !== null && route.spec?.permission !== undefined) || route.spec?.permissionByPolicy === true);
    expect(guarded.length).toBeGreaterThanOrEqual(5);
    for (const route of guarded) {
      // A setting key is a dotted name, not an id: anything else is refused as invalid before it is authorised.
      const path = route.path.replace(':key', 'pur.purchase_order.approval_limit_pesewas').replace(/:[a-zA-Z]+/g, randomUUID());
      const body = VALID_BODY[route.spec!.operationId] ?? {};
      const response =
        route.method === 'GET'
          ? await consoleGet(api.server, session, `${path}${VALID_QUERY[route.spec!.operationId] ?? ''}`)
          : route.method === 'PUT' || route.method === 'PATCH' || route.method === 'DELETE'
            ? await (route.method === 'PUT' ? request(api.server).put(path) : route.method === 'PATCH' ? request(api.server).patch(path) : request(api.server).delete(path))
                .set('Cookie', session.jar.header())
                .set('X-CSRF-Token', session.csrfToken)
                .set('Origin', TEST_ORIGIN)
                .set('Idempotency-Key', randomUUID())
                .send(body)
            : route.spec!.operationId === 'uploadFile'
              ? await consolePost(api.server, session, path).field('purpose', 'EVIDENCE').attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), 'pen.jpg')
              : await consolePost(api.server, session, path).send(body);
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
      expect(response.body.error.code, route.path).toBe('FORBIDDEN');
    }
  });

  it('audits each refusal on its own connection, so it survives the refused command\'s rollback', async () => {
    const { rows } = await database
      .pool('admin')
      .query<{ permission: string; reason: string }>(
        "SELECT metadata->>'permission' AS permission, metadata->>'reason' AS reason FROM platform.audit_event WHERE action = 'AUTHORISATION_FAILURE'",
      );
    expect(rows.map((row) => row.permission)).toEqual(expect.arrayContaining(['mdm.product.read', 'mdm.product.create', 'iam.session.read', 'iam.session.revoke']));
    expect(new Set(rows.map((row) => row.reason))).toEqual(new Set(['NO_GRANT']));
  });
});

describe('the seeded roles (ADR-0017: a test per role that a forbidden action is refused)', () => {
  const withoutCreate: RoleCode[] = ['ACCOUNTANT', 'STOREKEEPER', 'CASHIER', 'SALES', 'FARM_HAND', 'DRIVER'];

  for (const role of withoutCreate) {
    it(`refuses a ${role} who tries to create a product`, async () => {
      const user = await createUser(database, { name: `Test ${role}`, grants: [{ role, branchId: dodowa.branchId }] });
      const session = role === 'ACCOUNTANT' ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user);
      expect((await consoleGet(api.server, session, '/v1/products')).status).toBe(200);
      const created = await consolePost(api.server, session, '/v1/products').send(VALID_BODY['createProduct']);
      expect(created.status).toBe(403);
      expect(created.body.error.code).toBe('FORBIDDEN');
    });
  }

  it('refuses investors and customers at every staff operation, because their sessions are of another realm', async () => {
    for (const realm of ['INVESTOR', 'CUSTOMER'] as const) {
      const user = await createUser(database, { name: `Test ${realm}`, realm });
      const session = await login(api.server, user);
      expect((await consoleGet(api.server, session, '/v1/products')).status).toBe(401);
      expect((await consoleGet(api.server, session, '/v1/iam/sessions')).status).toBe(401);
    }
  });
});

describe('the device list and forced logout (ADR-0016, FR-IAM-016)', () => {
  it('lets a cashier list their own sessions and refuses them anyone else\'s', async () => {
    const cashier = await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId: dodowa.branchId, locationId: dodowa.shopId }] });
    const other = await createUser(database, { name: 'Kofi Boadu', grants: [{ role: 'CASHIER', branchId: dodowa.branchId }] });
    const session = await login(api.server, cashier, 'Shop till tablet');
    await login(api.server, cashier, 'Adwoa phone');
    const own = await consoleGet(api.server, session, '/v1/iam/sessions');
    expect(own.status).toBe(200);
    expect(own.body.data.map((row: { deviceLabel: string }) => row.deviceLabel).sort()).toEqual(['Adwoa phone', 'Shop till tablet']);
    expect(own.body.data.filter((row: { current: boolean }) => row.current)).toHaveLength(1);
    expect(own.body.page).toEqual({ nextCursor: null, limit: 25, hasMore: false });
    const theirs = await consoleGet(api.server, session, `/v1/iam/sessions?principalId=${other.principalId}`);
    expect(theirs.status).toBe(403);
  });

  it('pages the device list with a signed cursor that refuses tampering', async () => {
    const cashier = await createUser(database, { name: 'Ama Owusu', grants: [{ role: 'CASHIER', branchId: dodowa.branchId }] });
    const session = await login(api.server, cashier);
    await login(api.server, cashier);
    await login(api.server, cashier);
    const first = await consoleGet(api.server, session, '/v1/iam/sessions?limit=2');
    expect(first.body.data).toHaveLength(2);
    expect(first.body.page.hasMore).toBe(true);
    const second = await consoleGet(api.server, session, `/v1/iam/sessions?limit=2&cursor=${encodeURIComponent(first.body.page.nextCursor)}`);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.page).toEqual({ nextCursor: null, limit: 2, hasMore: false });
    const tampered = `${first.body.page.nextCursor.slice(0, -2)}xx`;
    const refused = await consoleGet(api.server, session, `/v1/iam/sessions?limit=2&cursor=${encodeURIComponent(tampered)}`);
    expect(refused.status).toBe(400);
    expect(refused.body.error.details[0].field).toBe('/cursor');
  });

  it('lists a session as active until its absolute end by the application clock, whatever the database clock says (ADR-0067)', async () => {
    const cashier = await createUser(database, { name: 'Akua Sarpong', grants: [{ role: 'CASHIER', branchId: dodowa.branchId }] });
    const session = await login(api.server, cashier, 'Shop till tablet');
    const phone = await login(api.server, cashier, 'Akua phone');
    const ends = new Date(clock.now().getTime() + 60_000);
    await database.pool('admin').query('UPDATE iam.session SET idle_expires_at = $2, absolute_expires_at = $2 WHERE id = $1', [phone.sessionId, ends]);
    const active = async () => ((await consoleGet(api.server, session, '/v1/iam/sessions?active=true')).body.data as Array<{ deviceLabel: string }>).map((row) => row.deviceLabel).sort();
    clock.set(new Date(ends.getTime() - 1_000));
    expect(await active()).toEqual(['Akua phone', 'Shop till tablet']);
    clock.set(ends);
    expect(await active()).toEqual(['Shop till tablet']);
  });

  it('lets a manager revoke a cashier\'s session, which then fails on its next request, and replays the revoke once', async () => {
    const manager = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'MANAGER', branchId: dodowa.branchId }] });
    const cashier = await createUser(database, { name: 'Efua Mensah', grants: [{ role: 'CASHIER', branchId: dodowa.branchId }] });
    const managerSession = await enrolAndLogin(api.server, manager, () => clock.now());
    const cashierSession = await login(api.server, cashier);
    expect((await consoleGet(api.server, cashierSession, '/v1/products')).status).toBe(200);

    const key = randomUUID();
    const revoke = () => consolePost(api.server, managerSession, `/v1/iam/sessions/${cashierSession.sessionId}/revoke`, key).send({ reason: 'Tablet left unattended overnight' });
    expect((await revoke()).status).toBe(204);
    expect((await consoleGet(api.server, cashierSession, '/v1/products')).status).toBe(401);
    expect((await revoke()).status).toBe(204);
    const changed = await consolePost(api.server, managerSession, `/v1/iam/sessions/${cashierSession.sessionId}/revoke`, key).send({ reason: 'A different reason' });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const { rows } = await database.pool('admin').query<{ revoke_reason: string; revoked_by: string }>('SELECT revoke_reason, revoked_by FROM iam.session WHERE id = $1', [
      cashierSession.sessionId,
    ]);
    expect(rows[0]).toEqual({ revoke_reason: 'Tablet left unattended overnight', revoked_by: manager.principalId });
  });

  it('refuses a state change with no Idempotency-Key, before doing anything', async () => {
    const cashier = await createUser(database, { name: 'Kojo Asare', grants: [{ role: 'CASHIER', branchId: dodowa.branchId }] });
    const session = await login(api.server, cashier);
    const response = await request(api.server)
      .post(`/v1/iam/sessions/${session.sessionId}/revoke`)
      .set('Cookie', session.jar.header())
      .set('Origin', TEST_ORIGIN)
      .set('X-CSRF-Token', session.csrfToken)
      .send({ reason: 'Lost phone' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await consoleGet(api.server, session, '/v1/auth/session')).status).toBe(200);
  });
});
