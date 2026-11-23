import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { loadFragments } from '../../../scripts/contract/code-document';
import {
  GoodsReceiptCreate,
  GoodsReceiptUpdate,
  MovementReversal,
  ReasonBody as InvReasonBody,
  StockAdjustmentCreate,
  StockHoldCreate,
  StockHoldRelease,
  StockExceptionResolve,
  ReorderRuleCreate,
  ReorderRuleUpdate,
  TemperatureReadingCreate,
  StockTakeCounts,
  StockTakeCreate,
  StockTransferCreate,
  TransferReceive,
} from '../../../src/modules/inv/interface/schemas';
import {
  ApprovalDecision,
  CustomerRegistration,
  GrantCreate,
  PasswordResetConfirm,
  PasswordResetRequest,
  PhoneVerification,
  RoleCreate,
  RoleUpdate,
  LoginRequest,
  PasswordChangeRequest,
  UserCreate,
  UserUpdate,
  ReasonRequest,
  StepUpRequest,
  TotpCodeRequest,
  TotpEnrolmentStart,
  TotpVerifyRequest,
} from '../../../src/modules/iam/interface/schemas';
import {
  ArchiveBody,
  ProductImageCreateBody,
  BranchCreate,
  BranchUpdate,
  CustomerAddressCreate,
  CustomerAddressUpdate,
  CustomerCreate,
  CustomerTierCreate,
  CustomerUpdate,
  LocationCreate,
  LocationUpdate,
  PriceListAssignmentInput,
  SupplierCreate,
  SupplierUpdate,
  PaymentMethodUpdate,
  DeliveryZoneCreate,
  DeliveryZoneUpdate,
  DeliveryQuoteRequest,
  PriceListUpdate,
  CategoryCreate,
  CategoryUpdate,
  CouponCreate,
  GradeCreate,
  GradeUpdate,
  ProductUpdate,
  SpeciesCreate,
  SpeciesUpdate,
  WeightBandCreate,
  UomConversionCreate,
  WeightBandUpdate,
  CouponValidationRequest,
  PriceListCreate,
  PriceListEntriesReplace,
  PriceListVersionCreate,
  PriceResolveRequest,
  ProductCreate,
  PromotionCreate,
  PromotionUpdate,
  ReasonRequest as MdmReasonRequest,
  TaxCalculationRequest,
  TaxCategoryCreate,
  TaxCellsReplace,
  TaxLevyCreate,
  TaxSchemeVersionCreate,
  ImportCreate,
  ExportCreate,
} from '../../../src/modules/mdm/interface/schemas';
import {
  ProcessingCostCreate,
  ProcessingOrderCreate,
  ProcessingOrderUpdate,
  ProcessingOutputsReplace,
  LabelPrintRequest,
  PacksCreate,
  ReasonBody as PrcReasonBody,
  YieldStandardCreate,
  YieldStandardUpdate,
} from '../../../src/modules/prc/interface/schemas';
import {
  AnimalMove,
  AnimalUpdate,
  BatchCreate,
  BatchUpdate,
  BirthRecord,
  BreedingRecordCreate,
  BreedingRecordUpdate,
  FeedConsumptionCreate,
  HealthEventCreate,
  MortalityRecordCreate,
  RationCreate,
  RationUpdate,
  ReasonRequest as LivReasonRequest,
  WeightRecordBatch,
} from '../../../src/modules/liv/interface/schemas';
import {
  PurchaseOrderCreate,
  PurchaseOrderSend,
  PurchaseOrderUpdate,
  PurchaseRequisitionCreate,
  PurchaseRequisitionUpdate,
  ReasonBody as PurReasonBody,
  RequisitionConvert,
  SupplierClaimCreditNoteDraft,
  SupplierClaimRaise,
  SupplierClaimSettle,
  SupplierDocumentCreate,
  SupplierInvoiceCreate,
  SupplierInvoiceUpdate,
  SupplierInvoiceVarianceRequest,
  SupplierPaymentCreate,
  SupplierPaymentMarkPaid,
  SupplierProfileUpdate,
} from '../../../src/modules/pur/interface/schemas';
import {
  CashMovementCreate as PosCashMovementCreate,
  ReasonBody as PosReasonBody,
  DeviceEnrolmentCreate as PosDeviceEnrolmentCreate,
  CounterSale as PosCounterSale,
  ForceClosedShiftCount as PosForceClosedShiftCount,
  HeldSaleCreate as PosHeldSaleCreate,
  OfflineSyncBatch as PosOfflineSyncBatch,
  TillPinReport as PosTillPinReport,
  TillPinSet as PosTillPinSet,
  RegisterCreate as PosRegisterCreate,
  RegisterUpdate as PosRegisterUpdate,
  ShiftClose as PosShiftClose,
  ShiftOpen as PosShiftOpen,
} from '../../../src/modules/pos/interface/schemas';
import { AccountCreate as WhlAccountCreate, AccountUpdate as WhlAccountUpdate, ReasonBody as WhlReasonBody, StatementCreate as WhlStatementCreate, DunningPolicyReplace as WhlDunningPolicyReplace, StandingOrderCreate as WhlStandingOrderCreate, StandingOrderUpdate as WhlStandingOrderUpdate, BadDebtWriteOff as WhlBadDebtWriteOff } from '../../../src/modules/whl/interface/schemas';
import {
  PublicQuoteRequest as QuoPublicQuoteRequest,
  QuoteAcceptanceRecord as QuoAcceptanceRecord,
  QuoteAcceptByLink as QuoAcceptByLink,
  QuoteConvert as QuoConvert,
  QuoteCreate as QuoCreate,
  QuoteDeclineByLink as QuoDeclineByLink,
  QuoteIssue as QuoIssue,
  QuoteVersionCreate as QuoVersionCreate,
  QuoteVersionUpdate as QuoVersionUpdate,
  ReasonRequest as QuoReasonRequest,
  RfqCreate as QuoRfqCreate,
  RfqUpdate as QuoRfqUpdate,
} from '../../../src/modules/quo/interface/schemas';
import { BusinessProfileUpdate as AudBusinessProfileUpdate, SettingUpdate as AudSettingUpdate } from '../../../src/modules/aud/interface/schemas';
import { SlotGenerate, SlotUpdate } from '../../../src/modules/del/interface/schemas';
import { CreditNoteCreate, DebitNoteCreate, ReprintRequest } from '../../../src/modules/bil/interface/schemas';
import {
  ConsentRecordBody,
  FulfilmentCreateBody,
  FulfilmentReasonBody,
  MyConsentBody,
  OrderConfirmBody,
  OrderCreateBody,
  PackRecordBody,
  PickRecordBody,
  ReasonCodeBody,
  ReturnCreateBody,
  ShortPickCreateBody,
  SubstitutionCreateBody,
} from '../../../src/modules/ord/interface/schemas';
import {
  AllocationBody,
  BankLineMatchBody,
  BreakResolveBody,
  ChequeClearanceBody,
  MobileMoneyChargeBody,
  ProviderWebhookBody,
  RecordPaymentBody,
  RefundBody,
  RefundMarkPaidBody,
  ReversalBody,
  SettlementImportBody,
  StatementImportBody,
  UnallocateBody,
} from '../../../src/modules/pay/interface/schemas';
import { DocumentDownloadRequest, TemplatePreviewRequest, TemplateVersionCreate } from '../../../src/modules/doc/interface/schemas';
import {
  AccountCreate,
  AccountDeterminationCreate,
  AccountUpdate,
  BankAccountCreate,
  BankAccountUpdate,
  DepreciationRunCreate,
  FixedAssetCreate,
  FixedAssetDisposal,
  FixedAssetUpdate,
  ManualJournalCreate,
  ManualJournalUpdate,
  PostingRuleCreate,
  ReasonRequest as FinReasonRequest,
} from '../../../src/modules/fin/interface/schemas';
import { CartLineAdd, CartLineUpdate, CheckoutStart, CheckoutUpdate, CouponApply, PlaceOrder } from '../../../src/modules/shp/interface/schemas';
import { createCatalogue, type TestCatalogue } from '../../support/catalogue';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let catalogue: TestCatalogue;
let manager: TestSession;
let cashier: TestSession;

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  const dodowa = await createBranch(database);
  catalogue = await createCatalogue(database);
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'MANAGER', branchId: dodowa.branchId }] }), () => clock.now());
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId: dodowa.branchId, locationId: dodowa.shopId }] }));
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

describe('the implemented operations answer in the shapes of contract/openapi.yaml', () => {
  it('loginStaff, getCurrentSession and refreshSession return LoginResult and SessionInfo', async () => {
    const user = await createUser(database, { name: 'Akua Mensah', grants: [] });
    const response = await request(api.server).post('/v1/auth/staff/login').set('Origin', TEST_ORIGIN).send({ identifier: user.identifier, password: user.password });
    expectShape('LoginResult', response.body);
    expectShape('SessionInfo', (await consoleGet(api.server, cashier, '/v1/auth/session')).body);
    const refreshed = await request(api.server).post('/v1/auth/refresh').set('Origin', TEST_ORIGIN).set('Cookie', manager.jar.header());
    expectShape('SessionInfo', refreshed.body);
    manager.jar.store(refreshed.headers['set-cookie']);
  });

  it('a challenge step returns LoginResult with a challenge and no session', async () => {
    const owner = await createUser(database, { name: 'Esi Bonsu', grants: [{ role: 'OWNER', branchId: (await createBranch(database, 'KSA')).branchId }] });
    const response = await request(api.server).post('/v1/auth/staff/login').set('Origin', TEST_ORIGIN).send({ identifier: owner.identifier, password: owner.password });
    expect(response.body.status).toBe('TOTP_ENROLMENT_REQUIRED');
    expectShape('LoginResult', response.body);
    const started = await request(api.server).post('/v1/auth/totp/enrol').set('Origin', TEST_ORIGIN).send({ challengeToken: response.body.challengeToken });
    expectShape('TotpEnrolment', started.body);
  });

  it('listSessions returns SessionRecordPage', async () => {
    expectShape('SessionRecordPage', (await consoleGet(api.server, cashier, '/v1/iam/sessions')).body);
  });

  it('createProduct, getProduct and listProducts return Product and ProductPage', async () => {
    const created = await consolePost(api.server, manager, '/v1/products').send({
      name: 'Beef, 15 kg pack',
      categoryId: catalogue.meatCategoryId,
      stockPolicy: 'CATCH_WEIGHT',
      baseUom: 'KG',
      saleUom: 'PACK',
      nominalPackKg: '15.000',
      storageTempClass: 'FROZEN',
      onlineMode: 'LISTED',
    });
    expect(created.status).toBe(201);
    expectShape('Product', created.body);
    expectShape('Product', (await consoleGet(api.server, cashier, `/v1/products/${created.body.id}`)).body);
    expectShape('ProductPage', (await consoleGet(api.server, cashier, '/v1/products')).body);
    // Sorted on the server (CR-019, B07 continued 3): the same shape, and a refused sort in the error envelope.
    expectShape('ProductPage', (await consoleGet(api.server, cashier, '/v1/products?sort=category&direction=desc&limit=1')).body);
    const unsortable = await consoleGet(api.server, cashier, '/v1/products?sort=description');
    expect(unsortable.status).toBe(400);
    expectShape('Error', unsortable.body);
  });

  it('every refusal on these operations uses the Error envelope', async () => {
    const responses = [
      await request(api.server).post('/v1/auth/staff/login').send({ identifier: 'nobody@hakoremfarms.test', password: 'x' }),
      await request(api.server).get('/v1/products'),
      await consolePost(api.server, cashier, '/v1/products').send({ barcode: 'X' }),
      await consolePost(api.server, cashier, `/v1/iam/sessions/${randomUUID()}/revoke`).send({ reason: 'x' }),
      await consoleGet(api.server, cashier, `/v1/products/${randomUUID()}`),
    ];
    // A cashier may revoke sessions, so an unknown session is 404, not 403.
    expect(responses.map((r) => r.status)).toEqual([401, 401, 400, 404, 404]);
    for (const response of responses) {
      expectShape('Error', response.body);
      expect(response.body.error.correlationId).toBe(response.headers['x-correlation-id']);
    }
  });
});

describe('request schemas in code and contract agree (ADR-0031)', () => {
  const fragments = loadFragments(`${__dirname}/../../../src`);
  const SCHEMAS: Readonly<Record<string, z.ZodType>> = {
    loginStaff: LoginRequest,
    loginCustomer: LoginRequest,
    loginInvestor: LoginRequest,
    verifyTotp: TotpVerifyRequest,
    changePassword: PasswordChangeRequest,
    startTotpEnrolment: TotpEnrolmentStart,
    confirmTotpEnrolment: TotpCodeRequest,
    stepUp: StepUpRequest,
    revokeSession: ReasonRequest,
    createUser: UserCreate,
    updateUser: UserUpdate,
    disableUser: ReasonRequest,
    enableUser: ReasonRequest,
    unlockUser: ReasonRequest,
    resetUserPassword: ReasonRequest,
    createGrant: GrantCreate,
    revokeGrant: ReasonRequest,
    createRole: RoleCreate,
    updateRole: RoleUpdate,
    approveRequest: ApprovalDecision,
    rejectRequest: ReasonRequest,
    cancelApprovalRequest: ReasonRequest,
    registerCustomer: CustomerRegistration,
    verifyCustomerPhone: PhoneVerification,
    requestPasswordReset: PasswordResetRequest,
    resetPassword: PasswordResetConfirm,
    createProduct: ProductCreate,
    createPriceList: PriceListCreate,
    createPriceListVersion: PriceListVersionCreate,
    replacePriceListEntries: PriceListEntriesReplace,
    resolvePrices: PriceResolveRequest,
    createTaxLevy: TaxLevyCreate,
    createTaxCategory: TaxCategoryCreate,
    createTaxSchemeVersion: TaxSchemeVersionCreate,
    replaceTaxSchemeCells: TaxCellsReplace,
    calculateTax: TaxCalculationRequest,
    createPromotion: PromotionCreate,
    updatePromotion: PromotionUpdate,
    endPromotion: MdmReasonRequest,
    createCoupon: CouponCreate,
    validateCoupon: CouponValidationRequest,
    createCategory: CategoryCreate,
    updateCategory: CategoryUpdate,
    archiveCategory: ArchiveBody,
    createSpecies: SpeciesCreate,
    updateSpecies: SpeciesUpdate,
    createGrade: GradeCreate,
    updateGrade: GradeUpdate,
    archiveGrade: ArchiveBody,
    createWeightBand: WeightBandCreate,
    updateWeightBand: WeightBandUpdate,
    archiveWeightBand: ArchiveBody,
    createUomConversion: UomConversionCreate,
    archiveUomConversion: ArchiveBody,
    updateProduct: ProductUpdate,
    createBranch: BranchCreate,
    updateBranch: BranchUpdate,
    createLocation: LocationCreate,
    updateLocation: LocationUpdate,
    archiveLocation: ArchiveBody,
    createCustomer: CustomerCreate,
    updateCustomer: CustomerUpdate,
    archiveCustomer: ArchiveBody,
    createCustomerTier: CustomerTierCreate,
    createCustomerAddress: CustomerAddressCreate,
    updateCustomerAddress: CustomerAddressUpdate,
    archiveCustomerAddress: ArchiveBody,
    assignCustomerPriceList: PriceListAssignmentInput,
    createSupplier: SupplierCreate,
    updateSupplier: SupplierUpdate,
    archiveSupplier: ArchiveBody,
    updatePaymentMethod: PaymentMethodUpdate,
    createDeliveryZone: DeliveryZoneCreate,
    updateDeliveryZone: DeliveryZoneUpdate,
    quoteDelivery: DeliveryQuoteRequest,
    updatePriceList: PriceListUpdate,
    archivePriceList: ArchiveBody,
    archiveProduct: ArchiveBody,
    addProductImage: ProductImageCreateBody,
    createImportJob: ImportCreate,
    createExportJob: ExportCreate,
    createGoodsReceipt: GoodsReceiptCreate,
    updateGoodsReceipt: GoodsReceiptUpdate,
    cancelGoodsReceipt: InvReasonBody,
    reverseStockMovement: MovementReversal,
    createStockTransfer: StockTransferCreate,
    receiveStockTransfer: TransferReceive,
    cancelStockTransfer: InvReasonBody,
    createStockAdjustment: StockAdjustmentCreate,
    createStockTake: StockTakeCreate,
    recordStockTakeCounts: StockTakeCounts,
    cancelStockTake: InvReasonBody,
    createStockHold: StockHoldCreate,
    releaseStockHold: StockHoldRelease,
    resolveStockException: StockExceptionResolve,
    releaseStockReservation: InvReasonBody,
    createReorderRule: ReorderRuleCreate,
    updateReorderRule: ReorderRuleUpdate,
    recordTemperatureReading: TemperatureReadingCreate,
    createProcessingOrder: ProcessingOrderCreate,
    updateProcessingOrder: ProcessingOrderUpdate,
    recordProcessingOutputs: ProcessingOutputsReplace,
    addProcessingCost: ProcessingCostCreate,
    cancelProcessingOrder: PrcReasonBody,
    createPacks: PacksCreate,
    printPackLabels: LabelPrintRequest,
    createYieldStandard: YieldStandardCreate,
    updateYieldStandard: YieldStandardUpdate,
    recordWeights: WeightRecordBatch,
    recordHealthEvent: HealthEventCreate,
    reportMortality: MortalityRecordCreate,
    createRation: RationCreate,
    updateRation: RationUpdate,
    recordFeedConsumption: FeedConsumptionCreate,
    updateAnimal: AnimalUpdate,
    moveAnimal: AnimalMove,
    createBatch: BatchCreate,
    updateBatch: BatchUpdate,
    closeBatch: LivReasonRequest,
    createBreedingRecord: BreedingRecordCreate,
    updateBreedingRecord: BreedingRecordUpdate,
    recordBirth: BirthRecord,
    failBreedingRecord: LivReasonRequest,
    recordCareHealthEvent: HealthEventCreate,
    reportCareMortality: MortalityRecordCreate,
    recordCareFeedConsumption: FeedConsumptionCreate,
    updateCareAnimal: AnimalUpdate,
    moveCareAnimal: AnimalMove,
    createCareBatch: BatchCreate,
    updateCareBatch: BatchUpdate,
    closeCareBatch: LivReasonRequest,
    createPurchaseOrder: PurchaseOrderCreate,
    updatePurchaseOrder: PurchaseOrderUpdate,
    sendPurchaseOrder: PurchaseOrderSend,
    closePurchaseOrder: PurReasonBody,
    cancelPurchaseOrder: PurReasonBody,
    createSupplierInvoice: SupplierInvoiceCreate,
    updateSupplierInvoice: SupplierInvoiceUpdate,
    cancelSupplierInvoice: PurReasonBody,
    createSupplierPayment: SupplierPaymentCreate,
    markSupplierPaymentPaid: SupplierPaymentMarkPaid,
    cancelSupplierPayment: PurReasonBody,
    updateSupplierProfile: SupplierProfileUpdate,
    addSupplierDocument: SupplierDocumentCreate,
    createPurchaseRequisition: PurchaseRequisitionCreate,
    updatePurchaseRequisition: PurchaseRequisitionUpdate,
    rejectPurchaseRequisition: PurReasonBody,
    convertPurchaseRequisition: RequisitionConvert,
    requestSupplierInvoiceVariance: SupplierInvoiceVarianceRequest,
    raiseSupplierClaim: SupplierClaimRaise,
    draftSupplierClaimCreditNote: SupplierClaimCreditNoteDraft,
    settleSupplierClaim: SupplierClaimSettle,
    createRegister: PosRegisterCreate,
    updateRegister: PosRegisterUpdate,
    openShift: PosShiftOpen,
    recordCashMovement: PosCashMovementCreate,
    closeShift: PosShiftClose,
    approveShiftClose: PosReasonBody,
    enrolDevice: PosDeviceEnrolmentCreate,
    revokeDevice: PosReasonBody,
    completeCounterSale: PosCounterSale,
    createStatement: WhlStatementCreate,
    createBusinessAccount: WhlAccountCreate,
    updateBusinessAccount: WhlAccountUpdate,
    holdBusinessAccount: WhlReasonBody,
    releaseBusinessAccount: WhlReasonBody,
    requestCreditOverride: WhlReasonBody,
    replaceDunningLevels: WhlDunningPolicyReplace,
    createStandingOrder: WhlStandingOrderCreate,
    updateStandingOrder: WhlStandingOrderUpdate,
    pauseStandingOrder: WhlReasonBody,
    resumeStandingOrder: WhlReasonBody,
    endStandingOrder: WhlReasonBody,
    writeOffBadDebt: WhlBadDebtWriteOff,
    confirmOrder: OrderConfirmBody,
    submitQuoteRequest: QuoPublicQuoteRequest,
    acceptQuoteByLink: QuoAcceptByLink,
    declineQuoteByLink: QuoDeclineByLink,
    createRfq: QuoRfqCreate,
    updateRfq: QuoRfqUpdate,
    createQuote: QuoCreate,
    reviseQuote: QuoVersionCreate,
    updateQuoteVersion: QuoVersionUpdate,
    issueQuoteVersion: QuoIssue,
    recordQuoteAcceptance: QuoAcceptanceRecord,
    declineQuote: QuoReasonRequest,
    revokeQuoteLink: QuoReasonRequest,
    cancelQuote: QuoReasonRequest,
    convertQuote: QuoConvert,
    forceCloseShift: PosReasonBody,
    countForceClosedShift: PosForceClosedShiftCount,
    holdSale: PosHeldSaleCreate,
    syncOfflineSales: PosOfflineSyncBatch,
    setTillPin: PosTillPinSet,
    reportTillPinEvents: PosTillPinReport,
    updateSetting: AudSettingUpdate,
    updateBusinessProfile: AudBusinessProfileUpdate,
    generateDeliverySlots: SlotGenerate,
    updateDeliverySlot: SlotUpdate,
    createAccount: AccountCreate,
    updateAccount: AccountUpdate,
    reopenAccountingPeriod: FinReasonRequest,
    createManualJournal: ManualJournalCreate,
    updateManualJournal: ManualJournalUpdate,
    createPostingRule: PostingRuleCreate,
    createAccountDetermination: AccountDeterminationCreate,
    createBankAccount: BankAccountCreate,
    updateBankAccount: BankAccountUpdate,
    createFixedAsset: FixedAssetCreate,
    updateFixedAsset: FixedAssetUpdate,
    disposeFixedAsset: FixedAssetDisposal,
    createDepreciationRun: DepreciationRunCreate,
    issueCreditNote: CreditNoteCreate,
    initiateMobileMoneyCharge: MobileMoneyChargeBody,
    allocatePayment: AllocationBody,
    unallocatePayment: UnallocateBody,
    requestRefund: RefundBody,
    markRefundPaid: RefundMarkPaidBody,
    recordPayment: RecordPaymentBody,
    reversePayment: ReversalBody,
    clearCheque: ChequeClearanceBody,
    importSettlementReport: SettlementImportBody,
    importBankStatement: StatementImportBody,
    matchBankStatementLine: BankLineMatchBody,
    resolveReconciliationBreak: BreakResolveBody,
    createOrder: OrderCreateBody,
    cancelOrder: ReasonCodeBody,
    voidOrder: ReasonCodeBody,
    createReturn: ReturnCreateBody,
    createFulfilment: FulfilmentCreateBody,
    recordPicks: PickRecordBody,
    packFulfilment: PackRecordBody,
    cancelFulfilment: FulfilmentReasonBody,
    proposeSubstitution: SubstitutionCreateBody,
    proposeShortPick: ShortPickCreateBody,
    recordCustomerConsent: ConsentRecordBody,
    answerMyOrderConsent: MyConsentBody,
    receivePaymentWebhook: ProviderWebhookBody,
    issueDebitNote: DebitNoteCreate,
    reprintBillingDocument: ReprintRequest,
    createTemplateVersion: TemplateVersionCreate,
    previewTemplateVersion: TemplatePreviewRequest,
    downloadArchivedDocument: DocumentDownloadRequest,
    addCartLine: CartLineAdd,
    updateCartLine: CartLineUpdate,
    applyCartCoupon: CouponApply,
    startCheckout: CheckoutStart,
    placeOrder: PlaceOrder,
    updateCheckout: CheckoutUpdate,
  };

  it('parses every request example of an implemented operation with the schema its route validates with', () => {
    let checked = 0;
    for (const [operationId, { operation }] of fragments) {
      const body = (operation['requestBody'] as { content?: Record<string, { example?: unknown }> } | undefined)?.content?.['application/json'];
      if (body?.example === undefined) {
        continue;
      }
      const schema = SCHEMAS[operationId];
      expect(schema, `${operationId} has a request example but no schema in this test`).toBeDefined();
      const parsed = schema!.safeParse(body.example);
      expect(parsed.success, `${operationId}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  it('refuses in code a request the contract refuses: an unknown field', () => {
    expect(ProductCreate.safeParse({ ...{ name: 'Goat', categoryId: randomUUID(), stockPolicy: 'SERIALISED', baseUom: 'HEAD', saleUom: 'HEAD', onlineMode: 'HIDDEN' }, price: 1 }).success).toBe(false);
    const validate = contractSchema('ProductCreate');
    expect(validate({ name: 'Goat', categoryId: randomUUID(), stockPolicy: 'SERIALISED', baseUom: 'HEAD', saleUom: 'HEAD', onlineMode: 'HIDDEN', price: 1 })).toBe(false);
  });
});
