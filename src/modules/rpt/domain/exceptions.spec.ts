import { describe, expect, it } from 'vitest';
import { breakFromView, classify, CLASSIFIED_EVENT_TYPES, OWNER_RETENTION_PERCENT, withoutPersonalData, type SourceEvent } from './classify';
import { EXCEPTION_KINDS, INVESTOR_ITEM_PERMISSION, SEVERITY_ORDER } from './exception-kinds';
import { approvalPairs, countRates, percent, plainCounts, valueRates } from './rates';
import { auditFinding, orderSplitting, stockException, verificationFailure } from './sweep';

const AT = new Date('2026-11-13T10:00:00Z');
const BRANCH = '019a7a83-2aef-79e3-9f1b-a708a7ae1fe6';
const ACTOR = '019a7a86-ac02-78a8-ade0-935170bb0c2f';
const OTHER = '019a7a86-4f35-7afd-b035-b8ab03a83188';
const DOC = '019a7b12-5b3e-7fd0-a508-05d2f3ff7eb0';

function event(type: string, payload: Record<string, unknown>, extra: Partial<SourceEvent> = {}): SourceEvent {
  return { id: '019a7b12-0000-7000-8000-000000000001', type, recordedAt: AT, actorId: ACTOR, branchId: BRANCH, subjectType: 'X', subjectId: DOC, payload, ...extra };
}

/** One full payload per event type the projector reads, as each module publishes it. */
const FULL: Record<string, Record<string, unknown>> = {
  'ord.SaleVoidRequested': { voidId: DOC, orderId: DOC, orderNo: 'SO-2026-DDW-004198', branchId: BRANCH, amountPesewas: 127500, reasonCode: 'WRONG_ITEM', approvalRequestId: DOC, requestedBy: ACTOR, cashierId: ACTOR, abuseCases: [1] },
  'ord.OrderVoided': { voidId: DOC, orderId: DOC, orderNo: 'SO-2026-DDW-004198', branchId: BRANCH, amountPesewas: 127500, reasonCode: 'WRONG_ITEM', creditNoteId: DOC, creditNoteNo: 'CN-1', approvalRequestId: DOC, requestedBy: ACTOR, voidedBy: OTHER, cashierId: ACTOR, abuseCases: [1] },
  'ord.PriceOverrideRequested': { orderId: DOC, orderNo: 'SO-1', branchId: BRANCH, approvalRequestId: DOC, requestedBy: ACTOR, salespersonId: ACTOR, variancePesewas: -5000, lines: [], abuseCases: [3] },
  'ord.PriceOverrideApproved': { orderId: DOC, branchId: BRANCH, approvalRequestId: DOC, requestedBy: ACTOR, approvedBy: OTHER, variancePesewas: 5000, abuseCases: [3] },
  'ord.ReturnSubmitted': { returnId: DOC, returnNo: 'RT-1', orderId: DOC, branchId: BRANCH, totalRefundPesewas: 917, reasonCode: 'DAMAGED', approvalRequestId: DOC, makerId: ACTOR, abuseCases: [12] },
  'ord.ReturnCompleted': { returnId: DOC, returnNo: 'RT-1', orderId: DOC, orderNo: 'SO-1', branchId: BRANCH, totalRefundPesewas: 917, reasonCode: 'DAMAGED', creditNoteId: DOC, creditNoteNo: 'CN-2', refundId: DOC, approvedBy: OTHER, makerId: ACTOR, abuseCases: [12] },
  'ord.CustomerConsentAnswered': { consentId: DOC, orderId: DOC, orderNo: 'SO-1', branchId: BRANCH, kind: 'HIGHER_TOTAL', accepted: true, method: 'PHONE', answeredBy: ACTOR },
  'ord.OrderDispatched': { orderId: DOC, orderNo: 'SO-1', branchId: BRANCH, contactPhone: '0244000000', backorderId: DOC, backorderNo: 'SO-1-B', backorderHeldQty: '5', deliveryNo: 'DL-1' },
  'ord.OrderCollected': { orderId: DOC, orderNo: 'SO-1', branchId: BRANCH, contactPhone: '0244000000', backorderId: DOC, backorderHeldQty: '2' },
  'pos.CashDropped': { shiftId: DOC, branchId: BRANCH, register: { id: DOC, code: 'T1' }, cashierId: ACTOR, movementId: DOC, kind: 'CASH_DROP', witnessId: null, unwitnessed: true, abuseCases: [17], amountsPesewas: { drop: 50000 } },
  'pos.ShiftClosed': { shiftId: DOC, branchId: BRANCH, register: { id: DOC, code: 'T1' }, cashierId: ACTOR, shiftNo: 'SH-1', approvedBy: OTHER, reason: 'count', declaredCashPesewas: 80000, expectedCashPesewas: 92000, overShortPesewas: -12000, overShortDirection: 'SHORT', abuseCases: [17], forceClosed: true, forceClosedBy: OTHER },
  'pos.ShiftForceClosed': { shiftId: DOC, branchId: BRANCH, register: { id: DOC, code: 'T1' }, cashierId: ACTOR, shiftNo: 'SH-1', forceClosedBy: OTHER, reason: 'left', expectedCashPesewas: 92000, closedAt: AT.toISOString(), abuseCases: [17] },
  'pos.OfflineSaleFlagged': { saleId: DOC, shiftId: DOC, branchId: BRANCH, register: { id: DOC, code: 'T1' }, deviceId: DOC, cashierId: ACTOR, deviceCounter: 4, provisionalRef: 'P-T1-1', exceptionKind: 'STOCK_EXCEPTION', severity: 'URGENT', summary: 'Line 1: stock at the till went below zero', amountPesewas: 58900, claim: { buyerTin: 'C0000000000', qty: '1' }, fact: { stockExceptionKind: 'NEGATIVE_STOCK', stockExceptionId: DOC }, abuseCases: [11, 36] },
  'pos.OfflineShiftFlagged': { shiftId: DOC, branchId: BRANCH, register: { id: DOC, code: 'T1' }, deviceId: DOC, cashierId: ACTOR, exceptionKind: 'OFFLINE_SHIFT_TOO_OLD', severity: 'REVIEW', summary: 'too old', amountPesewas: 0, claim: {}, fact: {}, abuseCases: [10] },
  'pos.OfflineCashMovementFlagged': { movementId: DOC, shiftId: DOC, branchId: BRANCH, register: { id: DOC, code: 'T1' }, deviceId: DOC, cashierId: ACTOR, kind: 'CASH_DROP', exceptionKind: 'OFFLINE_LATE_CASH', severity: 'REVIEW', summary: 'late cash', amountPesewas: 20000, claim: {}, fact: {}, abuseCases: [17] },
  'pos.OfflineSaleRejected': { saleId: DOC, shiftId: DOC, branchId: BRANCH, register: { id: DOC, code: 'T1' }, deviceId: DOC, cashierId: ACTOR, deviceCounter: 5, provisionalRef: 'P-T1-2', rule: 'HASH_MISMATCH', receivedHash: 'a', recomputedHash: 'b', submitted: { buyerPhone: '0244' }, amountPesewas: 4000, abuseCases: [10] },
  'pos.DeviceCounterGap': { shiftId: DOC, branchId: BRANCH, register: { id: DOC, code: 'T1' }, deviceId: DOC, cashierId: ACTOR, missing: [3, 4], highestSynced: 5, abuseCases: [10] },
  'pos.TillClockOutOfTolerance': { saleId: DOC, shiftId: DOC, branchId: BRANCH, register: { id: DOC, code: 'T1' }, deviceId: DOC, cashierId: ACTOR, tillTime: AT.toISOString(), serverTime: AT.toISOString(), differenceSeconds: 400, toleranceSeconds: 300 },
  'pos.TillPinFlagged': { subjectId: DOC, branchId: BRANCH, register: { id: DOC, code: 'T1' }, deviceId: DOC, principalId: ACTOR, supervisorId: OTHER, shiftId: DOC, pinVersion: 2, exceptionKind: 'LOCKED_CASHIER_SIGNED_OUT', severity: 'REVIEW', summary: 'signed out', abuseCases: [35] },
  'pay.ReconciliationBreakRaised': { breakId: DOC, kind: 'PROVIDER_PAID_AFTER_FAILURE', branchId: BRANCH, paymentId: DOC, refundId: null, reference: 'MOMO-1', amountPesewas: 25000, severity: 'URGENT', abuseCases: [73], details: { payerPhone: '0244', paidAt: 'x' } },
  'pay.BreakResolutionRequested': { resolutionId: DOC, breakId: DOC, kind: 'UNMATCHED_PAYMENT', branchId: BRANCH, posting: 'NONE', amountPesewas: 100, approvalRequestId: DOC, requestedBy: ACTOR },
  'pay.PaymentReversalRequested': { reversalId: DOC, paymentId: DOC, branchId: BRANCH, amountPesewas: 30000, methodKind: 'BANK_TRANSFER', reasonCode: 'BOUNCED', approvalRequestId: DOC, requestedBy: ACTOR, abuseCases: [32] },
  'pay.RefundRequested': { refundId: DOC, paymentId: DOC, branchId: BRANCH, amountPesewas: 4500, approvalRequestId: DOC, requestedBy: ACTOR, creditNoteId: DOC, creditNoteMakerId: OTHER, abuseCases: [12] },
  'pay.WebhookRejected': { webhookEventId: DOC, provider: 'paystack', outcome: 'REJECTED_SIGNATURE', abuseCases: [5] },
  'pay.UnverifiedPaymentOverdue': { breakId: DOC, paymentId: DOC, branchId: BRANCH, amountPesewas: 25000, reference: 'MOMO', urgentFrom: AT.toISOString(), abuseCases: [4] },
  'whl.CreditOverrideApproved': { abuseCases: [14], creditOverrideId: DOC, orderId: DOC, customerId: DOC, limitPesewas: 100000, exposurePesewas: 130000, overLimitPesewas: 30000, reasons: ['OVER_LIMIT'], requestedBy: ACTOR, approvedBy: OTHER },
  'whl.BadDebtWrittenOff': { writeOffId: DOC, customerId: DOC, billingDocumentId: DOC, documentNo: 'INV-1', branchId: BRANCH, amountPesewas: 70000, reason: 'gone', requestedBy: ACTOR, approvedBy: OTHER, writtenOffOn: '2026-11-13' },
  'whl.WrittenOffCustomerPaid': { customerId: DOC, paymentId: DOC, sourceEventType: 'pay.PaymentCleared', amountPesewas: 10000, writtenOffPesewas: 70000 },
  'whl.StatementSendRequested': { sendId: DOC, statementId: DOC, channels: ['EMAIL'] },
  'bil.CreditNoteIssued': { billingDocumentId: DOC, documentNo: 'CN-3', branchId: BRANCH, customerId: DOC, originalDocumentId: DOC, grossPesewas: 9000, reasonCode: 'RETURN', approvalRequestId: DOC, abuseCases: [31] },
  'bil.DocumentSendRequested': { sendId: DOC, billingDocumentId: DOC, copyNo: 2, channels: ['SMS'] },
  'inv.StockWrittenOff': { movementId: DOC, movementType: 'ADJUST_OUT', productId: DOC, stockUnitId: null, fromLocationId: DOC, toLocationId: DOC, qty: '3', valuePesewas: -6000, reasonCode: 'BREAKAGE', sourceDocumentId: DOC, reversesMovementId: DOC },
  'inv.StockGainRecorded': { movementId: DOC, movementType: 'ADJUST_IN', productId: DOC, qty: '1', valuePesewas: 2000, reasonCode: null, sourceDocumentId: DOC, reversesMovementId: null },
  'inv.OpeningStockLoaded': { movementId: DOC, movementType: 'OPENING_STOCK', productId: DOC, qty: '10', valuePesewas: 500000, sourceDocumentId: DOC },
  'inv.GoodsReceiptPosted': { goodsReceiptId: DOC, kind: 'PURCHASE', branchId: BRANCH, locationId: DOC, supplierId: DOC, purchaseOrderId: null, receivedAt: AT.toISOString(), lines: [] },
  'inv.ReservationReleased': { reservationId: DOC, holderDocumentId: DOC, productId: DOC, stockUnitId: DOC, locationId: DOC, qty: '1', reason: 'MANUAL' },
  'liv.MortalityReported': { mortalityRecordId: DOC, kind: 'DEATH', stockUnitId: DOC, branchId: BRANCH, locationId: DOC, head: 1, reasonCode: 'DISEASE', reportedBy: ACTOR, valuePesewas: 58900, thresholdPesewas: 50000, needsApproval: true, approvalKind: 'MORTALITY_WRITE_OFF', approvalRequestId: DOC, abuseCases: [2] },
  'liv.MortalityPhotoReused': { mortalityRecordId: DOC, branchId: BRANCH, stockUnitId: DOC, reportedBy: ACTOR, photoFileId: DOC, photoSha256: 'ab', earlierMortalityRecordIds: [DOC], matchedBy: 'SHA256', abuseCases: [2] },
  'prc.YieldVarianceFlagged': { processingOrderId: DOC, branchId: BRANCH, actorId: ACTOR, inputWeightKg: '20.000', expectedYieldPercent: '72.00', actualYieldPercent: '60.00', lines: [], abuseCases: [18] },
  'prc.ProcessingOrderReversed': { processingOrderId: DOC, processingReversalId: DOC, branchId: BRANCH, valuePesewas: 71400, thresholdPesewas: 50000, needsApproval: true, approvalRequestId: DOC, approvedBy: OTHER, reason: 'wrong carcass', actorId: ACTOR, abuseCases: [29] },
  'pur.SupplierPayoutChangeRequested': { payoutChangeId: DOC, supplierId: DOC, approvalRequestId: DOC, method: 'BANK', previousPayoutMasked: '****1234', payoutMasked: '****9876', requestedBy: ACTOR, abuseCase: 13 },
  'pur.SupplierPayoutChanged': { payoutChangeId: DOC, supplierId: DOC, approvalRequestId: DOC, method: 'BANK', previousPayoutMasked: null, payoutMasked: '****9876', requestedBy: ACTOR, approvedBy: OTHER, abuseCase: 13 },
  'pur.SupplierInvoiceMismatched': { supplierInvoiceId: DOC, supplierId: DOC, supplierInvoiceNo: 'SUP-7', purchaseOrderId: DOC, grossPesewas: 190000, lines: [] },
  'pur.SupplierInvoiceMatched': { supplierInvoiceId: DOC, supplierId: DOC, supplierInvoiceNo: 'SUP-8', purchaseOrderId: DOC, invoiceDate: '2026-11-12', grossPesewas: 200000, varianceApprovalRequestId: DOC },
  'pur.ExpenseInvoiceApproved': { supplierInvoiceId: DOC, supplierId: DOC, supplierInvoiceNo: 'EXP-1', grossPesewas: 3000, varianceApprovalRequestId: DOC },
  'pur.SupplierCreditNoteApproved': { creditNoteId: DOC, originalInvoiceId: DOC, supplierId: DOC, supplierInvoiceNo: 'SUP-8', grossPesewas: 8000, approvalRequestId: DOC, returns: [] },
  'pur.SupplierClaimRaised': { supplierClaimId: DOC, supplierId: DOC, purchaseOrderId: DOC, goodsReceiptId: DOC, receivedBy: OTHER, raisedBy: ACTOR, claimedPesewas: 5500, lines: [], abuseCases: [34] },
  'fin.FixedAssetDisposed': { fixedAssetId: DOC, disposalId: DOC, assetNo: 'FA-1', category: 'VEHICLE', disposedOn: '2026-11-13', costPesewas: 100, accumulatedPesewas: 10, proceedsPesewas: 50, gainPesewas: 0, lossPesewas: 40, proceedsMethod: 'CASH', abuseCases: [30] },
  'fin.TrialBalanceDriftDetected': { signedSumPesewas: -3, unbalancedEntries: [], controlBreaks: [], seriesGaps: [] },
  'cap.CapitalWithdrawn': { transactionId: DOC, transactionNo: 'CT-1', investorId: DOC, investorName: 'Kofi Mensah', kind: 'WITHDRAWAL', branchId: BRANCH, amountPesewas: 1000000, units: '10.0000', valueDate: '2026-11-13', postingDate: '2026-11-13', requestedBy: ACTOR, approvedBy: OTHER },
  'cap.CapitalContributed': { transactionId: DOC, transactionNo: 'CT-2', investorId: DOC, investorName: 'Ama Owusu', kind: 'CONTRIBUTION', branchId: BRANCH, amountPesewas: 500000, units: '5.0000', valueDate: '2026-09-30', postingDate: '2026-09-30', requestedBy: null, approvedBy: null },
  'cap.DistributionDeclared': { runId: DOC, runNo: 'DR-1', branchId: BRANCH, periodStart: '2026-07-01', periodEnd: '2026-09-30', distributablePesewas: 600000, draftedBy: ACTOR, approvedBy: OTHER, retentionRatePercent: '30.00', lines: [] },
  'cap.DistributionPaid': { paymentId: DOC, runId: DOC, runNo: 'DR-1', lineId: DOC, investorId: DOC, investorName: 'Kofi Mensah', bankAccountId: DOC, branchId: BRANCH, amountPesewas: 120000, externalReference: 'TRF-1' },
  'cap.InvestorPayoutChangeRequested': { payoutChangeId: DOC, investorId: DOC, approvalRequestId: DOC, method: 'MOBILE_MONEY', previousPayoutMasked: '024****000', payoutMasked: '055****111', requestedBy: ACTOR },
  'cap.InvestorPayoutChanged': { payoutChangeId: DOC, investorId: DOC, approvalRequestId: DOC, method: 'MOBILE_MONEY', previousPayoutMasked: '024****000', payoutMasked: '055****111', requestedBy: ACTOR, approvedBy: OTHER },
  'cap.LoanDrawn': { financingId: DOC, financingNo: 'FN-1', kind: 'LOAN', lenderName: 'Adinkra Rural Bank', bankAccountId: DOC, branchId: BRANCH, amountPesewas: 5000000, postingDate: '2026-11-01', recordedBy: ACTOR, approvedBy: OTHER },
  'cap.GrantReceived': { financingId: DOC, financingNo: 'FN-2', kind: 'GRANT', lenderName: 'Agric Fund', bankAccountId: DOC, branchId: BRANCH, amountPesewas: 2000000, postingDate: '2026-11-01', recordedBy: ACTOR, approvedBy: OTHER },
  'cap.LoanRepaid': { repaymentId: DOC, financingId: DOC, financingNo: 'FN-1', lenderName: 'Adinkra Rural Bank', branchId: BRANCH, principalPesewas: 100000, interestPesewas: 4500, postingDate: '2026-11-13', recordedBy: ACTOR },
  'cap.FinancingAccrualBlocked': { financingId: DOC, financingNo: 'FN-1', branchId: BRANCH, monthEnd: '2026-10-31' },
  'cst.OverheadAllocated': { runId: DOC, branchId: BRANCH, costElement: 'LABOUR', periodStart: '2026-10-01', periodEnd: '2026-10-31', totalPesewas: 30001, capitalisedPesewas: 30001, expensedPesewas: 0, makerId: ACTOR, checkerId: OTHER, movementIds: [], abuseCases: [72] },
  'cst.ProjectionDriftDetected': { projection: 'cst.margin_fact', from: '2020-01-01', to: '2026-11-12', revenueProjectedPesewas: '100', revenueLedgerPesewas: '110', costOfSalesProjectedPesewas: '50', costOfSalesLedgerPesewas: '40' },
  'del.DriverCashRemitted': { reconciliationId: DOC, driverId: ACTOR, driverName: 'Kwesi Appiah', receivedBy: OTHER, shiftId: DOC, register: { id: DOC, code: 'T1' }, branchId: BRANCH, expectedPesewas: 154000, receivedPesewas: 144000, shortPesewas: 10000, overPesewas: 0, varianceDirection: 'SHORT', proofIds: [], abuseCases: [6, 43], handedInAt: AT.toISOString() },
  'del.DeliveryCompleted': { deliveryId: DOC, deliveryNo: 'DL-2', branchId: BRANCH, driverId: ACTOR, vehicleLocationId: DOC, proofId: DOC, codDuePesewas: 50000, codCollectedPesewas: 45000, codShortPesewas: 5000, codVarianceReasonCode: 'CUSTOMER_SHORT', returnedLines: [{ orderLineId: DOC }], returnedReasonCode: 'REFUSED', returnedCreditPesewas: 3000 },
  'del.DeliveryFailed': { deliveryId: DOC, deliveryNo: 'DL-3', branchId: BRANCH, driverId: ACTOR, attemptNo: 1, failureReasonCode: 'NOT_HOME', nextAction: 'REATTEMPT', occurredAt: AT.toISOString() },
  'del.DeliveryWrittenOff': { deliveryId: DOC, deliveryNo: 'DL-4', branchId: BRANCH, driverId: ACTOR, vehicleLocationId: DOC, reasonCode: 'LOST', valuePesewas: 22000, stockAdjustmentId: DOC, unaccounted: true, abuseCases: [48] },
  'del.DeliveryReturned': { deliveryId: DOC, deliveryNo: 'DL-5', branchId: BRANCH, driverId: ACTOR, vehicleLocationId: DOC, returnsLocationId: DOC },
  'del.DeliveryReassigned': { deliveryId: DOC, deliveryNo: 'DL-6', branchId: BRANCH, fromDriverId: ACTOR, toDriverId: OTHER, fromVehicleLocationId: DOC, toVehicleLocationId: DOC },
  'del.DeliveryRescheduled': { deliveryId: DOC, deliveryNo: 'DL-7', branchId: BRANCH, fromSlotId: DOC, toSlotId: DOC, slotDate: '2026-11-14', reattempt: true, reason: 'customer asked' },
  'del.DeliveryCancelled': { deliveryId: DOC, deliveryNo: 'DL-8', branchId: BRANCH, driverId: ACTOR, vehicleLocationId: DOC, returnsLocationId: DOC, reasonCode: 'CUSTOMER_CANCELLED' },
  'del.ProofFileReused': { deliveryId: DOC, deliveryNo: 'DL-9', branchId: BRANCH, driverId: ACTOR, proofId: DOC, file: 'SIGNATURE', fileId: DOC, sha256: 'cd', earlierFileIds: [DOC], earlierProofIds: [DOC], matchedBy: 'SHA256', abuseCases: [44] },
  'quo.QuoteIssued': { quoteId: DOC, quoteNo: 'QT-1', versionId: DOC, versionNo: 2, branchId: BRANCH, customerId: DOC, salespersonId: ACTOR, grossPesewas: 3900000, validUntil: '2026-11-20', holds: [{ quoteLineId: DOC, productId: DOC, askedQty: '20', heldQty: '20' }, { quoteLineId: DOC, productId: DOC, askedQty: '5', heldQty: '0' }] },
  'quo.QuoteWithdrawn': { quoteId: DOC, quoteNo: 'QT-2', branchId: BRANCH, salespersonId: ACTOR, withdrawnBy: ACTOR, reason: 'buyer silent', fromStatus: 'ISSUED', wasIssued: true, grossPesewas: 120000, heldReleasedQty: '4', abuseCase: 65 },
  'quo.AcceptedQuoteLapsed': { quoteId: DOC, quoteNo: 'QT-3', branchId: BRANCH, salespersonId: ACTOR, acceptedVersionId: DOC, acceptedAt: AT.toISOString(), acceptanceMethod: 'IN_PERSON', grossPesewas: 80000, heldReleasedQty: '2', abuseCase: 66 },
  'quo.QuoteLinkDecidedFromStaffAddress': { quoteId: DOC, quoteNo: 'QT-4', versionNo: 1, branchId: BRANCH, salespersonId: ACTOR, linkId: DOC, linkDecisionId: DOC, decision: 'ACCEPTED', staff: [{ principalId: ACTOR, sameBrowser: true }], sameBrowser: true, windowHours: 24, grossPesewas: 99000, abuseCase: 40 },
  'ntf.MessageSuppressed': { messageId: DOC, templateCode: 'RECEIPT', channel: 'SMS', reason: 'RATE_LIMITED', salesOrderId: DOC, sourceEventType: 'ord.OrderCompleted', abuseCases: [58] },
  'ntf.MessageFailed': { messageId: DOC, templateCode: 'RECEIPT', channel: 'SMS', attempts: 5, reason: 'provider', salesOrderId: null, failedAt: AT.toISOString() },
  'ntf.DeliveryReportRejected': { reportId: DOC, provider: 'hubtel', outcome: 'REJECTED_SIGNATURE', sourceIp: '10.0.0.1', abuseCases: [57, 59] },
  'iam.RoleGranted': { grantId: DOC, change: 'GRANTED', principalId: ACTOR, roleCode: 'SHOP_SUPERVISOR', branchId: BRANCH, locationId: null },
  'iam.RoleRevoked': { grantId: DOC, change: 'REVOKED', principalId: OTHER, roleCode: 'CASHIER', branchId: BRANCH, locationId: null },
  'iam.RoleChanged': { roleId: DOC, roleCode: 'MANAGER', change: 'UPDATED', added: ['x'], removed: [] },
};

describe('classify: every event the projector reads raises its kind with abuse cases, actor, amount and subject', () => {
  it('has a full payload in this spec for every event type it reads, and reads no other', () => {
    expect(Object.keys(FULL).sort()).toEqual([...CLASSIFIED_EVENT_TYPES]);
  });

  it.each(CLASSIFIED_EVENT_TYPES)('%s with its full payload raises at least one item of a known kind, tied to its event', (type) => {
    const items = classify(event(type, FULL[type]!));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(EXCEPTION_KINDS).toContain(item.kind);
      expect(item.summary.length).toBeGreaterThan(0);
      expect(item.raisedAt).toEqual(AT);
      expect(item.details['sourceEvent']).toEqual({ id: '019a7b12-0000-7000-8000-000000000001', type });
      expect(JSON.stringify(item.details)).not.toMatch(/0244|C0000000000|10\.0\.0\.1/);
    }
  });

  it.each(CLASSIFIED_EVENT_TYPES)('%s with an empty payload never throws and keeps the envelope branch', (type) => {
    for (const item of classify(event(type, {}))) expect([BRANCH, null]).toContain(item.branchId);
  });

  it('an unknown event raises nothing', () => {
    expect(classify(event('ord.OrderPlaced', {}))).toEqual([]);
  });

  it('a void request and a void: SALE_VOID, abuse case 1, the cashier, GHS 1,275.00 and the sales order', () => {
    const [request] = classify(event('ord.SaleVoidRequested', FULL['ord.SaleVoidRequested']!));
    expect(request).toMatchObject({ kind: 'SALE_VOID', sourceKind: 'VOID_REQUESTED', abuseCases: [1], actorId: ACTOR, amountPesewas: 127500n, subject: { id: DOC, docType: 'SALES_ORDER' }, branchId: BRANCH, sourceKey: '019a7b12-0000-7000-8000-000000000001:SALE_VOID' });
    expect(request!.summary).toBe('Void of SO-2026-DDW-004198, GHS 1,275.00, requested');
    const [voided] = classify(event('ord.OrderVoided', FULL['ord.OrderVoided']!));
    expect(voided).toMatchObject({ sourceKind: 'VOIDED', actorId: ACTOR, details: { voidedBy: OTHER } });
  });

  it('an override is its size, never negative', () => {
    expect(classify(event('ord.PriceOverrideRequested', FULL['ord.PriceOverrideRequested']!))[0]!.amountPesewas).toBe(5000n);
  });

  it('a consent answered by the customer themselves raises nothing; by staff, CONSENT_RECORDED_BY_STAFF (case 42)', () => {
    expect(classify(event('ord.CustomerConsentAnswered', { ...FULL['ord.CustomerConsentAnswered'], method: 'SIGNED_LINK' }))).toEqual([]);
    expect(classify(event('ord.CustomerConsentAnswered', { ...FULL['ord.CustomerConsentAnswered'], method: 'CUSTOMER_ACCOUNT' }))).toEqual([]);
    const [staff] = classify(event('ord.CustomerConsentAnswered', { ...FULL['ord.CustomerConsentAnswered'], accepted: false }));
    expect(staff).toMatchObject({ kind: 'CONSENT_RECORDED_BY_STAFF', abuseCases: [42], actorId: ACTOR });
    expect(staff!.summary).toContain("customer's no");
  });

  it('a dispatch without a backorder hold raises nothing; with one, BACKORDER_HELD (cases 53, 67) and no phone number', () => {
    expect(classify(event('ord.OrderDispatched', { ...FULL['ord.OrderDispatched'], backorderHeldQty: '0' }))).toEqual([]);
    const [held] = classify(event('ord.OrderCollected', FULL['ord.OrderCollected']!));
    expect(held).toMatchObject({ kind: 'BACKORDER_HELD', sourceKind: 'COLLECTED', abuseCases: [53, 67] });
    expect(classify(event('ord.OrderDispatched', FULL['ord.OrderDispatched']!))[0]!.sourceKind).toBe('DISPATCHED');
  });

  it('a cash drop: unwitnessed REVIEW, witnessed INFO, both CASH_DROP under abuse case 17', () => {
    const [unwitnessed] = classify(event('pos.CashDropped', FULL['pos.CashDropped']!));
    expect(unwitnessed).toMatchObject({ kind: 'CASH_DROP', sourceKind: 'UNWITNESSED_CASH_DROP', severity: 'REVIEW', abuseCases: [17], amountPesewas: 50000n, actorId: ACTOR, subject: { docType: 'SHIFT' } });
    const { unwitnessed: _u, ...rest } = FULL['pos.CashDropped']!;
    const [witnessed] = classify(event('pos.CashDropped', { ...rest, witnessId: OTHER }));
    expect(witnessed).toMatchObject({ sourceKind: 'WITNESSED_CASH_DROP', severity: 'INFO', details: { witnessed: true } });
  });

  it('a shift closed exact raises nothing; short and over raise SHIFT_OVER_SHORT with the size', () => {
    expect(classify(event('pos.ShiftClosed', { ...FULL['pos.ShiftClosed'], overShortDirection: 'EXACT' }))).toEqual([]);
    expect(classify(event('pos.ShiftClosed', FULL['pos.ShiftClosed']!))[0]).toMatchObject({ kind: 'SHIFT_OVER_SHORT', sourceKind: 'FORCE_CLOSED_COUNT', amountPesewas: 12000n });
    const { forceClosed: _f, ...open } = FULL['pos.ShiftClosed']!;
    const [over] = classify(event('pos.ShiftClosed', { ...open, overShortDirection: 'OVER', overShortPesewas: 300 }));
    expect(over).toMatchObject({ sourceKind: 'OVER', amountPesewas: 300n });
    expect(over!.summary).toContain('over by GHS 3.00');
  });

  it("a till's findings take their own kinds: negative stock, late cash, late posting, refusals, a reused token", () => {
    const negative = classify(event('pos.OfflineSaleFlagged', FULL['pos.OfflineSaleFlagged']!))[0]!;
    expect(negative).toMatchObject({ kind: 'NEGATIVE_STOCK', sourceKind: 'STOCK_EXCEPTION', severity: 'URGENT', abuseCases: [11, 36], sourceKey: `stock-exception:${DOC}`, subject: { docType: 'SALES_ORDER' } });
    expect(negative.details['claim']).toEqual({ qty: '1' });
    const kinds: Record<string, string> = {
      PRICE_OVERRIDE: 'PRICE_OVERRIDE',
      NOT_PRICED_AT_SYNC: 'PRICE_OVERRIDE',
      UNIT_NOT_SOLD: 'STOCK_EXCEPTION',
      PROVISIONAL_REF_MISMATCH: 'OFFLINE_SALE_REVIEW',
      TENDERS_DIFFER: 'OFFLINE_SALE_REVIEW',
      BUYER_DETAILS_REFUSED: 'OFFLINE_SALE_REVIEW',
      UNMATCHED_PAYMENT: 'UNMATCHED_PAYMENT',
      OFFLINE_CASH_NOT_TAKEN: 'CASH_HANDED_IN_LATE',
      OFFLINE_LATE_CASH: 'CASH_HANDED_IN_LATE',
      OFFLINE_LATE_POSTING: 'LATE_POSTING',
      TILL_CLOCK_OUT_OF_TOLERANCE: 'LATE_POSTING',
      OFFLINE_SALE_TOO_OLD: 'LATE_POSTING',
      AUTHORISATION_FAILURE: 'AUTHORISATION_FAILURE',
      RECEIPT_TOKEN_REFUSED: 'RECEIPT_TOKEN_REFUSED',
      SOMETHING_NEW: 'OFFLINE_SALE_REVIEW',
    };
    for (const [sourceKind, kind] of Object.entries(kinds)) {
      const [item] = classify(event('pos.OfflineSaleFlagged', { ...FULL['pos.OfflineSaleFlagged'], exceptionKind: sourceKind, fact: {} }));
      expect(item).toMatchObject({ kind, sourceKind });
      expect(item!.sourceKey).toBe(`019a7b12-0000-7000-8000-000000000001:${kind}`);
    }
    expect(classify(event('pos.OfflineSaleFlagged', { ...FULL['pos.OfflineSaleFlagged'], fact: { stockExceptionKind: 'SERIAL_CONFLICT' } }))[0]!.kind).toBe('STOCK_EXCEPTION');
    expect(classify(event('pos.OfflineShiftFlagged', { ...FULL['pos.OfflineShiftFlagged'], exceptionKind: 'OFFLINE_SHIFT_REFUSED' }))[0]!.kind).toBe('SYNC_REJECTED');
    expect(classify(event('pos.OfflineShiftFlagged', { ...FULL['pos.OfflineShiftFlagged'], exceptionKind: 'SHIFT_SEQ_DIFFERS' }))[0]!.kind).toBe('OFFLINE_SALE_REVIEW');
    expect(classify(event('pos.OfflineCashMovementFlagged', { ...FULL['pos.OfflineCashMovementFlagged'], exceptionKind: 'CASH_MOVEMENT_REJECTED' }))[0]!.kind).toBe('SYNC_REJECTED');
    expect(classify(event('pos.OfflineCashMovementFlagged', FULL['pos.OfflineCashMovementFlagged']!))[0]).toMatchObject({ kind: 'CASH_HANDED_IN_LATE', amountPesewas: 20000n, subject: { docType: 'SHIFT' } });
    expect(classify(event('pos.OfflineSaleFlagged', { severity: 'LOUD' }))[0]).toMatchObject({ severity: 'REVIEW', sourceKind: 'UNKNOWN', summary: 'UNKNOWN', subject: { id: DOC } });
  });

  it('a refused sync, a counter gap and the PIN: URGENT under cases 10 and 35, the submission never copied', () => {
    const [rejected] = classify(event('pos.OfflineSaleRejected', FULL['pos.OfflineSaleRejected']!));
    expect(rejected).toMatchObject({ kind: 'SYNC_REJECTED', severity: 'URGENT', abuseCases: [10], amountPesewas: 4000n });
    expect(rejected!.details['submitted']).toBeUndefined();
    expect(classify(event('pos.DeviceCounterGap', FULL['pos.DeviceCounterGap']!))[0]!.summary).toBe('Till sales 3, 4 have not arrived while later ones have');
    expect(classify(event('pos.TillPinFlagged', FULL['pos.TillPinFlagged']!))[0]).toMatchObject({ kind: 'AUTHORISATION_FAILURE', sourceKind: 'LOCKED_CASHIER_SIGNED_OUT', severity: 'REVIEW', abuseCases: [35], details: { supervisorId: OTHER } });
  });

  it("a break: its own kind beside RECONCILIATION_BREAK, keyed by the break so the sweep's view row is the same item", () => {
    const [paidAfterFailure] = classify(event('pay.ReconciliationBreakRaised', FULL['pay.ReconciliationBreakRaised']!));
    expect(paidAfterFailure).toMatchObject({ kind: 'RECONCILIATION_BREAK', sourceKind: 'PROVIDER_PAID_AFTER_FAILURE', severity: 'URGENT', abuseCases: [15, 33, 73], sourceKey: `break:${DOC}`, subject: { docType: 'PAYMENT' }, amountPesewas: 25000n });
    expect(paidAfterFailure!.details['breakDetails']).toEqual({ paidAt: 'x' });
    const [unmatched] = classify(event('pay.ReconciliationBreakRaised', { breakId: DOC, kind: 'UNMATCHED_PAYMENT', sourceDocumentId: DOC, amountPesewas: null }));
    expect(unmatched).toMatchObject({ kind: 'UNMATCHED_PAYMENT', severity: 'REVIEW', abuseCases: [4, 33], subject: { docType: 'PAYMENT_DOCUMENT' }, amountPesewas: null });
    expect(classify(event('pay.ReconciliationBreakRaised', {}))[0]).toMatchObject({ sourceKind: 'UNKNOWN', subject: null, sourceKey: `break:${DOC}` });
    const view = breakFromView({ id: DOC, kind: 'REFUND_FAILED', branchId: BRANCH, paymentId: null, refundId: DOC, reference: null, sourceDocumentId: null, amountPesewas: 4500n, raisedAt: AT });
    expect(view).toMatchObject({ sourceKey: `break:${DOC}`, kind: 'RECONCILIATION_BREAK', sourceKind: 'REFUND_FAILED', amountPesewas: 4500n, details: { sourceEvent: null, sourceView: 'pay.pub_reconciliation_break' } });
    expect(breakFromView({ id: DOC, kind: 'REFUND_FAILED', branchId: null, paymentId: null, refundId: null, reference: 'R', sourceDocumentId: null, amountPesewas: null, raisedAt: AT }).amountPesewas).toBeNull();
  });

  it('stock adjustments: case 7, a breakage 55, a reversal 21, a gain INFO; receipts without an order case 19', () => {
    expect(classify(event('inv.StockWrittenOff', FULL['inv.StockWrittenOff']!))[0]).toMatchObject({ kind: 'STOCK_ADJUSTMENT', severity: 'REVIEW', abuseCases: [7, 21, 55], amountPesewas: 6000n });
    expect(classify(event('inv.StockGainRecorded', FULL['inv.StockGainRecorded']!))[0]).toMatchObject({ severity: 'INFO', abuseCases: [7] });
    expect(classify(event('inv.GoodsReceiptPosted', { ...FULL['inv.GoodsReceiptPosted'], purchaseOrderId: DOC }))).toEqual([]);
    expect(classify(event('inv.GoodsReceiptPosted', { ...FULL['inv.GoodsReceiptPosted'], kind: 'HARVEST' }))).toEqual([]);
    expect(classify(event('inv.GoodsReceiptPosted', FULL['inv.GoodsReceiptPosted']!))[0]).toMatchObject({ kind: 'GOODS_RECEIPT_UNMATCHED', abuseCases: [19] });
  });

  it('mortality is REVIEW when it waits for approval and INFO when not; a reused photograph URGENT', () => {
    expect(classify(event('liv.MortalityReported', FULL['liv.MortalityReported']!))[0]).toMatchObject({ kind: 'MORTALITY', severity: 'REVIEW', abuseCases: [2], amountPesewas: 58900n, actorId: ACTOR, subject: { docType: 'MORTALITY_RECORD' } });
    const cull = classify(event('liv.MortalityReported', { ...FULL['liv.MortalityReported'], kind: 'CULL', needsApproval: false }))[0]!;
    expect(cull.severity).toBe('INFO');
    expect(cull.summary).toContain('culled');
    expect(classify(event('liv.MortalityPhotoReused', FULL['liv.MortalityPhotoReused']!))[0]).toMatchObject({ kind: 'MORTALITY_PHOTO_REUSED', severity: 'URGENT' });
    expect(classify(event('prc.ProcessingOrderReversed', { ...FULL['prc.ProcessingOrderReversed'], needsApproval: false }))[0]!.severity).toBe('INFO');
  });

  it('payout changes: a supplier case 13 for everyone, an investor case 70 for the investor books only', () => {
    expect(classify(event('pur.SupplierPayoutChanged', FULL['pur.SupplierPayoutChanged']!))[0]).toMatchObject({ kind: 'PAYOUT_DETAIL_CHANGE', sourceKind: 'SUPPLIER_CHANGED', severity: 'URGENT', abuseCases: [13], restrictedTo: null, details: { party: 'SUPPLIER', partyId: DOC } });
    expect(classify(event('pur.SupplierPayoutChanged', FULL['pur.SupplierPayoutChanged']!))[0]!.summary).toContain('none to ****9876');
    expect(classify(event('cap.InvestorPayoutChangeRequested', FULL['cap.InvestorPayoutChangeRequested']!))[0]).toMatchObject({ sourceKind: 'INVESTOR_REQUESTED', severity: 'REVIEW', abuseCases: [70], restrictedTo: INVESTOR_ITEM_PERMISSION });
  });

  it('an invoice raises SUPPLIER_VARIANCE (case 28) only when paid on an approved variance', () => {
    expect(classify(event('pur.SupplierInvoiceMatched', { ...FULL['pur.SupplierInvoiceMatched'], varianceApprovalRequestId: null }))).toEqual([]);
    expect(classify(event('pur.ExpenseInvoiceApproved', FULL['pur.ExpenseInvoiceApproved']!))[0]).toMatchObject({ sourceKind: 'EXPENSE_INVOICE', abuseCases: [28] });
  });

  it('a disposal at a gain raises nothing; at a loss, the loss', () => {
    expect(classify(event('fin.FixedAssetDisposed', { ...FULL['fin.FixedAssetDisposed'], lossPesewas: 0 }))).toEqual([]);
    expect(classify(event('fin.FixedAssetDisposed', FULL['fin.FixedAssetDisposed']!))[0]).toMatchObject({ kind: 'ASSET_DISPOSAL', amountPesewas: 40n, abuseCases: [30] });
  });

  it('CAP: a backdated contribution, a run not at 40 percent, withdrawals and loans, all for the investor books only', () => {
    const [backdated] = classify(event('cap.CapitalContributed', FULL['cap.CapitalContributed']!));
    expect(backdated).toMatchObject({ kind: 'BACKDATED_CONTRIBUTION', abuseCases: [69], amountPesewas: 500000n, details: { recordedOn: '2026-11-13', valueDate: '2026-09-30' }, restrictedTo: INVESTOR_ITEM_PERMISSION });
    expect(classify(event('cap.CapitalContributed', { ...FULL['cap.CapitalContributed'], valueDate: '2026-11-13' }))).toEqual([]);
    const run = classify(event('cap.DistributionDeclared', FULL['cap.DistributionDeclared']!));
    expect(run.map((i) => i.kind)).toEqual(['DISTRIBUTION', 'RETENTION_RATE']);
    expect(run[1]).toMatchObject({ abuseCases: [69], details: { retentionRatePercent: '30.00', ownerRatePercent: OWNER_RETENTION_PERCENT } });
    expect(classify(event('cap.DistributionDeclared', { ...FULL['cap.DistributionDeclared'], retentionRatePercent: '40.00' })).map((i) => i.kind)).toEqual(['DISTRIBUTION']);
    expect(classify(event('cap.DistributionDeclared', { ...FULL['cap.DistributionDeclared'], retentionRatePercent: '40' })).map((i) => i.kind)).toEqual(['DISTRIBUTION']);
    expect(classify(event('cap.FinancingAccrualBlocked', FULL['cap.FinancingAccrualBlocked']!))[0]).toMatchObject({ kind: 'ACCRUAL_BLOCKED', sourceKey: `accrual-blocked:${DOC}:2026-10-31`, abuseCases: [71] });
    expect(classify(event('cap.FinancingAccrualBlocked', {}))[0]!.sourceKey).toBe(`accrual-blocked:${DOC}:`);
    expect(classify(event('cap.CapitalWithdrawn', FULL['cap.CapitalWithdrawn']!))[0]).toMatchObject({ kind: 'CAPITAL_WITHDRAWAL', abuseCases: [68], actorId: ACTOR, details: { approvedBy: OTHER } });
    expect(classify(event('cap.LoanRepaid', FULL['cap.LoanRepaid']!))[0]!.amountPesewas).toBe(104500n);
    expect(classify(event('cap.GrantReceived', FULL['cap.GrantReceived']!))[0]!.sourceKind).toBe('GRANT_RECEIVED');
    for (const type of CLASSIFIED_EVENT_TYPES.filter((t) => t.startsWith('cap.'))) {
      for (const item of classify(event(type, FULL[type]!))) expect(item.restrictedTo === INVESTOR_ITEM_PERMISSION || item.kind === 'PAYOUT_DETAIL_CHANGE').toBe(true);
    }
  });

  it('CST: an allocation case 72, a drift URGENT with both differences summed', () => {
    expect(classify(event('cst.OverheadAllocated', FULL['cst.OverheadAllocated']!))[0]).toMatchObject({ kind: 'OVERHEAD_ALLOCATION', abuseCases: [72], actorId: ACTOR, amountPesewas: 30001n, details: { checkerId: OTHER } });
    expect(classify(event('cst.ProjectionDriftDetected', FULL['cst.ProjectionDriftDetected']!))[0]).toMatchObject({ kind: 'PROJECTION_DRIFT', amountPesewas: 20n, abuseCases: [15, 72] });
    expect(classify(event('cst.ProjectionDriftDetected', { revenueProjectedPesewas: '7', revenueLedgerPesewas: '5', costOfSalesProjectedPesewas: '1', costOfSalesLedgerPesewas: '4' }))[0]!.amountPesewas).toBe(5n);
  });

  it("DEL: an exact hand-in raises nothing; a short one URGENT; an over one REVIEW; a short proof and a part delivery each their own", () => {
    expect(classify(event('del.DriverCashRemitted', { ...FULL['del.DriverCashRemitted'], varianceDirection: 'EXACT' }))).toEqual([]);
    expect(classify(event('del.DriverCashRemitted', FULL['del.DriverCashRemitted']!))[0]).toMatchObject({ kind: 'DRIVER_VARIANCE', severity: 'URGENT', amountPesewas: 10000n, abuseCases: [6, 43, 47] });
    expect(classify(event('del.DriverCashRemitted', { ...FULL['del.DriverCashRemitted'], varianceDirection: 'OVER', shortPesewas: 0, overPesewas: 700 }))[0]).toMatchObject({ severity: 'REVIEW', amountPesewas: 700n });
    expect(classify(event('del.DeliveryCompleted', FULL['del.DeliveryCompleted']!)).map((i) => i.kind)).toEqual(['DRIVER_VARIANCE', 'PART_DELIVERY']);
    expect(classify(event('del.DeliveryCompleted', { ...FULL['del.DeliveryCompleted'], codShortPesewas: 0, returnedLines: [] }))).toEqual([]);
    expect(classify(event('del.DeliveryWrittenOff', { ...FULL['del.DeliveryWrittenOff'], unaccounted: false }))[0]).toMatchObject({ sourceKind: 'ACCOUNTED', severity: 'REVIEW' });
    expect(classify(event('del.DeliveryRescheduled', { ...FULL['del.DeliveryRescheduled'], reattempt: false }))[0]!.sourceKind).toBe('RESCHEDULED');
    expect(classify(event('del.ProofFileReused', FULL['del.ProofFileReused']!))[0]!.summary).toContain('signature');
    expect(classify(event('del.ProofFileReused', { ...FULL['del.ProofFileReused'], file: 'PHOTO' }))[0]!.summary).toContain('photograph');
  });

  it('QUO: a quote holding nothing raises nothing; a staff-address decision is URGENT in the same browser', () => {
    expect(classify(event('quo.QuoteIssued', { ...FULL['quo.QuoteIssued'], holds: [] }))).toEqual([]);
    expect(classify(event('quo.QuoteIssued', FULL['quo.QuoteIssued']!))[0]!.details['holds']).toHaveLength(1);
    expect(classify(event('quo.QuoteLinkDecidedFromStaffAddress', FULL['quo.QuoteLinkDecidedFromStaffAddress']!))[0]).toMatchObject({ kind: 'QUOTE_ACCEPTED_BY_STAFF', severity: 'URGENT', abuseCases: [40] });
    const declined = classify(event('quo.QuoteLinkDecidedFromStaffAddress', { ...FULL['quo.QuoteLinkDecidedFromStaffAddress'], decision: 'DECLINED', sameBrowser: false }))[0]!;
    expect(declined.severity).toBe('REVIEW');
    expect(declined.summary).toContain('declined');
    expect(classify(event('quo.QuoteWithdrawn', { ...FULL['quo.QuoteWithdrawn'], wasIssued: false }))[0]!.severity).toBe('INFO');
  });

  it('NTF: a rate-limited message REVIEW, any other INFO; a refused report without its source address', () => {
    expect(classify(event('ntf.MessageSuppressed', { ...FULL['ntf.MessageSuppressed'], reason: 'NO_LINK' }))[0]!.severity).toBe('INFO');
    expect(classify(event('ntf.DeliveryReportRejected', FULL['ntf.DeliveryReportRejected']!))[0]!.details['sourceIp']).toBeUndefined();
  });

  it('IAM: a grant to oneself is marked, a revocation named, a role change counted (case 16)', () => {
    const [self] = classify(event('iam.RoleGranted', FULL['iam.RoleGranted']!, { branchId: null }));
    expect(self).toMatchObject({ kind: 'PERMISSION_CHANGE', sourceKind: 'GRANT_GRANTED', abuseCases: [16], branchId: BRANCH, details: { selfGrant: true } });
    expect(self!.summary).toContain('by themselves');
    const [revoked] = classify(event('iam.RoleRevoked', {}));
    expect(revoked).toMatchObject({ sourceKind: 'GRANT_REVOKED', branchId: BRANCH });
    expect(classify(event('iam.RoleGranted', {}))[0]!.sourceKind).toBe('GRANT_GRANTED');
    expect(classify(event('iam.RoleChanged', FULL['iam.RoleChanged']!))[0]!.summary).toBe('Role MANAGER updated: 1 permission(s) added, 0 removed');
  });

  it('removes contact and identity details at every depth, keeping words that only contain the letters', () => {
    expect(withoutPersonalData({ costing: 1, buyerTin: 'x', tin: 'y', TIN: 'z', contactPhone: '0244', ip: '1', nested: [{ email: 'a', ok: true }], sourceIp: '2', clientIp: '3' })).toEqual({ costing: 1, nested: [{ ok: true }] });
    expect(withoutPersonalData('plain')).toBe('plain');
  });

  it('names what it can when a payload carries only the fields that raise the item', () => {
    const minimal: [string, Record<string, unknown>][] = [
      ['fin.FixedAssetDisposed', { lossPesewas: 5 }],
      ['cap.DistributionDeclared', { retentionRatePercent: '10.00' }],
      ['del.DeliveryCompleted', { codShortPesewas: 1, returnedLines: [{}] }],
      ['quo.QuoteIssued', { holds: [{ heldQty: '1' }, { heldQty: 2 }] }],
      ['ord.OrderDispatched', { backorderHeldQty: '1' }],
      ['pur.SupplierInvoiceMatched', { varianceApprovalRequestId: DOC }],
    ];
    for (const [type, payload] of minimal) for (const item of classify(event(type, payload))) expect(item.summary).not.toMatch(/undefined|null/);
    expect(classify(event('quo.QuoteIssued', { holds: [{ heldQty: '1' }, { heldQty: 2 }] }))[0]!.details['holds']).toHaveLength(1);
  });

  it('takes amounts as integers or integer strings only', () => {
    expect(classify(event('pay.RefundRequested', { amountPesewas: 1.5 }))[0]!.amountPesewas).toBeNull();
    expect(classify(event('pay.RefundRequested', { amountPesewas: '-7' }))[0]!.amountPesewas).toBe(-7n);
    expect(classify(event('pay.RefundRequested', { amountPesewas: 'seven' }))[0]!.amountPesewas).toBeNull();
  });
});

describe('the sweep: records that raise items without an event', () => {
  const row = { id: DOC, occurredAt: AT, actorId: ACTOR, branchId: BRANCH, module: 'iam', entityType: 'Permission', entityId: null, metadata: null, after: null };

  it('an authorisation refusal is AUTHORISATION_FAILURE, abuse case 8, with the permission asked for', () => {
    expect(auditFinding({ ...row, action: 'AUTHORISATION_FAILURE', metadata: { permission: 'fin.report.read', reason: 'NO_GRANT', locationId: null } })).toMatchObject({ kind: 'AUTHORISATION_FAILURE', sourceKind: 'IAM_REFUSAL', abuseCases: [8], actorId: ACTOR, sourceKey: `audit:${DOC}`, summary: 'A request needing fin.report.read was refused (NO_GRANT)' });
    expect(auditFinding({ ...row, action: 'AUTHORISATION_FAILURE' })!.summary).toBe('A request needing a permission was refused (refused)');
  });

  it('an export is BULK_EXPORT (case 9): REVIEW over 100 rows, INFO otherwise, with its row count', () => {
    expect(auditFinding({ ...row, module: 'mdm', action: 'EXPORT', entityType: 'ImportJob', entityId: DOC, after: { entity: 'CUSTOMERS', rowCount: 412, bulk: true, format: 'XLSX' } })).toMatchObject({ kind: 'BULK_EXPORT', severity: 'REVIEW', abuseCases: [9], summary: 'customers exported: 412 rows', subject: { id: DOC, docType: 'IMPORT_JOB' }, details: { rowCount: 412 } });
    expect(auditFinding({ ...row, module: 'rpt', action: 'EXPORT', entityType: 'ReportRun', entityId: DOC, after: {} })).toMatchObject({ severity: 'INFO', summary: 'reportrun exported', subject: { docType: 'REPORT_RUN' } });
    expect(auditFinding({ ...row, action: 'EXPORT' })!.subject).toBeNull();
    expect(auditFinding({ ...row, action: 'CREATE' })).toBeNull();
  });

  it('a failed audit verification is AUDIT_INTEGRITY, URGENT, case 15, at the head office', () => {
    expect(verificationFailure({ id: DOC, finishedAt: AT, outcome: 'DRIFT', summary: { tampered: 1 } }, BRANCH)).toMatchObject({ kind: 'AUDIT_INTEGRITY', severity: 'URGENT', abuseCases: [15], branchId: BRANCH, sourceKey: `job-run:${DOC}` });
  });

  it("stock exceptions by inventory's kind: negative stock its own kind, a balance drift AUDIT_INTEGRITY", () => {
    const base = { id: DOC, branchId: BRANCH, productId: DOC, stockUnitId: null, locationId: DOC, movementId: DOC, sourceDocumentId: null, qty: '2.000', raisedAt: AT, status: 'OPEN', actorId: null };
    expect(stockException({ ...base, kind: 'NEGATIVE_STOCK' })).toMatchObject({ kind: 'NEGATIVE_STOCK', abuseCases: [11, 36], sourceKey: `stock-exception:${DOC}`, subject: { id: DOC, docType: 'STOCK_EXCEPTION' }, summary: 'negative stock raised for 2.000' });
    expect(stockException({ ...base, kind: 'TRANSFER_VARIANCE', status: 'RESOLVED', qty: null, sourceDocumentId: DOC }).summary).toBe('transfer variance raised, since resolved');
    expect(stockException({ ...base, kind: 'BALANCE_DRIFT' }).kind).toBe('AUDIT_INTEGRITY');
    expect(stockException({ ...base, kind: 'SOMETHING_NEW' })).toMatchObject({ kind: 'STOCK_EXCEPTION', abuseCases: [11] });
  });

  it('order splitting is one item per run (case 27): the maker, the orders in order, the total', () => {
    const item = orderSplitting({ supplierId: DOC, makerId: ACTOR, orderIds: ['b', 'a', 'c'], totalPesewas: 570000n, firstAt: AT, lastAt: AT }, BRANCH);
    expect(item).toMatchObject({ kind: 'ORDER_SPLITTING', abuseCases: [27], actorId: ACTOR, amountPesewas: 570000n, sourceKey: `split:${ACTOR}:${DOC}:a,b,c`, subject: { id: 'a', docType: 'PURCHASE_ORDER' } });
    expect(item.summary).toBe('3 purchase orders to one supplier by one person within 7 days, each just under the approval limit, GHS 5,700.00 together');
  });
});

describe('the detection rates (FR-RPT-008)', () => {
  it('a cashier with 4 voids in 40 sales shows a void rate of 10.00 percent beside everyone', () => {
    const voids = Array.from({ length: 4 }, () => ({ actorId: ACTOR, amountPesewas: 1000n }));
    const rows = countRates(voids, new Map([[ACTOR, 40], [OTHER, 60]]));
    expect(rows).toEqual([
      { actorId: ACTOR, count: 4, amountPesewas: 4000n, ratePercent: '10.00', comparisonRatePercent: '4.00' },
      { actorId: OTHER, count: 0, amountPesewas: 0n, ratePercent: '0.00', comparisonRatePercent: '4.00' },
    ].sort((a, b) => (a.actorId < b.actorId ? -1 : 1)));
    expect(countRates([{ actorId: ACTOR, amountPesewas: 1n }], new Map())[0]).toMatchObject({ ratePercent: null, comparisonRatePercent: null });
  });

  it('two users approving each other 9 times of 10 are a pair at 90.00 percent', () => {
    const decisions = [...Array.from({ length: 9 }, () => ({ makerId: ACTOR, checkerId: OTHER })), { makerId: ACTOR, checkerId: 'c' }, { makerId: OTHER, checkerId: ACTOR }];
    expect(approvalPairs(decisions)).toEqual([
      { makerId: ACTOR, checkerId: OTHER, count: 9, frequencyPercent: '90.00' },
      ...[
        { makerId: ACTOR, checkerId: 'c', count: 1, frequencyPercent: '10.00' },
        { makerId: OTHER, checkerId: ACTOR, count: 1, frequencyPercent: '100.00' },
      ].sort((a, b) => (a.makerId < b.makerId ? -1 : a.makerId > b.makerId ? 1 : a.checkerId < b.checkerId ? -1 : 1)),
    ]);
    expect(approvalPairs([{ makerId: 'b', checkerId: 'x' }, { makerId: 'a', checkerId: 'y' }, { makerId: 'a', checkerId: 'x' }]).map((r) => `${r.makerId}${r.checkerId}`)).toEqual(['ax', 'ay', 'bx']);
    expect(approvalPairs([{ makerId: 'a', checkerId: 'x' }, { makerId: 'a', checkerId: 'y' }, { makerId: 'b', checkerId: 'x' }]).map((r) => `${r.makerId}${r.checkerId}`)).toEqual(['ax', 'ay', 'bx']);
  });

  it('a value rate: GHS 120.00 short of GHS 8,200.00 expected is 1.46 percent', () => {
    expect(valueRates([{ actorId: ACTOR, amountPesewas: 12000n, basePesewas: 820000n }, { actorId: OTHER, amountPesewas: 0n, basePesewas: 0n }])).toEqual(
      [
        { actorId: ACTOR, count: 1, amountPesewas: 12000n, ratePercent: '1.46', comparisonRatePercent: '1.46' },
        { actorId: OTHER, count: 1, amountPesewas: 0n, ratePercent: null, comparisonRatePercent: '1.46' },
      ].sort((a, b) => (a.actorId < b.actorId ? -1 : 1)),
    );
    expect(valueRates([{ actorId: ACTOR, amountPesewas: 5n, basePesewas: 10n }, { actorId: ACTOR, amountPesewas: 5n, basePesewas: 10n }])[0]).toMatchObject({ count: 2, amountPesewas: 10n, ratePercent: '50.00' });
  });

  it('counts with no fair base carry no rate; percent rounds half-up once and refuses nothing to divide by', () => {
    expect(plainCounts([{ actorId: OTHER, amountPesewas: 3n }, { actorId: ACTOR, amountPesewas: 2n }, { actorId: OTHER, amountPesewas: 1n }]).map((r) => [r.actorId === OTHER, r.count, r.amountPesewas, r.ratePercent])).toEqual(
      [[false, 1, 2n, null], [true, 2, 4n, null]].sort((a, b) => ((a[0] ? OTHER : ACTOR) < (b[0] ? OTHER : ACTOR) ? -1 : 1)),
    );
    expect(percent(1n, 3n)).toBe('33.33');
    expect(percent(2n, 3n)).toBe('66.67');
    expect(percent(1n, 0n)).toBeNull();
    expect(percent(-1n, 3n)).toBeNull();
  });

  it('orders severities most urgent first', () => {
    expect(['INFO', 'URGENT', 'REVIEW'].sort((a, b) => SEVERITY_ORDER[a as 'INFO'] - SEVERITY_ORDER[b as 'INFO'])).toEqual(['URGENT', 'REVIEW', 'INFO']);
  });
});
