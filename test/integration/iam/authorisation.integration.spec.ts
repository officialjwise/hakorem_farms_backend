import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { registeredRoutes, VALID_BODY, VALID_QUERY, type RouteInfo } from '../../support/routes';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let dodowa: TestBranch;
let routes: RouteInfo[];

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  dodowa = await createBranch(database);
  routes = registeredRoutes(api.app);
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('deny by default: the handler walk (ADR-0017, security architecture section 14)', () => {
  it('finds the B3, B4, B04 continued, B04d, B04d continued 1 to 3, B04e, B04e continued, B04e continued 2, B04e continued 3, B04e continued 4, B05 continued, B05 continued 3, B05x, B6, B06m, B06 continued, B06 continued 2, B06 continued 3, B06u, B7, B07 continued, B07 continued 1b, B06r, B07 continued 2, B08 continued, B08 continued 1b, B08 continued 1b2, B08 continued 1c, B08 continued 1c2, B08 continued 2, B08 continued 2b, B09a continued, B09a continued 1b, B09a continued 1c, B09a continued 2b, 2c, 2d, 2e and 2f, B09x continued, B09e continued 3, B9b, B08 continued 2d, B09u, B10, B10 continued, B10 continued 2, B09b continued 3, B10 continued 3, B10 continued 4, B10 continued 5, B09b continued 4, B11 continued 4, B11 continued 5, B11 continued 10, B12, B12 continued, B12 continued 2 and B12 continued 3 routes, and every one declares its operation', () => {
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
        'getOwnerDashboard', 'getStockValueTile', 'getAnimalsOnHandTile', 'getLowStockTile', 'getPurchasesSeries', 'getSalesTodayTile', 'getSalesSeries', 'getStockUnitLabel', 'getProductLabel',
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
        'listOrders', 'createOrder', 'getOrder', 'confirmOrder', 'listOrderHistory', 'cancelOrder', 'voidOrder',
        'createReturn', 'getReturn', 'submitReturn', 'issueProforma',
        'placeOrder', 'trackOrder', 'listMyOrders', 'getMyOrder',
        'getBusinessProfile', 'updateBusinessProfile', 'getShopProfile',
        'raiseSupplierClaim', 'listGoodsReceiptClaims', 'listSupplierClaims', 'getSupplierClaim', 'draftSupplierClaimCreditNote', 'settleSupplierClaim',
        'listRegisters', 'createRegister', 'updateRegister', 'listShifts', 'openShift', 'getShift', 'listShiftCashMovements', 'recordCashMovement',
        'getShiftXReport', 'getShiftZReport', 'closeShift', 'approveShiftClose',
        'listRegisterDevices', 'enrolDevice', 'revokeDevice', 'completeCounterSale', 'forceCloseShift', 'countForceClosedShift', 'listHeldSales', 'holdSale', 'recallHeldSale', 'getOfflinePack',
        'syncOfflineSales', 'setTillPin', 'listTillPinVerifiers', 'reportTillPinEvents', 'listShiftWitnesses',
        'listStatements', 'createStatement', 'getStatement',
        'getSupplierBalance',
        'submitQuoteRequest', 'viewQuoteByLink', 'acceptQuoteByLink', 'declineQuoteByLink', 'listRfqs', 'createRfq', 'getRfq', 'updateRfq',
        'listQuotes', 'createQuote', 'getQuote', 'listQuoteVersions', 'reviseQuote', 'updateQuoteVersion', 'issueQuoteVersion',
        'recordQuoteAcceptance', 'declineQuote', 'cancelQuote', 'convertQuote', 'getCustomerPriceList', 'listPriceListAssignments',
        'listBusinessAccounts', 'createBusinessAccount', 'getBusinessAccount', 'updateBusinessAccount', 'holdBusinessAccount', 'releaseBusinessAccount',
        'listCreditOverrides', 'getOrderCreditCheck', 'requestCreditOverride',
        'getAgeingReport', 'listDunningLevels', 'replaceDunningLevels', 'listDunningNotices',
        'listStandingOrders', 'createStandingOrder', 'getStandingOrder', 'updateStandingOrder', 'pauseStandingOrder', 'resumeStandingOrder', 'endStandingOrder',
        'listStandingOrderRuns', 'writeOffBadDebt',
        'revokeQuoteLink', 'listMyQuotes',
        'getQuotePipeline',
        'getPublicReceipt', 'revokeReceiptLink', 'payInvoiceAtTill',
        'listFulfilments', 'createFulfilment', 'getFulfilment', 'recordPicks', 'packFulfilment', 'cancelFulfilment',
        'proposeSubstitution', 'proposeShortPick', 'recordCustomerConsent', 'answerMyOrderConsent',
        // B11 continued 10: message templates, the message log and the messaging webhook.
        'listNotificationTemplates', 'createNotificationTemplate', 'getNotificationTemplate', 'activateNotificationTemplate', 'previewNotificationTemplate',
        'listNotificationMessages', 'getNotificationMessage', 'retryNotificationMessage', 'receiveMessagingWebhook',
        // B11 continued 11: triggers, opt-outs, one's own preferences and in-app notifications.
        'listNotificationTriggers', 'updateNotificationTrigger', 'listOptOuts',
        'getMyNotificationPreferences', 'replaceMyNotificationPreferences', 'listMyNotifications', 'markNotificationRead',
        'dispatchFulfilment', 'listDeliveries', 'getDelivery', 'getMyDelivery', 'recordProofOfDelivery',
        'getOrderFulfilmentView',
        'getMyCashSummary', 'listDriverCashReconciliations', 'getDriverCashReconciliation', 'handInDriverCash',
        'listRoutes', 'createRoute', 'getRoute', 'reorderRouteStops', 'startRoute', 'completeRoute', 'getMyRoute', 'listDrivers', 'markOnTheWay', 'recordFailedDelivery',
        'returnDeliveryToStock', 'writeOffDelivery', 'listDriverGoodsVariances',
        'assignDelivery', 'rescheduleDelivery',
        'listShiftDriverCashHolders', 'cancelDelivery', 'syncDriverEvents',
        'addExtraDeliveryFee', 'collectFulfilment',
        // B11 continued 13: the document sends and a document link's public read.
        'sendBillingDocument', 'sendStatement', 'getSharedDocument',
        // B12: the investor register, capital and distribution runs.
        'listInvestors', 'createInvestor', 'getInvestor', 'updateInvestor', 'listCapitalTransactions', 'recordCapitalTransaction', 'getCapitalTransaction',
        'getCapitalRegister', 'listDistributionRuns', 'createDistributionRun', 'getDistributionRun', 'recomputeDistributionRun', 'submitDistributionRun',
        'postDistributionRun', 'getDistributionSchedule', 'recordDistributionPayment',
        // B12 continued: documents, payout details, statements, returns, loans and grants, and the investor portal.
        'listInvestorDocuments', 'addInvestorDocument', 'getInvestorPayoutDetails', 'getInvestorStatement', 'getInvestorReturns', 'getOverallReturns',
        'listFinancing', 'createFinancing', 'getFinancing', 'recordRepayment',
        'getMyInvestorSummary', 'listMyCapitalTransactions', 'listMyDistributions', 'getMyInvestorStatement', 'listMyInvestorDocuments', 'downloadMyInvestorDocument',
        // B12 continued 2: costing, margins, break-even, losses and labour and overhead allocation.
        'getCostObject', 'listMargins', 'getBreakEven', 'listLosses', 'listOverheadAllocations', 'createOverheadAllocation', 'getOverheadAllocation',
        'postOverheadAllocation',
        // B12 continued 3: the daily exception report, its items and their review.
        'listExceptions', 'getDailyExceptionReport', 'reviewException',
      ].sort(),
    );
    expect(routes.filter((route) => route.spec === undefined).map((route) => route.handler)).toEqual([]);
  });

  it('declares a permission on every staff operation that is not on the caller\'s own account or public', () => {
    const own = new Set(['logout', 'getCurrentSession', 'changePassword', 'startTotpEnrolment', 'confirmTotpEnrolment', 'stepUp', 'getMyStoreCredit', 'listMyOrders', 'getMyOrder', 'listMyQuotes', 'answerMyOrderConsent', 'getMyNotificationPreferences', 'replaceMyNotificationPreferences', 'listMyNotifications', 'markNotificationRead', 'getMyInvestorSummary', 'listMyCapitalTransactions', 'listMyDistributions', 'getMyInvestorStatement', 'listMyInvestorDocuments', 'downloadMyInvestorDocument']);
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


  it('refuses a staff user who holds no grant on every permissioned operation, with 403 FORBIDDEN', async () => {
    const nobody = await createUser(database, { name: 'Kwame Nkansah' });
    const session = await login(api.server, nobody);
    const guarded = routes.filter((route) => (route.spec?.permission !== null && route.spec?.permission !== undefined) || route.spec?.permissionByPolicy === true);
    expect(guarded.length).toBeGreaterThanOrEqual(5);
    for (const route of guarded) {
      // A setting key is a dotted name, not an id: anything else is refused as invalid before it is authorised.
      const path = route.path.replace(':key', 'pur.purchase_order.approval_limit_pesewas').replace(':objectType', 'STOCK_UNIT').replace(/:[a-zA-Z]+/g, randomUUID());
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
