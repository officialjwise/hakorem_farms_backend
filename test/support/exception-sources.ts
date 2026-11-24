/**
 * One payload per event type RPT's exception projector reads (ADR-0103), as each module publishes it, with the ids a
 * test gives: the branch, the person each names (`actor`, and `other` as the second person), a document, and the time.
 * The integration spec writes each into the outbox for the projector alone, as the outbox would deliver it, so no
 * other consumer (the ledger above all) acts on a made-up event.
 */
export interface SourceIds {
  readonly branch: string;
  readonly actor: string;
  readonly other: string;
  readonly doc: string;
  readonly at: string;
}

export function exceptionSources(ids: SourceIds): Record<string, Record<string, unknown>> {
  const { branch: BRANCH, actor: ACTOR, other: OTHER, doc: DOC, at } = ids;
  return {
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
  'pos.ShiftForceClosed': { shiftId: DOC, branchId: BRANCH, register: { id: DOC, code: 'T1' }, cashierId: ACTOR, shiftNo: 'SH-1', forceClosedBy: OTHER, reason: 'left', expectedCashPesewas: 92000, closedAt: at, abuseCases: [17] },
  'pos.OfflineSaleFlagged': { saleId: DOC, shiftId: DOC, branchId: BRANCH, register: { id: DOC, code: 'T1' }, deviceId: DOC, cashierId: ACTOR, deviceCounter: 4, provisionalRef: 'P-T1-1', exceptionKind: 'STOCK_EXCEPTION', severity: 'URGENT', summary: 'Line 1: stock at the till went below zero', amountPesewas: 58900, claim: { buyerTin: 'C0000000000', qty: '1' }, fact: { stockExceptionKind: 'NEGATIVE_STOCK', stockExceptionId: DOC }, abuseCases: [11, 36] },
  'pos.OfflineShiftFlagged': { shiftId: DOC, branchId: BRANCH, register: { id: DOC, code: 'T1' }, deviceId: DOC, cashierId: ACTOR, exceptionKind: 'OFFLINE_SHIFT_TOO_OLD', severity: 'REVIEW', summary: 'too old', amountPesewas: 0, claim: {}, fact: {}, abuseCases: [10] },
  'pos.OfflineCashMovementFlagged': { movementId: DOC, shiftId: DOC, branchId: BRANCH, register: { id: DOC, code: 'T1' }, deviceId: DOC, cashierId: ACTOR, kind: 'CASH_DROP', exceptionKind: 'OFFLINE_LATE_CASH', severity: 'REVIEW', summary: 'late cash', amountPesewas: 20000, claim: {}, fact: {}, abuseCases: [17] },
  'pos.OfflineSaleRejected': { saleId: DOC, shiftId: DOC, branchId: BRANCH, register: { id: DOC, code: 'T1' }, deviceId: DOC, cashierId: ACTOR, deviceCounter: 5, provisionalRef: 'P-T1-2', rule: 'HASH_MISMATCH', receivedHash: 'a', recomputedHash: 'b', submitted: { buyerPhone: '0244' }, amountPesewas: 4000, abuseCases: [10] },
  'pos.DeviceCounterGap': { shiftId: DOC, branchId: BRANCH, register: { id: DOC, code: 'T1' }, deviceId: DOC, cashierId: ACTOR, missing: [3, 4], highestSynced: 5, abuseCases: [10] },
  'pos.TillClockOutOfTolerance': { saleId: DOC, shiftId: DOC, branchId: BRANCH, register: { id: DOC, code: 'T1' }, deviceId: DOC, cashierId: ACTOR, tillTime: at, serverTime: at, differenceSeconds: 400, toleranceSeconds: 300 },
  'pos.TillPinFlagged': { subjectId: DOC, branchId: BRANCH, register: { id: DOC, code: 'T1' }, deviceId: DOC, principalId: ACTOR, supervisorId: OTHER, shiftId: DOC, pinVersion: 2, exceptionKind: 'LOCKED_CASHIER_SIGNED_OUT', severity: 'REVIEW', summary: 'signed out', abuseCases: [35] },
  'pay.ReconciliationBreakRaised': { breakId: DOC, kind: 'PROVIDER_PAID_AFTER_FAILURE', branchId: BRANCH, paymentId: DOC, refundId: null, reference: 'MOMO-1', amountPesewas: 25000, severity: 'URGENT', abuseCases: [73], details: { payerPhone: '0244', paidAt: 'x' } },
  'pay.BreakResolutionRequested': { resolutionId: DOC, breakId: DOC, kind: 'UNMATCHED_PAYMENT', branchId: BRANCH, posting: 'NONE', amountPesewas: 100, approvalRequestId: DOC, requestedBy: ACTOR },
  'pay.PaymentReversalRequested': { reversalId: DOC, paymentId: DOC, branchId: BRANCH, amountPesewas: 30000, methodKind: 'BANK_TRANSFER', reasonCode: 'BOUNCED', approvalRequestId: DOC, requestedBy: ACTOR, abuseCases: [32] },
  'pay.RefundRequested': { refundId: DOC, paymentId: DOC, branchId: BRANCH, amountPesewas: 4500, approvalRequestId: DOC, requestedBy: ACTOR, creditNoteId: DOC, creditNoteMakerId: OTHER, abuseCases: [12] },
  'pay.WebhookRejected': { webhookEventId: DOC, provider: 'paystack', outcome: 'REJECTED_SIGNATURE', abuseCases: [5] },
  'pay.UnverifiedPaymentOverdue': { breakId: DOC, paymentId: DOC, branchId: BRANCH, amountPesewas: 25000, reference: 'MOMO', urgentFrom: at, abuseCases: [4] },
  'whl.CreditOverrideApproved': { abuseCases: [14], creditOverrideId: DOC, orderId: DOC, customerId: DOC, limitPesewas: 100000, exposurePesewas: 130000, overLimitPesewas: 30000, reasons: ['OVER_LIMIT'], requestedBy: ACTOR, approvedBy: OTHER },
  'whl.BadDebtWrittenOff': { writeOffId: DOC, customerId: DOC, billingDocumentId: DOC, documentNo: 'INV-1', branchId: BRANCH, amountPesewas: 70000, reason: 'gone', requestedBy: ACTOR, approvedBy: OTHER, writtenOffOn: '2026-11-13' },
  'whl.WrittenOffCustomerPaid': { customerId: DOC, paymentId: DOC, sourceEventType: 'pay.PaymentCleared', amountPesewas: 10000, writtenOffPesewas: 70000 },
  'whl.StatementSendRequested': { sendId: DOC, statementId: DOC, channels: ['EMAIL'] },
  'bil.CreditNoteIssued': { billingDocumentId: DOC, documentNo: 'CN-3', branchId: BRANCH, customerId: DOC, originalDocumentId: DOC, grossPesewas: 9000, reasonCode: 'RETURN', approvalRequestId: DOC, abuseCases: [31] },
  'bil.DocumentSendRequested': { sendId: DOC, billingDocumentId: DOC, copyNo: 2, channels: ['SMS'] },
  'inv.StockWrittenOff': { movementId: DOC, movementType: 'ADJUST_OUT', productId: DOC, stockUnitId: null, fromLocationId: DOC, toLocationId: DOC, qty: '3', valuePesewas: -6000, reasonCode: 'BREAKAGE', sourceDocumentId: DOC, reversesMovementId: DOC },
  'inv.StockGainRecorded': { movementId: DOC, movementType: 'ADJUST_IN', productId: DOC, qty: '1', valuePesewas: 2000, reasonCode: null, sourceDocumentId: DOC, reversesMovementId: null },
  'inv.OpeningStockLoaded': { movementId: DOC, movementType: 'OPENING_STOCK', productId: DOC, qty: '10', valuePesewas: 500000, sourceDocumentId: DOC },
  'inv.GoodsReceiptPosted': { goodsReceiptId: DOC, kind: 'PURCHASE', branchId: BRANCH, locationId: DOC, supplierId: DOC, purchaseOrderId: null, receivedAt: at, lines: [] },
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
  'del.DriverCashRemitted': { reconciliationId: DOC, driverId: ACTOR, driverName: 'Kwesi Appiah', receivedBy: OTHER, shiftId: DOC, register: { id: DOC, code: 'T1' }, branchId: BRANCH, expectedPesewas: 154000, receivedPesewas: 144000, shortPesewas: 10000, overPesewas: 0, varianceDirection: 'SHORT', proofIds: [], abuseCases: [6, 43], handedInAt: at },
  'del.DeliveryCompleted': { deliveryId: DOC, deliveryNo: 'DL-2', branchId: BRANCH, driverId: ACTOR, vehicleLocationId: DOC, proofId: DOC, codDuePesewas: 50000, codCollectedPesewas: 45000, codShortPesewas: 5000, codVarianceReasonCode: 'CUSTOMER_SHORT', returnedLines: [{ orderLineId: DOC }], returnedReasonCode: 'REFUSED', returnedCreditPesewas: 3000 },
  'del.DeliveryFailed': { deliveryId: DOC, deliveryNo: 'DL-3', branchId: BRANCH, driverId: ACTOR, attemptNo: 1, failureReasonCode: 'NOT_HOME', nextAction: 'REATTEMPT', occurredAt: at },
  'del.DeliveryWrittenOff': { deliveryId: DOC, deliveryNo: 'DL-4', branchId: BRANCH, driverId: ACTOR, vehicleLocationId: DOC, reasonCode: 'LOST', valuePesewas: 22000, stockAdjustmentId: DOC, unaccounted: true, abuseCases: [48] },
  'del.DeliveryReturned': { deliveryId: DOC, deliveryNo: 'DL-5', branchId: BRANCH, driverId: ACTOR, vehicleLocationId: DOC, returnsLocationId: DOC },
  'del.DeliveryReassigned': { deliveryId: DOC, deliveryNo: 'DL-6', branchId: BRANCH, fromDriverId: ACTOR, toDriverId: OTHER, fromVehicleLocationId: DOC, toVehicleLocationId: DOC },
  'del.DeliveryRescheduled': { deliveryId: DOC, deliveryNo: 'DL-7', branchId: BRANCH, fromSlotId: DOC, toSlotId: DOC, slotDate: '2026-11-14', reattempt: true, reason: 'customer asked' },
  'del.DeliveryCancelled': { deliveryId: DOC, deliveryNo: 'DL-8', branchId: BRANCH, driverId: ACTOR, vehicleLocationId: DOC, returnsLocationId: DOC, reasonCode: 'CUSTOMER_CANCELLED' },
  'del.ProofFileReused': { deliveryId: DOC, deliveryNo: 'DL-9', branchId: BRANCH, driverId: ACTOR, proofId: DOC, file: 'SIGNATURE', fileId: DOC, sha256: 'cd', earlierFileIds: [DOC], earlierProofIds: [DOC], matchedBy: 'SHA256', abuseCases: [44] },
  'quo.QuoteIssued': { quoteId: DOC, quoteNo: 'QT-1', versionId: DOC, versionNo: 2, branchId: BRANCH, customerId: DOC, salespersonId: ACTOR, grossPesewas: 3900000, validUntil: '2026-11-20', holds: [{ quoteLineId: DOC, productId: DOC, askedQty: '20', heldQty: '20' }, { quoteLineId: DOC, productId: DOC, askedQty: '5', heldQty: '0' }] },
  'quo.QuoteWithdrawn': { quoteId: DOC, quoteNo: 'QT-2', branchId: BRANCH, salespersonId: ACTOR, withdrawnBy: ACTOR, reason: 'buyer silent', fromStatus: 'ISSUED', wasIssued: true, grossPesewas: 120000, heldReleasedQty: '4', abuseCase: 65 },
  'quo.AcceptedQuoteLapsed': { quoteId: DOC, quoteNo: 'QT-3', branchId: BRANCH, salespersonId: ACTOR, acceptedVersionId: DOC, acceptedAt: at, acceptanceMethod: 'IN_PERSON', grossPesewas: 80000, heldReleasedQty: '2', abuseCase: 66 },
  'quo.QuoteLinkDecidedFromStaffAddress': { quoteId: DOC, quoteNo: 'QT-4', versionNo: 1, branchId: BRANCH, salespersonId: ACTOR, linkId: DOC, linkDecisionId: DOC, decision: 'ACCEPTED', staff: [{ principalId: ACTOR, sameBrowser: true }], sameBrowser: true, windowHours: 24, grossPesewas: 99000, abuseCase: 40 },
  'ntf.MessageSuppressed': { messageId: DOC, templateCode: 'RECEIPT', channel: 'SMS', reason: 'RATE_LIMITED', salesOrderId: DOC, sourceEventType: 'ord.OrderCompleted', abuseCases: [58] },
  'ntf.MessageFailed': { messageId: DOC, templateCode: 'RECEIPT', channel: 'SMS', attempts: 5, reason: 'provider', salesOrderId: null, failedAt: at },
  'ntf.DeliveryReportRejected': { reportId: DOC, provider: 'hubtel', outcome: 'REJECTED_SIGNATURE', sourceIp: '10.0.0.1', abuseCases: [57, 59] },
  'iam.RoleGranted': { grantId: DOC, change: 'GRANTED', principalId: ACTOR, roleCode: 'SHOP_SUPERVISOR', branchId: BRANCH, locationId: null },
  'iam.RoleRevoked': { grantId: DOC, change: 'REVOKED', principalId: OTHER, roleCode: 'CASHIER', branchId: BRANCH, locationId: null },
  'iam.RoleChanged': { roleId: DOC, roleCode: 'MANAGER', change: 'UPDATED', added: ['x'], removed: [] },
  };
}
