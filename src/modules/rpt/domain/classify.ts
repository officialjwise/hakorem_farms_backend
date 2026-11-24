import { formatCedis, toBusinessDate } from '@hakorem/kernel';
import { INVESTOR_ITEM_PERMISSION, type ExceptionKind, type Severity } from './exception-kinds';

/** An outbox event as the projector reads it: the envelope's facts and the payload as published. */
export interface SourceEvent {
  readonly id: string;
  readonly type: string;
  readonly recordedAt: Date;
  readonly actorId: string;
  readonly branchId: string | null;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** The subject document an item names: an id and the document type it is when the registry does not know it. */
export interface SubjectRef {
  readonly id: string;
  readonly docType: string;
}

/** One exception item before it is stored: everything but its date, which is the Africa/Accra day of `raisedAt`. */
export interface ExceptionDraft {
  /** What makes the item unique across replays: an event id and the kind, or a source record's id. */
  readonly sourceKey: string;
  readonly kind: ExceptionKind;
  readonly sourceKind: string | null;
  readonly severity: Severity;
  readonly abuseCases: readonly number[];
  readonly branchId: string | null;
  readonly actorId: string | null;
  readonly subject: SubjectRef | null;
  readonly amountPesewas: bigint | null;
  readonly summary: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly raisedAt: Date;
  /** A permission the reader must also hold to see the item (the investor books), or null. */
  readonly restrictedTo: string | null;
}

type Payload = Readonly<Record<string, unknown>>;

function str(p: Payload, key: string): string | null {
  const v = p[key];
  return typeof v === 'string' ? v : null;
}

function int(p: Payload, key: string): bigint | null {
  const v = p[key];
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return null;
}

function cases(p: Payload, fallback: readonly number[]): number[] {
  const listed = p['abuseCases'];
  const single = p['abuseCase'];
  const found = Array.isArray(listed) ? listed.filter((n): n is number => typeof n === 'number') : typeof single === 'number' ? [single] : [];
  return [...new Set([...found, ...fallback])].sort((a, b) => a - b);
}

function severityOf(p: Payload, fallback: Severity): Severity {
  const v = p['severity'];
  return v === 'INFO' || v === 'REVIEW' || v === 'URGENT' ? v : fallback;
}

function cedis(amount: bigint | null): string {
  return amount === null ? 'an amount not given' : formatCedis(amount < 0n ? -amount : amount);
}

function abs(amount: bigint | null): bigint | null {
  return amount === null ? null : amount < 0n ? -amount : amount;
}

/** Keys that could carry a person's contact or identity details are never copied into an item (DATA_CLASSIFICATION). */
const PERSONAL_WORD = /phone|email|msisdn|address|recipient|buyer|identity|national|sourceip/i;
/** A TIN or an IP address as its own word in a camelCase key (`tin`, `buyerTin`, `TIN`, `ip`), never `costing`. */
const PERSONAL_CODE = /^(ip|tin)$|[a-z](Tin|Ip)($|[A-Z])|TIN/;

/** A source's claim or fact with every personal key removed, recursively. */
export function withoutPersonalData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPersonalData);
  if (value === null || typeof value !== 'object') return value;
  const kept: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!PERSONAL_WORD.test(key) && !PERSONAL_CODE.test(key)) kept[key] = withoutPersonalData(item);
  }
  return kept;
}

/** The fields of a payload an item keeps, by name, with personal data removed. */
function pick(p: Payload, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (p[key] !== undefined) out[key] = withoutPersonalData(p[key]);
  return out;
}

interface Item {
  readonly kind: ExceptionKind;
  readonly sourceKind?: string | null;
  readonly severity: Severity;
  readonly abuseCases: readonly number[];
  readonly actorId: string | null;
  readonly subject: SubjectRef | null;
  readonly amountPesewas: bigint | null;
  readonly summary: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly branchId?: string | null;
  readonly sourceKey?: string;
  readonly restrictedTo?: string | null;
}

function drafts(event: SourceEvent, items: readonly Item[]): ExceptionDraft[] {
  return items.map((item) => ({
    sourceKey: item.sourceKey ?? `${event.id}:${item.kind}`,
    kind: item.kind,
    sourceKind: item.sourceKind ?? null,
    severity: item.severity,
    abuseCases: [...item.abuseCases],
    branchId: item.branchId !== undefined ? item.branchId : (str(event.payload, 'branchId') ?? event.branchId),
    actorId: item.actorId,
    subject: item.subject,
    amountPesewas: item.amountPesewas,
    summary: item.summary,
    details: { sourceEvent: { id: event.id, type: event.type }, ...item.details },
    raisedAt: event.recordedAt,
    restrictedTo: item.restrictedTo ?? null,
  }));
}

function ref(id: string | null, docType: string): SubjectRef | null {
  return id === null ? null : { id, docType };
}

const POS_FLAG_KIND: Readonly<Record<string, ExceptionKind>> = {
  STOCK_EXCEPTION: 'STOCK_EXCEPTION',
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
  OFFLINE_SHIFT_TOO_OLD: 'LATE_POSTING',
  SHIFT_SEQ_DIFFERS: 'OFFLINE_SALE_REVIEW',
  OFFLINE_SHIFT_REFUSED: 'SYNC_REJECTED',
  CASH_MOVEMENT_REJECTED: 'SYNC_REJECTED',
  AUTHORISATION_FAILURE: 'AUTHORISATION_FAILURE',
  RECEIPT_TOKEN_REFUSED: 'RECEIPT_TOKEN_REFUSED',
};

/** A finding a till's sync raised (`pos.OfflineSaleFlagged`, `OfflineShiftFlagged`, `OfflineCashMovementFlagged`). */
function posFinding(event: SourceEvent, subject: SubjectRef): Item[] {
  const p = event.payload;
  const sourceKind = str(p, 'exceptionKind') ?? 'UNKNOWN';
  const fact = (p['fact'] ?? {}) as Payload;
  const negative = sourceKind === 'STOCK_EXCEPTION' && fact['stockExceptionKind'] === 'NEGATIVE_STOCK';
  const kind: ExceptionKind = negative ? 'NEGATIVE_STOCK' : (POS_FLAG_KIND[sourceKind] ?? 'OFFLINE_SALE_REVIEW');
  const stockExceptionId = typeof fact['stockExceptionId'] === 'string' ? fact['stockExceptionId'] : null;
  return [
    {
      kind,
      sourceKind,
      severity: severityOf(p, 'REVIEW'),
      abuseCases: cases(p, negative ? [11, 36] : []),
      actorId: str(p, 'cashierId'),
      subject,
      amountPesewas: int(p, 'amountPesewas'),
      summary: str(p, 'summary') ?? sourceKind,
      details: {
        ...pick(p, ['shiftId', 'deviceId', 'deviceCounter', 'provisionalRef', 'kind', 'occurredAt']),
        register: p['register'] ?? null,
        claim: withoutPersonalData(p['claim'] ?? {}),
        fact: withoutPersonalData(fact),
      },
      // A stock exception is the same finding whether the sync or the queue names it first.
      ...(stockExceptionId === null ? {} : { sourceKey: `stock-exception:${stockExceptionId}` }),
    },
  ];
}

type Classifier = (event: SourceEvent) => Item[];

const p = (event: SourceEvent) => event.payload;

const CLASSIFIERS: Readonly<Record<string, Classifier>> = {
  // ORD: voids, overrides, returns, consents and backorders (abuse cases 1, 3, 12, 42, 53, 56, 67).
  'ord.SaleVoidRequested': (e) => [
    {
      kind: 'SALE_VOID',
      sourceKind: 'VOID_REQUESTED',
      severity: 'REVIEW',
      abuseCases: cases(p(e), [1]),
      actorId: str(p(e), 'requestedBy'),
      subject: ref(str(p(e), 'orderId'), 'SALES_ORDER'),
      amountPesewas: int(p(e), 'amountPesewas'),
      summary: `Void of ${str(p(e), 'orderNo') ?? 'a sale'}, ${cedis(int(p(e), 'amountPesewas'))}, requested`,
      details: pick(p(e), ['voidId', 'orderNo', 'reasonCode', 'approvalRequestId', 'cashierId']),
    },
  ],
  'ord.OrderVoided': (e) => [
    {
      kind: 'SALE_VOID',
      sourceKind: 'VOIDED',
      severity: 'REVIEW',
      abuseCases: cases(p(e), [1]),
      actorId: str(p(e), 'cashierId'),
      subject: ref(str(p(e), 'orderId'), 'SALES_ORDER'),
      amountPesewas: int(p(e), 'amountPesewas'),
      summary: `${str(p(e), 'orderNo') ?? 'A sale'} voided, ${cedis(int(p(e), 'amountPesewas'))}, credit note ${str(p(e), 'creditNoteNo') ?? ''}`.trim(),
      details: pick(p(e), ['voidId', 'orderNo', 'reasonCode', 'creditNoteId', 'creditNoteNo', 'approvalRequestId', 'requestedBy', 'voidedBy', 'cashierId']),
    },
  ],
  'ord.PriceOverrideRequested': (e) => [
    {
      kind: 'PRICE_OVERRIDE',
      sourceKind: 'OVERRIDE_REQUESTED',
      severity: 'INFO',
      abuseCases: cases(p(e), [3]),
      actorId: str(p(e), 'requestedBy'),
      subject: ref(str(p(e), 'orderId'), 'SALES_ORDER'),
      amountPesewas: abs(int(p(e), 'variancePesewas')),
      summary: `A price override of ${cedis(int(p(e), 'variancePesewas'))} on ${str(p(e), 'orderNo') ?? 'an order'}`,
      details: pick(p(e), ['orderNo', 'approvalRequestId', 'salespersonId', 'lines']),
    },
  ],
  'ord.PriceOverrideApproved': (e) => [
    {
      kind: 'PRICE_OVERRIDE',
      sourceKind: 'OVERRIDE_APPROVED',
      severity: 'INFO',
      abuseCases: cases(p(e), [3]),
      actorId: str(p(e), 'requestedBy'),
      subject: ref(str(p(e), 'orderId'), 'SALES_ORDER'),
      amountPesewas: abs(int(p(e), 'variancePesewas')),
      summary: `A price override of ${cedis(int(p(e), 'variancePesewas'))} approved`,
      details: pick(p(e), ['approvalRequestId', 'approvedBy']),
    },
  ],
  'ord.ReturnSubmitted': (e) => [
    {
      kind: 'SALE_RETURN',
      sourceKind: 'RETURN_SUBMITTED',
      severity: 'REVIEW',
      abuseCases: cases(p(e), [12, 56]),
      actorId: str(p(e), 'makerId'),
      subject: ref(str(p(e), 'orderId'), 'SALES_ORDER'),
      amountPesewas: int(p(e), 'totalRefundPesewas'),
      summary: `Return ${str(p(e), 'returnNo') ?? ''} submitted for ${cedis(int(p(e), 'totalRefundPesewas'))}`,
      details: pick(p(e), ['returnId', 'returnNo', 'reasonCode', 'approvalRequestId']),
    },
  ],
  'ord.ReturnCompleted': (e) => [
    {
      kind: 'SALE_RETURN',
      sourceKind: 'RETURN_COMPLETED',
      severity: 'REVIEW',
      abuseCases: cases(p(e), [12, 56]),
      actorId: str(p(e), 'makerId'),
      subject: ref(str(p(e), 'orderId'), 'SALES_ORDER'),
      amountPesewas: int(p(e), 'totalRefundPesewas'),
      summary: `Return ${str(p(e), 'returnNo') ?? ''} of ${str(p(e), 'orderNo') ?? 'an order'} completed, ${cedis(int(p(e), 'totalRefundPesewas'))} credited`,
      details: pick(p(e), ['returnId', 'returnNo', 'orderNo', 'reasonCode', 'creditNoteId', 'creditNoteNo', 'refundId', 'approvalRequestId', 'approvedBy']),
    },
  ],
  'ord.CustomerConsentAnswered': (e) => {
    const method = str(p(e), 'method');
    if (method === 'SIGNED_LINK' || method === 'CUSTOMER_ACCOUNT') return [];
    return [
      {
        kind: 'CONSENT_RECORDED_BY_STAFF',
        sourceKind: str(p(e), 'kind'),
        severity: 'INFO',
        abuseCases: [42],
        actorId: str(p(e), 'answeredBy'),
        subject: ref(str(p(e), 'orderId'), 'SALES_ORDER'),
        amountPesewas: null,
        summary: `The customer's ${p(e)['accepted'] === true ? 'yes' : 'no'} to a ${String(str(p(e), 'kind') ?? '').toLowerCase().replace('_', ' ')} on ${str(p(e), 'orderNo') ?? 'an order'} recorded by staff (${method ?? ''})`,
        details: pick(p(e), ['consentId', 'orderNo', 'kind', 'accepted', 'method']),
      },
    ];
  },
  'ord.OrderDispatched': (e) => backorder(e),
  'ord.OrderCollected': (e) => backorder(e),

  // POS: cash drops, shifts, the till's findings and its PIN (abuse cases 10, 11, 17, 35 to 39).
  'pos.CashDropped': (e) => {
    const unwitnessed = p(e)['unwitnessed'] === true;
    const amounts = (p(e)['amountsPesewas'] ?? {}) as Payload;
    return [
      {
        kind: 'CASH_DROP',
        sourceKind: unwitnessed ? 'UNWITNESSED_CASH_DROP' : 'WITNESSED_CASH_DROP',
        severity: unwitnessed ? 'REVIEW' : 'INFO',
        abuseCases: cases(p(e), [17]),
        actorId: str(p(e), 'cashierId'),
        subject: ref(str(p(e), 'shiftId'), 'SHIFT'),
        amountPesewas: int(amounts, 'drop'),
        summary: `${unwitnessed ? 'An unwitnessed' : 'A witnessed'} cash drop of ${cedis(int(amounts, 'drop'))}`,
        details: { ...pick(p(e), ['movementId', 'witnessId', 'occurredAt']), register: p(e)['register'] ?? null, witnessed: !unwitnessed },
      },
    ];
  },
  'pos.ShiftClosed': (e) => {
    const direction = str(p(e), 'overShortDirection');
    if (direction === 'EXACT') return [];
    const amount = abs(int(p(e), 'overShortPesewas'));
    return [
      {
        kind: 'SHIFT_OVER_SHORT',
        sourceKind: p(e)['forceClosed'] === true ? 'FORCE_CLOSED_COUNT' : direction,
        severity: 'REVIEW',
        abuseCases: cases(p(e), [17]),
        actorId: str(p(e), 'cashierId'),
        subject: ref(str(p(e), 'shiftId'), 'SHIFT'),
        amountPesewas: amount,
        summary: `Shift ${str(p(e), 'shiftNo') ?? ''} closed ${direction === 'OVER' ? 'over' : 'short'} by ${cedis(amount)}`,
        details: { ...pick(p(e), ['shiftNo', 'approvedBy', 'reason', 'declaredCashPesewas', 'expectedCashPesewas', 'overShortDirection', 'forceClosedBy']), register: p(e)['register'] ?? null },
      },
    ];
  },
  'pos.ShiftForceClosed': (e) => [
    {
      kind: 'SHIFT_OVER_SHORT',
      sourceKind: 'SHIFT_FORCE_CLOSED',
      severity: 'REVIEW',
      abuseCases: cases(p(e), [17]),
      actorId: str(p(e), 'cashierId'),
      subject: ref(str(p(e), 'shiftId'), 'SHIFT'),
      amountPesewas: int(p(e), 'expectedCashPesewas'),
      summary: `Shift ${str(p(e), 'shiftNo') ?? ''} force-closed with ${cedis(int(p(e), 'expectedCashPesewas'))} expected in the drawer`,
      details: { ...pick(p(e), ['shiftNo', 'forceClosedBy', 'reason', 'closedAt']), register: p(e)['register'] ?? null },
    },
  ],
  'pos.OfflineSaleFlagged': (e) => posFinding(e, { id: str(p(e), 'saleId') ?? e.subjectId, docType: 'SALES_ORDER' }),
  'pos.OfflineShiftFlagged': (e) => posFinding(e, { id: str(p(e), 'shiftId') ?? e.subjectId, docType: 'SHIFT' }),
  'pos.OfflineCashMovementFlagged': (e) => posFinding(e, { id: str(p(e), 'shiftId') ?? e.subjectId, docType: 'SHIFT' }),
  'pos.OfflineSaleRejected': (e) => [
    {
      kind: 'SYNC_REJECTED',
      sourceKind: str(p(e), 'rule'),
      severity: 'URGENT',
      abuseCases: cases(p(e), [10]),
      actorId: str(p(e), 'cashierId'),
      subject: ref(str(p(e), 'shiftId'), 'SHIFT'),
      amountPesewas: int(p(e), 'amountPesewas'),
      summary: `An offline sale ${str(p(e), 'provisionalRef') ?? ''} refused at sync (${str(p(e), 'rule') ?? ''})`,
      details: { ...pick(p(e), ['saleId', 'deviceId', 'deviceCounter', 'provisionalRef', 'rule', 'receivedHash', 'recomputedHash']), register: p(e)['register'] ?? null },
    },
  ],
  'pos.DeviceCounterGap': (e) => [
    {
      kind: 'DEVICE_COUNTER_GAP',
      severity: 'URGENT',
      abuseCases: cases(p(e), [10]),
      actorId: str(p(e), 'cashierId'),
      subject: ref(str(p(e), 'shiftId'), 'SHIFT'),
      amountPesewas: null,
      summary: `Till sales ${(Array.isArray(p(e)['missing']) ? (p(e)['missing'] as unknown[]) : []).join(', ')} have not arrived while later ones have`,
      details: { ...pick(p(e), ['deviceId', 'missing', 'highestSynced']), register: p(e)['register'] ?? null },
    },
  ],
  'pos.TillClockOutOfTolerance': (e) => [
    {
      kind: 'LATE_POSTING',
      sourceKind: 'TILL_CLOCK_OUT_OF_TOLERANCE',
      severity: 'REVIEW',
      abuseCases: [10],
      actorId: str(p(e), 'cashierId'),
      subject: ref(str(p(e), 'saleId'), 'SALES_ORDER'),
      amountPesewas: null,
      summary: `A till's clock was ${String(p(e)['differenceSeconds'] ?? '')} seconds from the server's`,
      details: { ...pick(p(e), ['shiftId', 'deviceId', 'tillTime', 'serverTime', 'differenceSeconds', 'toleranceSeconds']), register: p(e)['register'] ?? null },
    },
  ],
  'pos.TillPinFlagged': (e) => [
    {
      kind: 'AUTHORISATION_FAILURE',
      sourceKind: str(p(e), 'exceptionKind'),
      severity: severityOf(p(e), 'URGENT'),
      abuseCases: cases(p(e), [35]),
      actorId: str(p(e), 'principalId'),
      subject: ref(str(p(e), 'shiftId') ?? null, 'SHIFT'),
      amountPesewas: null,
      summary: str(p(e), 'summary') ?? 'A till PIN finding',
      details: { ...pick(p(e), ['deviceId', 'supervisorId', 'pinVersion', 'occurredAt']), register: p(e)['register'] ?? null },
    },
  ],

  // PAY: breaks, reversals, refunds and webhooks (abuse cases 4, 5, 12, 15, 32, 33, 45, 46, 73).
  'pay.ReconciliationBreakRaised': (e) => [breakItem(e)],
  'pay.BreakResolutionRequested': (e) => [
    {
      kind: 'RECONCILIATION_BREAK',
      sourceKind: 'RESOLUTION_REQUESTED',
      severity: 'REVIEW',
      abuseCases: [33],
      actorId: str(p(e), 'requestedBy'),
      subject: null,
      amountPesewas: int(p(e), 'amountPesewas'),
      summary: `A resolution of a ${str(p(e), 'kind') ?? ''} break asked for (${str(p(e), 'posting') ?? ''})`,
      details: pick(p(e), ['resolutionId', 'breakId', 'kind', 'posting', 'approvalRequestId']),
    },
  ],
  'pay.PaymentReversalRequested': (e) => [
    {
      kind: 'PAYMENT_REVERSAL',
      severity: 'REVIEW',
      abuseCases: cases(p(e), [32]),
      actorId: str(p(e), 'requestedBy'),
      subject: ref(str(p(e), 'paymentId'), 'PAYMENT'),
      amountPesewas: int(p(e), 'amountPesewas'),
      summary: `A reversal of a ${String(str(p(e), 'methodKind') ?? '').toLowerCase().replace('_', ' ')} payment of ${cedis(int(p(e), 'amountPesewas'))} asked for (${str(p(e), 'reasonCode') ?? ''})`,
      details: pick(p(e), ['reversalId', 'methodKind', 'reasonCode', 'approvalRequestId']),
    },
  ],
  'pay.RefundRequested': (e) => [
    {
      kind: 'REFUND',
      severity: 'REVIEW',
      abuseCases: cases(p(e), [12]),
      actorId: str(p(e), 'requestedBy'),
      subject: ref(str(p(e), 'paymentId'), 'PAYMENT'),
      amountPesewas: int(p(e), 'amountPesewas'),
      summary: `A refund of ${cedis(int(p(e), 'amountPesewas'))} asked for`,
      details: pick(p(e), ['refundId', 'approvalRequestId', 'creditNoteId', 'creditNoteMakerId']),
    },
  ],
  'pay.WebhookRejected': (e) => [
    {
      kind: 'WEBHOOK_REJECTED',
      sourceKind: str(p(e), 'outcome'),
      severity: 'URGENT',
      abuseCases: cases(p(e), [5]),
      actorId: null,
      subject: null,
      amountPesewas: null,
      summary: `A ${str(p(e), 'provider') ?? 'provider'} webhook was refused (${str(p(e), 'outcome') ?? ''})`,
      details: pick(p(e), ['webhookEventId', 'provider', 'outcome']),
    },
  ],
  'pay.UnverifiedPaymentOverdue': (e) => [
    {
      kind: 'UNMATCHED_PAYMENT',
      sourceKind: 'UNVERIFIED_OVERDUE',
      severity: 'URGENT',
      abuseCases: cases(p(e), [4]),
      actorId: null,
      subject: ref(str(p(e), 'paymentId'), 'PAYMENT'),
      amountPesewas: int(p(e), 'amountPesewas'),
      summary: `A payment of ${cedis(int(p(e), 'amountPesewas'))} taken unverified is still not verified`,
      details: pick(p(e), ['breakId', 'reference', 'urgentFrom']),
    },
  ],

  // WHL and BIL: credit, write-offs, credit notes and sends (abuse cases 14, 31, 41, 54, 62).
  'whl.CreditOverrideApproved': (e) => [
    {
      kind: 'CREDIT_OVERRIDE',
      severity: 'REVIEW',
      abuseCases: cases(p(e), [14, 54]),
      actorId: str(p(e), 'requestedBy'),
      subject: ref(str(p(e), 'orderId'), 'SALES_ORDER'),
      amountPesewas: int(p(e), 'overLimitPesewas'),
      summary: `A sale ${cedis(int(p(e), 'overLimitPesewas'))} over the customer's credit limit approved`,
      details: pick(p(e), ['creditOverrideId', 'customerId', 'limitPesewas', 'exposurePesewas', 'reasons', 'approvedBy']),
    },
  ],
  'whl.BadDebtWrittenOff': (e) => [
    {
      kind: 'BAD_DEBT_WRITE_OFF',
      severity: 'REVIEW',
      abuseCases: [41],
      actorId: str(p(e), 'requestedBy'),
      subject: ref(str(p(e), 'billingDocumentId'), 'INVOICE'),
      amountPesewas: int(p(e), 'amountPesewas'),
      summary: `${cedis(int(p(e), 'amountPesewas'))} of ${str(p(e), 'documentNo') ?? 'an invoice'} written off as a bad debt`,
      details: pick(p(e), ['writeOffId', 'customerId', 'documentNo', 'reason', 'approvedBy', 'writtenOffOn']),
    },
  ],
  'whl.WrittenOffCustomerPaid': (e) => [
    {
      kind: 'WRITTEN_OFF_CUSTOMER_PAID',
      severity: 'URGENT',
      abuseCases: [41],
      actorId: null,
      subject: ref(str(p(e), 'paymentId'), 'PAYMENT'),
      amountPesewas: int(p(e), 'amountPesewas'),
      summary: `Money arrived from a customer with ${cedis(int(p(e), 'writtenOffPesewas'))} written off`,
      details: pick(p(e), ['customerId', 'sourceEventType', 'writtenOffPesewas']),
    },
  ],
  'whl.StatementSendRequested': (e) => [
    {
      kind: 'DOCUMENT_SENT',
      sourceKind: 'STATEMENT',
      severity: 'INFO',
      abuseCases: [62],
      actorId: e.actorId,
      subject: ref(str(p(e), 'statementId'), 'CUSTOMER_STATEMENT'),
      amountPesewas: null,
      summary: 'A customer statement sent',
      details: pick(p(e), ['sendId', 'channels']),
    },
  ],
  'bil.CreditNoteIssued': (e) => [
    {
      kind: 'CREDIT_NOTE',
      sourceKind: str(p(e), 'reasonCode'),
      severity: 'REVIEW',
      abuseCases: cases(p(e), [31]),
      actorId: e.actorId,
      subject: ref(str(p(e), 'billingDocumentId'), 'CREDIT_NOTE'),
      amountPesewas: int(p(e), 'grossPesewas'),
      summary: `Credit note ${str(p(e), 'documentNo') ?? ''} for ${cedis(int(p(e), 'grossPesewas'))} (${str(p(e), 'reasonCode') ?? ''})`,
      details: pick(p(e), ['documentNo', 'customerId', 'originalDocumentId', 'reasonCode', 'approvalRequestId']),
    },
  ],
  'bil.DocumentSendRequested': (e) => [
    {
      kind: 'DOCUMENT_SENT',
      sourceKind: 'BILLING_DOCUMENT',
      severity: 'INFO',
      abuseCases: [62],
      actorId: e.actorId,
      subject: ref(str(p(e), 'billingDocumentId'), 'INVOICE'),
      amountPesewas: null,
      summary: `A billing document sent (copy ${String(p(e)['copyNo'] ?? '')})`,
      details: pick(p(e), ['sendId', 'copyNo', 'channels']),
    },
  ],

  // INV: adjustments, receipts without an order, opening stock, releases (abuse cases 7, 19, 21, 24, 26, 55).
  'inv.StockWrittenOff': (e) => stockAdjustment(e, 'down'),
  'inv.StockGainRecorded': (e) => stockAdjustment(e, 'up'),
  'inv.OpeningStockLoaded': (e) => [
    {
      kind: 'STOCK_ADJUSTMENT',
      sourceKind: 'OPENING_STOCK',
      severity: 'REVIEW',
      abuseCases: [26],
      actorId: e.actorId,
      subject: ref(str(p(e), 'sourceDocumentId'), 'STOCK_MOVEMENT'),
      amountPesewas: int(p(e), 'valuePesewas'),
      summary: `Opening stock loaded at ${cedis(int(p(e), 'valuePesewas'))}`,
      details: pick(p(e), ['movementId', 'movementType', 'productId', 'stockUnitId', 'qty']),
    },
  ],
  'inv.GoodsReceiptPosted': (e) => {
    if (str(p(e), 'kind') !== 'PURCHASE' || str(p(e), 'purchaseOrderId') !== null) return [];
    return [
      {
        kind: 'GOODS_RECEIPT_UNMATCHED',
        severity: 'REVIEW',
        abuseCases: [19],
        actorId: e.actorId,
        subject: ref(str(p(e), 'goodsReceiptId'), 'GOODS_RECEIPT'),
        amountPesewas: null,
        summary: 'A purchase receipt posted without a purchase order',
        details: pick(p(e), ['supplierId', 'locationId', 'receivedAt']),
      },
    ];
  },
  'inv.ReservationReleased': (e) => [
    {
      kind: 'STOCK_EXCEPTION',
      sourceKind: 'RESERVATION_RELEASED',
      severity: 'INFO',
      abuseCases: [24],
      actorId: e.actorId,
      subject: ref(str(p(e), 'holderDocumentId'), 'SALES_ORDER'),
      amountPesewas: null,
      summary: `A reservation of ${str(p(e), 'qty') ?? ''} released by hand (${str(p(e), 'reason') ?? ''})`,
      details: pick(p(e), ['reservationId', 'productId', 'stockUnitId', 'locationId', 'qty', 'reason']),
    },
  ],

  // LIV and PRC: deaths, a reused photograph, yield and reversals (abuse cases 2, 18, 29).
  'liv.MortalityReported': (e) => [
    {
      kind: 'MORTALITY',
      sourceKind: str(p(e), 'kind'),
      severity: p(e)['needsApproval'] === true ? 'REVIEW' : 'INFO',
      abuseCases: cases(p(e), [2]),
      actorId: str(p(e), 'reportedBy'),
      subject: ref(str(p(e), 'mortalityRecordId'), 'MORTALITY_RECORD'),
      amountPesewas: int(p(e), 'valuePesewas'),
      summary: `${String(p(e)['head'] ?? 1)} head reported ${str(p(e), 'kind') === 'CULL' ? 'culled' : 'dead'} (${str(p(e), 'reasonCode') ?? ''}), ${cedis(int(p(e), 'valuePesewas'))}`,
      details: pick(p(e), ['stockUnitId', 'locationId', 'head', 'reasonCode', 'thresholdPesewas', 'needsApproval', 'approvalKind', 'approvalRequestId']),
    },
  ],
  'liv.MortalityPhotoReused': (e) => [
    {
      kind: 'MORTALITY_PHOTO_REUSED',
      severity: 'URGENT',
      abuseCases: cases(p(e), [2]),
      actorId: str(p(e), 'reportedBy'),
      subject: ref(str(p(e), 'mortalityRecordId'), 'MORTALITY_RECORD'),
      amountPesewas: null,
      summary: `A death's photograph has the same bytes as ${(Array.isArray(p(e)['earlierMortalityRecordIds']) ? (p(e)['earlierMortalityRecordIds'] as unknown[]).length : 0)} earlier record(s)`,
      details: pick(p(e), ['stockUnitId', 'photoFileId', 'photoSha256', 'earlierMortalityRecordIds', 'matchedBy']),
    },
  ],
  'prc.YieldVarianceFlagged': (e) => [
    {
      kind: 'YIELD_VARIANCE',
      severity: 'REVIEW',
      abuseCases: cases(p(e), [18]),
      actorId: str(p(e), 'actorId'),
      subject: ref(str(p(e), 'processingOrderId'), 'PROCESSING_ORDER'),
      amountPesewas: null,
      summary: `Processing yield ${str(p(e), 'actualYieldPercent') ?? ''}% against ${str(p(e), 'expectedYieldPercent') ?? ''}% expected`,
      details: pick(p(e), ['inputWeightKg', 'expectedYieldPercent', 'actualYieldPercent', 'lines']),
    },
  ],
  'prc.ProcessingOrderReversed': (e) => [
    {
      kind: 'PROCESSING_REVERSAL',
      severity: p(e)['needsApproval'] === true ? 'REVIEW' : 'INFO',
      abuseCases: cases(p(e), [29]),
      actorId: str(p(e), 'actorId'),
      subject: ref(str(p(e), 'processingOrderId'), 'PROCESSING_ORDER'),
      amountPesewas: int(p(e), 'valuePesewas'),
      summary: `A processing order reversed at ${cedis(int(p(e), 'valuePesewas'))}: ${str(p(e), 'reason') ?? ''}`,
      details: pick(p(e), ['processingReversalId', 'thresholdPesewas', 'needsApproval', 'approvalRequestId', 'approvedBy', 'reason']),
    },
  ],

  // PUR: payout changes, variances, credit notes and claims (abuse cases 13, 19, 28, 34).
  'pur.SupplierPayoutChangeRequested': (e) => [payoutChange(e, 'SUPPLIER', 'REQUESTED')],
  'pur.SupplierPayoutChanged': (e) => [payoutChange(e, 'SUPPLIER', 'CHANGED')],
  'pur.SupplierInvoiceMismatched': (e) => [
    {
      kind: 'SUPPLIER_VARIANCE',
      sourceKind: 'MISMATCHED',
      severity: 'REVIEW',
      abuseCases: [19],
      actorId: e.actorId,
      subject: ref(str(p(e), 'supplierInvoiceId'), 'SUPPLIER_INVOICE'),
      amountPesewas: int(p(e), 'grossPesewas'),
      summary: `Supplier invoice ${str(p(e), 'supplierInvoiceNo') ?? ''} does not match its order or receipt`,
      details: pick(p(e), ['supplierId', 'supplierInvoiceNo', 'purchaseOrderId', 'lines']),
    },
  ],
  'pur.SupplierInvoiceMatched': (e) => supplierVariance(e),
  'pur.ExpenseInvoiceApproved': (e) => supplierVariance(e),
  'pur.SupplierCreditNoteApproved': (e) => [
    {
      kind: 'SUPPLIER_CREDIT_NOTE',
      severity: 'REVIEW',
      abuseCases: [28],
      actorId: e.actorId,
      subject: ref(str(p(e), 'creditNoteId'), 'SUPPLIER_CREDIT_NOTE'),
      amountPesewas: int(p(e), 'grossPesewas'),
      summary: `A supplier credit note of ${cedis(int(p(e), 'grossPesewas'))} against ${str(p(e), 'supplierInvoiceNo') ?? 'an invoice'} approved`,
      details: pick(p(e), ['supplierId', 'originalInvoiceId', 'supplierInvoiceNo', 'approvalRequestId', 'returns']),
    },
  ],
  'pur.SupplierClaimRaised': (e) => [
    {
      kind: 'RECEIPT_CLAIM',
      severity: 'REVIEW',
      abuseCases: cases(p(e), [34]),
      actorId: str(p(e), 'raisedBy'),
      subject: ref(str(p(e), 'goodsReceiptId'), 'GOODS_RECEIPT'),
      amountPesewas: int(p(e), 'claimedPesewas'),
      summary: `A claim of ${cedis(int(p(e), 'claimedPesewas'))} on rejected goods at the door`,
      details: pick(p(e), ['supplierClaimId', 'supplierId', 'purchaseOrderId', 'receivedBy', 'lines']),
    },
  ],

  // FIN: disposals at a loss and the trial balance's drift (abuse cases 15, 30).
  'fin.FixedAssetDisposed': (e) => {
    const loss = int(p(e), 'lossPesewas') ?? 0n;
    if (loss <= 0n) return [];
    return [
      {
        kind: 'ASSET_DISPOSAL',
        severity: 'REVIEW',
        abuseCases: cases(p(e), [30]),
        actorId: e.actorId,
        subject: ref(str(p(e), 'disposalId'), 'FIXED_ASSET_DISPOSAL'),
        amountPesewas: loss,
        summary: `Asset ${str(p(e), 'assetNo') ?? ''} disposed of at a loss of ${cedis(loss)}`,
        details: pick(p(e), ['fixedAssetId', 'assetNo', 'category', 'disposedOn', 'costPesewas', 'accumulatedPesewas', 'proceedsPesewas', 'proceedsMethod']),
      },
    ];
  },
  'fin.TrialBalanceDriftDetected': (e) => [
    {
      kind: 'AUDIT_INTEGRITY',
      sourceKind: 'TRIAL_BALANCE_DRIFT',
      severity: 'URGENT',
      abuseCases: [15],
      actorId: null,
      subject: null,
      amountPesewas: abs(int(p(e), 'signedSumPesewas')),
      summary: 'The nightly ledger check found the trial balance or a control account out of line',
      details: pick(p(e), ['signedSumPesewas', 'unbalancedEntries', 'controlBreaks', 'seriesGaps']),
    },
  ],

  // CAP: investor money (abuse cases 68 to 71), shown to holders of the investor books only.
  'cap.CapitalWithdrawn': (e) => [
    {
      kind: 'CAPITAL_WITHDRAWAL',
      severity: 'REVIEW',
      abuseCases: [68],
      actorId: str(p(e), 'requestedBy'),
      subject: ref(str(p(e), 'transactionId'), 'CAPITAL_TRANSACTION'),
      amountPesewas: int(p(e), 'amountPesewas'),
      summary: `${cedis(int(p(e), 'amountPesewas'))} of capital withdrawn by ${str(p(e), 'investorName') ?? 'an investor'}`,
      details: pick(p(e), ['transactionNo', 'investorId', 'investorName', 'units', 'valueDate', 'postingDate', 'requestedBy', 'approvedBy']),
      restrictedTo: INVESTOR_ITEM_PERMISSION,
    },
  ],
  'cap.CapitalContributed': (e) => {
    const valueDate = str(p(e), 'valueDate');
    const recordedOn = toBusinessDate(e.recordedAt);
    if (valueDate === null || valueDate >= recordedOn) return [];
    return [
      {
        kind: 'BACKDATED_CONTRIBUTION',
        severity: 'REVIEW',
        abuseCases: [69],
        actorId: e.actorId,
        subject: ref(str(p(e), 'transactionId'), 'CAPITAL_TRANSACTION'),
        amountPesewas: int(p(e), 'amountPesewas'),
        summary: `A contribution of ${cedis(int(p(e), 'amountPesewas'))} recorded on ${recordedOn} with a value date of ${valueDate}`,
        details: { ...pick(p(e), ['transactionNo', 'investorId', 'investorName', 'units', 'valueDate', 'postingDate']), recordedOn },
        restrictedTo: INVESTOR_ITEM_PERMISSION,
      },
    ];
  },
  'cap.DistributionDeclared': (e) => {
    const items: Item[] = [
      {
        kind: 'DISTRIBUTION',
        sourceKind: 'DECLARED',
        severity: 'REVIEW',
        abuseCases: [68],
        actorId: str(p(e), 'draftedBy'),
        subject: ref(str(p(e), 'runId'), 'DISTRIBUTION_RUN'),
        amountPesewas: int(p(e), 'distributablePesewas'),
        summary: `Distribution ${str(p(e), 'runNo') ?? ''} of ${cedis(int(p(e), 'distributablePesewas'))} posted for ${str(p(e), 'periodStart') ?? ''} to ${str(p(e), 'periodEnd') ?? ''}`,
        details: pick(p(e), ['runNo', 'periodStart', 'periodEnd', 'draftedBy', 'approvedBy', 'retentionRatePercent', 'lines']),
        restrictedTo: INVESTOR_ITEM_PERMISSION,
      },
    ];
    const rate = str(p(e), 'retentionRatePercent');
    if (rate !== null && Number(rate) !== Number(OWNER_RETENTION_PERCENT)) {
      items.push({
        kind: 'RETENTION_RATE',
        severity: 'REVIEW',
        abuseCases: [69],
        actorId: str(p(e), 'draftedBy'),
        subject: ref(str(p(e), 'runId'), 'DISTRIBUTION_RUN'),
        amountPesewas: int(p(e), 'distributablePesewas'),
        summary: `Distribution ${str(p(e), 'runNo') ?? ''} retained ${rate}% of profit, not the owner's ${OWNER_RETENTION_PERCENT}%`,
        details: { ...pick(p(e), ['runNo', 'draftedBy', 'approvedBy']), retentionRatePercent: rate, ownerRatePercent: OWNER_RETENTION_PERCENT },
        restrictedTo: INVESTOR_ITEM_PERMISSION,
      });
    }
    return items;
  },
  'cap.DistributionPaid': (e) => [
    {
      kind: 'DISTRIBUTION',
      sourceKind: 'PAID',
      severity: 'INFO',
      abuseCases: [68],
      actorId: e.actorId,
      subject: ref(str(p(e), 'runId'), 'DISTRIBUTION_RUN'),
      amountPesewas: int(p(e), 'amountPesewas'),
      summary: `${cedis(int(p(e), 'amountPesewas'))} of distribution ${str(p(e), 'runNo') ?? ''} paid to ${str(p(e), 'investorName') ?? 'an investor'}`,
      details: pick(p(e), ['paymentId', 'runNo', 'lineId', 'investorId', 'investorName', 'bankAccountId', 'externalReference']),
      restrictedTo: INVESTOR_ITEM_PERMISSION,
    },
  ],
  'cap.InvestorPayoutChangeRequested': (e) => [payoutChange(e, 'INVESTOR', 'REQUESTED')],
  'cap.InvestorPayoutChanged': (e) => [payoutChange(e, 'INVESTOR', 'CHANGED')],
  'cap.LoanDrawn': (e) => [financing(e, 'DRAWN')],
  'cap.GrantReceived': (e) => [financing(e, 'RECEIVED')],
  'cap.LoanRepaid': (e) => [
    {
      kind: 'LOAN_OR_GRANT',
      sourceKind: 'REPAID',
      severity: 'INFO',
      abuseCases: [71],
      actorId: str(p(e), 'recordedBy'),
      subject: ref(str(p(e), 'financingId'), 'FINANCING'),
      amountPesewas: (int(p(e), 'principalPesewas') ?? 0n) + (int(p(e), 'interestPesewas') ?? 0n),
      summary: `${str(p(e), 'financingNo') ?? 'A loan'} repaid: principal ${cedis(int(p(e), 'principalPesewas'))}, interest ${cedis(int(p(e), 'interestPesewas'))}`,
      details: pick(p(e), ['repaymentId', 'financingNo', 'lenderName', 'principalPesewas', 'interestPesewas', 'postingDate', 'recordedBy']),
      restrictedTo: INVESTOR_ITEM_PERMISSION,
    },
  ],
  'cap.FinancingAccrualBlocked': (e) => [
    {
      kind: 'ACCRUAL_BLOCKED',
      severity: 'URGENT',
      abuseCases: [71],
      actorId: null,
      subject: ref(str(p(e), 'financingId'), 'FINANCING'),
      amountPesewas: null,
      summary: `The month to ${str(p(e), 'monthEnd') ?? ''} of ${str(p(e), 'financingNo') ?? 'a loan or grant'} could not be accrued: its period is not open`,
      details: pick(p(e), ['financingNo', 'monthEnd']),
      restrictedTo: INVESTOR_ITEM_PERMISSION,
      // One item per month, however many daily runs find it.
      sourceKey: `accrual-blocked:${str(p(e), 'financingId') ?? e.subjectId}:${str(p(e), 'monthEnd') ?? ''}`,
    },
  ],

  // CST (abuse case 72).
  'cst.OverheadAllocated': (e) => [
    {
      kind: 'OVERHEAD_ALLOCATION',
      sourceKind: str(p(e), 'costElement'),
      severity: 'REVIEW',
      abuseCases: cases(p(e), [72]),
      actorId: str(p(e), 'makerId'),
      subject: ref(str(p(e), 'runId'), 'OVERHEAD_ALLOCATION'),
      amountPesewas: int(p(e), 'capitalisedPesewas'),
      summary: `${cedis(int(p(e), 'capitalisedPesewas'))} of ${String(str(p(e), 'costElement') ?? '').toLowerCase()} for ${str(p(e), 'periodStart') ?? ''} to ${str(p(e), 'periodEnd') ?? ''} moved into stock, ${cedis(int(p(e), 'expensedPesewas'))} expensed`,
      details: pick(p(e), ['costElement', 'periodStart', 'periodEnd', 'totalPesewas', 'capitalisedPesewas', 'expensedPesewas', 'makerId', 'checkerId']),
    },
  ],
  'cst.ProjectionDriftDetected': (e) => {
    const revenue = (int(p(e), 'revenueProjectedPesewas') ?? 0n) - (int(p(e), 'revenueLedgerPesewas') ?? 0n);
    const cost = (int(p(e), 'costOfSalesProjectedPesewas') ?? 0n) - (int(p(e), 'costOfSalesLedgerPesewas') ?? 0n);
    return [
      {
        kind: 'PROJECTION_DRIFT',
        sourceKind: str(p(e), 'projection'),
        severity: 'URGENT',
        abuseCases: [15, 72],
        actorId: null,
        subject: null,
        amountPesewas: (revenue < 0n ? -revenue : revenue) + (cost < 0n ? -cost : cost),
        summary: `The margin projection does not tie to the ledger for ${str(p(e), 'from') ?? ''} to ${str(p(e), 'to') ?? ''}`,
        details: pick(p(e), ['projection', 'from', 'to', 'revenueProjectedPesewas', 'revenueLedgerPesewas', 'costOfSalesProjectedPesewas', 'costOfSalesLedgerPesewas']),
      },
    ];
  },

  // DEL: the driver's cash and goods, reassignments and the proof's files (abuse cases 6, 43, 44, 47 to 51).
  'del.DriverCashRemitted': (e) => {
    if (str(p(e), 'varianceDirection') === 'EXACT') return [];
    const short = int(p(e), 'shortPesewas') ?? 0n;
    const over = int(p(e), 'overPesewas') ?? 0n;
    return [
      {
        kind: 'DRIVER_VARIANCE',
        sourceKind: `HAND_IN_${str(p(e), 'varianceDirection') ?? ''}`,
        severity: short > 0n ? 'URGENT' : 'REVIEW',
        abuseCases: cases(p(e), [6, 47]),
        actorId: str(p(e), 'driverId'),
        subject: ref(str(p(e), 'reconciliationId'), 'DRIVER_CASH_RECONCILIATION'),
        amountPesewas: short > 0n ? short : over,
        summary: `${str(p(e), 'driverName') ?? 'A driver'} handed in ${cedis(int(p(e), 'receivedPesewas'))} of ${cedis(int(p(e), 'expectedPesewas'))} collected`,
        details: { ...pick(p(e), ['receivedBy', 'shiftId', 'expectedPesewas', 'receivedPesewas', 'shortPesewas', 'overPesewas', 'varianceDirection', 'proofIds', 'handedInAt']), register: p(e)['register'] ?? null },
      },
    ];
  },
  'del.DeliveryCompleted': (e) => {
    const items: Item[] = [];
    const short = int(p(e), 'codShortPesewas') ?? 0n;
    if (short > 0n) {
      items.push({
        kind: 'DRIVER_VARIANCE',
        sourceKind: 'COD_SHORT',
        severity: 'REVIEW',
        abuseCases: [6, 43],
        actorId: str(p(e), 'driverId'),
        subject: ref(str(p(e), 'deliveryId'), 'DELIVERY'),
        amountPesewas: short,
        summary: `${str(p(e), 'deliveryNo') ?? 'A delivery'} collected ${cedis(int(p(e), 'codCollectedPesewas'))} of ${cedis(int(p(e), 'codDuePesewas'))} due (${str(p(e), 'codVarianceReasonCode') ?? ''})`,
        details: pick(p(e), ['deliveryNo', 'proofId', 'codDuePesewas', 'codCollectedPesewas', 'codVarianceReasonCode']),
      });
    }
    const returned = Array.isArray(p(e)['returnedLines']) ? (p(e)['returnedLines'] as unknown[]) : [];
    if (returned.length > 0) {
      items.push({
        kind: 'PART_DELIVERY',
        severity: 'REVIEW',
        abuseCases: [51],
        actorId: str(p(e), 'driverId'),
        subject: ref(str(p(e), 'deliveryId'), 'DELIVERY'),
        amountPesewas: int(p(e), 'returnedCreditPesewas'),
        summary: `${str(p(e), 'deliveryNo') ?? 'A delivery'} part delivered: ${returned.length} line(s) came back, ${cedis(int(p(e), 'returnedCreditPesewas'))} credited (${str(p(e), 'returnedReasonCode') ?? ''})`,
        details: pick(p(e), ['deliveryNo', 'proofId', 'returnedLines', 'returnedReasonCode', 'vehicleLocationId']),
      });
    }
    return items;
  },
  'del.DeliveryFailed': (e) => [
    {
      kind: 'DELIVERY_FAILURE',
      sourceKind: str(p(e), 'failureReasonCode'),
      severity: 'INFO',
      abuseCases: [48],
      actorId: str(p(e), 'driverId'),
      subject: ref(str(p(e), 'deliveryId'), 'DELIVERY'),
      amountPesewas: null,
      summary: `${str(p(e), 'deliveryNo') ?? 'A delivery'} failed at attempt ${String(p(e)['attemptNo'] ?? '')} (${str(p(e), 'failureReasonCode') ?? ''}); next: ${str(p(e), 'nextAction') ?? ''}`,
      details: pick(p(e), ['deliveryNo', 'attemptNo', 'failureReasonCode', 'nextAction', 'occurredAt']),
    },
  ],
  'del.DeliveryWrittenOff': (e) => [
    {
      kind: 'DELIVERY_WRITE_OFF',
      sourceKind: p(e)['unaccounted'] === true ? 'UNACCOUNTED' : 'ACCOUNTED',
      severity: p(e)['unaccounted'] === true ? 'URGENT' : 'REVIEW',
      abuseCases: cases(p(e), [49]),
      actorId: str(p(e), 'driverId'),
      subject: ref(str(p(e), 'deliveryId'), 'DELIVERY'),
      amountPesewas: int(p(e), 'valuePesewas'),
      summary: `Goods of ${str(p(e), 'deliveryNo') ?? 'a delivery'} written off from the van at ${cedis(int(p(e), 'valuePesewas'))} (${str(p(e), 'reasonCode') ?? ''})`,
      details: pick(p(e), ['deliveryNo', 'vehicleLocationId', 'reasonCode', 'stockAdjustmentId', 'unaccounted']),
    },
  ],
  'del.DeliveryReturned': (e) => [
    {
      kind: 'DELIVERY_RETURN',
      severity: 'INFO',
      abuseCases: [49],
      actorId: str(p(e), 'driverId'),
      subject: ref(str(p(e), 'deliveryId'), 'DELIVERY'),
      amountPesewas: null,
      summary: `The goods of ${str(p(e), 'deliveryNo') ?? 'a delivery'} returned from the van to the returns hold`,
      details: pick(p(e), ['deliveryNo', 'vehicleLocationId', 'returnsLocationId']),
    },
  ],
  'del.DeliveryReassigned': (e) => [
    {
      kind: 'DELIVERY_REASSIGNED',
      sourceKind: 'REASSIGNED',
      severity: 'INFO',
      abuseCases: [50],
      actorId: e.actorId,
      subject: ref(str(p(e), 'deliveryId'), 'DELIVERY'),
      amountPesewas: null,
      summary: `${str(p(e), 'deliveryNo') ?? 'A delivery'} given to another driver or van`,
      details: pick(p(e), ['deliveryNo', 'fromDriverId', 'toDriverId', 'fromVehicleLocationId', 'toVehicleLocationId']),
    },
  ],
  'del.DeliveryRescheduled': (e) => [
    {
      kind: 'DELIVERY_REASSIGNED',
      sourceKind: p(e)['reattempt'] === true ? 'REATTEMPT' : 'RESCHEDULED',
      severity: 'INFO',
      abuseCases: [50],
      actorId: e.actorId,
      subject: ref(str(p(e), 'deliveryId'), 'DELIVERY'),
      amountPesewas: null,
      summary: `${str(p(e), 'deliveryNo') ?? 'A delivery'} moved to ${str(p(e), 'slotDate') ?? 'another slot'}: ${str(p(e), 'reason') ?? ''}`,
      details: pick(p(e), ['deliveryNo', 'fromSlotId', 'toSlotId', 'slotDate', 'reattempt', 'reason']),
    },
  ],
  'del.DeliveryCancelled': (e) => [
    {
      kind: 'DELIVERY_CANCELLED',
      severity: 'REVIEW',
      abuseCases: [51],
      actorId: e.actorId,
      subject: ref(str(p(e), 'deliveryId'), 'DELIVERY'),
      amountPesewas: null,
      summary: `${str(p(e), 'deliveryNo') ?? 'A delivery'} cancelled before it left (${str(p(e), 'reasonCode') ?? ''})`,
      details: pick(p(e), ['deliveryNo', 'driverId', 'vehicleLocationId', 'returnsLocationId', 'reasonCode']),
    },
  ],
  'del.ProofFileReused': (e) => [
    {
      kind: 'DELIVERY_PHOTO_REUSED',
      sourceKind: str(p(e), 'file'),
      severity: 'URGENT',
      abuseCases: cases(p(e), [44]),
      actorId: str(p(e), 'driverId'),
      subject: ref(str(p(e), 'deliveryId'), 'DELIVERY'),
      amountPesewas: null,
      summary: `The ${str(p(e), 'file') === 'SIGNATURE' ? 'signature' : 'photograph'} on the proof of ${str(p(e), 'deliveryNo') ?? 'a delivery'} was used before: the same bytes as ${(Array.isArray(p(e)['earlierFileIds']) ? (p(e)['earlierFileIds'] as unknown[]).length : 0)} earlier upload(s), on ${(Array.isArray(p(e)['earlierProofIds']) ? (p(e)['earlierProofIds'] as unknown[]).length : 0)} earlier proof(s)`,
      details: pick(p(e), ['deliveryNo', 'proofId', 'file', 'fileId', 'sha256', 'earlierFileIds', 'earlierProofIds', 'matchedBy']),
    },
  ],

  // QUO (abuse cases 40, 64 to 66).
  'quo.QuoteIssued': (e) => {
    const holds = (Array.isArray(p(e)['holds']) ? (p(e)['holds'] as Payload[]) : []).filter((h) => typeof h['heldQty'] === 'string' && Number(h['heldQty']) > 0);
    if (holds.length === 0) return [];
    return [
      {
        kind: 'QUOTE_HOLD',
        severity: 'INFO',
        abuseCases: [64],
        actorId: str(p(e), 'salespersonId'),
        subject: ref(str(p(e), 'quoteId'), 'QUOTE'),
        amountPesewas: int(p(e), 'grossPesewas'),
        summary: `Quote ${str(p(e), 'quoteNo') ?? ''} v${String(p(e)['versionNo'] ?? '')} holds stock on ${holds.length} line(s) until ${str(p(e), 'validUntil') ?? ''}`,
        details: { ...pick(p(e), ['quoteNo', 'versionId', 'versionNo', 'customerId', 'validUntil']), holds },
      },
    ];
  },
  'quo.QuoteWithdrawn': (e) => [
    {
      kind: 'QUOTE_WITHDRAWN',
      sourceKind: str(p(e), 'fromStatus'),
      severity: p(e)['wasIssued'] === true ? 'REVIEW' : 'INFO',
      abuseCases: cases(p(e), [65]),
      actorId: str(p(e), 'withdrawnBy'),
      subject: ref(str(p(e), 'quoteId'), 'QUOTE'),
      amountPesewas: int(p(e), 'grossPesewas'),
      summary: `Quote ${str(p(e), 'quoteNo') ?? ''} withdrawn from ${str(p(e), 'fromStatus') ?? ''}: ${str(p(e), 'reason') ?? ''}`,
      details: pick(p(e), ['quoteNo', 'salespersonId', 'reason', 'fromStatus', 'wasIssued', 'heldReleasedQty']),
    },
  ],
  'quo.AcceptedQuoteLapsed': (e) => [
    {
      kind: 'ACCEPTED_QUOTE_LAPSED',
      sourceKind: str(p(e), 'acceptanceMethod'),
      severity: 'REVIEW',
      abuseCases: cases(p(e), [66]),
      actorId: str(p(e), 'salespersonId'),
      subject: ref(str(p(e), 'quoteId'), 'QUOTE'),
      amountPesewas: int(p(e), 'grossPesewas'),
      summary: `Quote ${str(p(e), 'quoteNo') ?? ''} accepted on ${str(p(e), 'acceptedAt') ?? ''} was never converted; its hold of ${str(p(e), 'heldReleasedQty') ?? ''} released`,
      details: pick(p(e), ['quoteNo', 'acceptedVersionId', 'acceptedAt', 'acceptanceMethod', 'heldReleasedQty']),
    },
  ],
  'quo.QuoteLinkDecidedFromStaffAddress': (e) => [
    {
      kind: 'QUOTE_ACCEPTED_BY_STAFF',
      sourceKind: str(p(e), 'decision'),
      severity: p(e)['sameBrowser'] === true ? 'URGENT' : 'REVIEW',
      abuseCases: cases(p(e), [40]),
      actorId: str(p(e), 'salespersonId'),
      subject: ref(str(p(e), 'quoteId'), 'QUOTE'),
      amountPesewas: int(p(e), 'grossPesewas'),
      summary: `Quote ${str(p(e), 'quoteNo') ?? ''} ${str(p(e), 'decision') === 'DECLINED' ? 'declined' : 'accepted'} through its link from an address with a staff session in the last 24 hours${p(e)['sameBrowser'] === true ? ', in the same browser' : ''}`,
      details: pick(p(e), ['quoteNo', 'versionNo', 'linkId', 'linkDecisionId', 'decision', 'staff', 'sameBrowser', 'windowHours']),
    },
  ],

  // NTF (abuse cases 57 to 63).
  'ntf.MessageSuppressed': (e) => [
    {
      kind: 'MESSAGE_SUPPRESSED',
      sourceKind: str(p(e), 'reason'),
      severity: str(p(e), 'reason') === 'RATE_LIMITED' ? 'REVIEW' : 'INFO',
      abuseCases: cases(p(e), []),
      actorId: null,
      subject: ref(str(p(e), 'salesOrderId'), 'SALES_ORDER'),
      amountPesewas: null,
      summary: `A ${str(p(e), 'channel') ?? ''} message ${str(p(e), 'templateCode') ?? ''} held back (${str(p(e), 'reason') ?? ''})`,
      details: pick(p(e), ['messageId', 'templateCode', 'channel', 'reason', 'sourceEventType']),
    },
  ],
  'ntf.MessageFailed': (e) => [
    {
      kind: 'MESSAGE_FAILED',
      severity: 'REVIEW',
      abuseCases: [58, 62, 63],
      actorId: null,
      subject: ref(str(p(e), 'salesOrderId'), 'SALES_ORDER'),
      amountPesewas: null,
      summary: `A ${str(p(e), 'channel') ?? ''} message ${str(p(e), 'templateCode') ?? ''} failed after ${String(p(e)['attempts'] ?? '')} attempt(s)`,
      details: pick(p(e), ['messageId', 'templateCode', 'channel', 'attempts', 'reason', 'failedAt']),
    },
  ],
  'ntf.DeliveryReportRejected': (e) => [
    {
      kind: 'MESSAGE_REPORT_REJECTED',
      sourceKind: str(p(e), 'outcome'),
      severity: 'URGENT',
      abuseCases: cases(p(e), [57]),
      actorId: null,
      subject: null,
      amountPesewas: null,
      summary: `A ${str(p(e), 'provider') ?? 'provider'} delivery report was refused (${str(p(e), 'outcome') ?? ''})`,
      details: pick(p(e), ['reportId', 'provider', 'outcome']),
    },
  ],

  // IAM: who changed whose permissions (abuse case 16).
  'iam.RoleGranted': (e) => [grantChange(e)],
  'iam.RoleRevoked': (e) => [grantChange(e)],
  'iam.RoleChanged': (e) => [
    {
      kind: 'PERMISSION_CHANGE',
      sourceKind: `ROLE_${str(p(e), 'change') ?? 'CHANGED'}`,
      severity: 'REVIEW',
      abuseCases: [16],
      actorId: e.actorId,
      subject: null,
      amountPesewas: null,
      summary: `Role ${str(p(e), 'roleCode') ?? ''} ${String(str(p(e), 'change') ?? 'changed').toLowerCase()}: ${(p(e)['added'] as unknown[] | undefined)?.length ?? 0} permission(s) added, ${(p(e)['removed'] as unknown[] | undefined)?.length ?? 0} removed`,
      details: pick(p(e), ['roleId', 'roleCode', 'change', 'added', 'removed']),
    },
  ],
};

/** The owner's retention rate (ADR-0028): a run retaining anything else is an item (abuse case 69). */
export const OWNER_RETENTION_PERCENT = '40.00';

function backorder(e: SourceEvent): Item[] {
  const held = str(p(e), 'backorderHeldQty');
  if (held === null || !(Number(held) > 0)) return [];
  return [
    {
      kind: 'BACKORDER_HELD',
      sourceKind: e.type === 'ord.OrderCollected' ? 'COLLECTED' : 'DISPATCHED',
      severity: 'INFO',
      abuseCases: [53, 67],
      actorId: e.actorId,
      subject: ref(str(p(e), 'orderId'), 'SALES_ORDER'),
      amountPesewas: null,
      summary: `${str(p(e), 'orderNo') ?? 'An order'} left with ${held} held back for its backorder ${str(p(e), 'backorderNo') ?? ''}`.trim(),
      details: pick(p(e), ['orderNo', 'backorderId', 'backorderNo', 'backorderHeldQty', 'deliveryNo']),
    },
  ];
}

function breakItem(e: SourceEvent): Item {
  const kind = str(p(e), 'kind') ?? 'UNKNOWN';
  const unmatched = kind === 'UNMATCHED_PAYMENT';
  const breakId = str(p(e), 'breakId') ?? e.subjectId;
  return {
    kind: unmatched ? 'UNMATCHED_PAYMENT' : 'RECONCILIATION_BREAK',
    sourceKind: kind,
    severity: severityOf(p(e), 'REVIEW'),
    abuseCases: cases(p(e), unmatched ? [4, 33] : [15, 33]),
    actorId: null,
    subject: str(p(e), 'paymentId') !== null ? ref(str(p(e), 'paymentId'), 'PAYMENT') : ref(str(p(e), 'sourceDocumentId') ?? null, 'PAYMENT_DOCUMENT'),
    amountPesewas: int(p(e), 'amountPesewas'),
    summary: `A ${kind.toLowerCase().replaceAll('_', ' ')} break${str(p(e), 'reference') === null ? '' : ` on ${str(p(e), 'reference')}`}${int(p(e), 'amountPesewas') === null ? '' : ` of ${cedis(int(p(e), 'amountPesewas'))}`}`,
    details: { ...pick(p(e), ['breakId', 'kind', 'paymentId', 'refundId', 'reference', 'sourceDocumentId', 'settlementLineId', 'bankStatementLineId']), breakDetails: withoutPersonalData(p(e)['details'] ?? {}) },
    sourceKey: `break:${breakId}`,
  };
}

/** A reconciliation break read from `pay.pub_reconciliation_break` by the sweep, for one the event did not bring. */
export interface BreakRow {
  readonly id: string;
  readonly kind: string;
  readonly branchId: string | null;
  readonly paymentId: string | null;
  readonly refundId: string | null;
  readonly reference: string | null;
  readonly sourceDocumentId: string | null;
  readonly amountPesewas: bigint | null;
  readonly raisedAt: Date;
}

export function breakFromView(row: BreakRow): ExceptionDraft {
  const event: SourceEvent = {
    id: row.id,
    type: 'pay.pub_reconciliation_break',
    recordedAt: row.raisedAt,
    actorId: '',
    branchId: row.branchId,
    subjectType: 'ReconciliationBreak',
    subjectId: row.id,
    payload: {
      breakId: row.id,
      kind: row.kind,
      branchId: row.branchId,
      paymentId: row.paymentId,
      refundId: row.refundId,
      reference: row.reference,
      sourceDocumentId: row.sourceDocumentId,
      amountPesewas: row.amountPesewas === null ? null : row.amountPesewas.toString(),
    },
  };
  const [draft] = drafts(event, [breakItem(event)]);
  return { ...draft!, details: { ...draft!.details, sourceEvent: null, sourceView: 'pay.pub_reconciliation_break' } };
}

function stockAdjustment(e: SourceEvent, direction: 'down' | 'up'): Item[] {
  const reason = str(p(e), 'reasonCode');
  const reversal = str(p(e), 'reversesMovementId') !== null;
  return [
    {
      kind: 'STOCK_ADJUSTMENT',
      sourceKind: str(p(e), 'movementType'),
      severity: direction === 'down' ? 'REVIEW' : 'INFO',
      abuseCases: [...new Set([7, ...(reason === 'BREAKAGE' ? [55] : []), ...(reversal ? [21] : [])])].sort((a, b) => a - b),
      actorId: e.actorId,
      subject: ref(str(p(e), 'sourceDocumentId'), 'STOCK_ADJUSTMENT'),
      amountPesewas: abs(int(p(e), 'valuePesewas')),
      summary: `Stock ${direction === 'down' ? 'written off' : 'gained'} by ${str(p(e), 'movementType') ?? 'a movement'} at ${cedis(int(p(e), 'valuePesewas'))}${reason === null ? '' : ` (${reason})`}`,
      details: pick(p(e), ['movementId', 'movementType', 'productId', 'stockUnitId', 'fromLocationId', 'toLocationId', 'qty', 'reasonCode', 'reversesMovementId']),
    },
  ];
}

function payoutChange(e: SourceEvent, party: 'SUPPLIER' | 'INVESTOR', step: 'REQUESTED' | 'CHANGED'): Item {
  const partyId = party === 'SUPPLIER' ? str(p(e), 'supplierId') : str(p(e), 'investorId');
  return {
    kind: 'PAYOUT_DETAIL_CHANGE',
    sourceKind: `${party}_${step}`,
    severity: step === 'CHANGED' ? 'URGENT' : 'REVIEW',
    abuseCases: party === 'SUPPLIER' ? [13] : [70],
    actorId: str(p(e), 'requestedBy'),
    subject: ref(str(p(e), 'payoutChangeId'), party === 'SUPPLIER' ? 'SUPPLIER_PAYOUT_CHANGE' : 'INVESTOR_PAYOUT_CHANGE'),
    amountPesewas: null,
    summary: `A ${party.toLowerCase()}'s payout details ${step === 'CHANGED' ? 'changed' : 'change asked for'}: ${str(p(e), 'previousPayoutMasked') ?? 'none'} to ${str(p(e), 'payoutMasked') ?? ''}`,
    details: { party, partyId, ...pick(p(e), ['approvalRequestId', 'method', 'previousPayoutMasked', 'payoutMasked', 'requestedBy', 'approvedBy']) },
    restrictedTo: party === 'INVESTOR' ? INVESTOR_ITEM_PERMISSION : null,
  };
}

function supplierVariance(e: SourceEvent): Item[] {
  if (str(p(e), 'varianceApprovalRequestId') === null) return [];
  return [
    {
      kind: 'SUPPLIER_VARIANCE',
      sourceKind: e.type === 'pur.ExpenseInvoiceApproved' ? 'EXPENSE_INVOICE' : 'SUPPLIER_INVOICE',
      severity: 'REVIEW',
      abuseCases: [28],
      actorId: e.actorId,
      subject: ref(str(p(e), 'supplierInvoiceId'), 'SUPPLIER_INVOICE'),
      amountPesewas: int(p(e), 'grossPesewas'),
      summary: `Supplier invoice ${str(p(e), 'supplierInvoiceNo') ?? ''} of ${cedis(int(p(e), 'grossPesewas'))} approved on a variance`,
      details: pick(p(e), ['supplierId', 'supplierInvoiceNo', 'purchaseOrderId', 'invoiceDate', 'varianceApprovalRequestId']),
    },
  ];
}

function financing(e: SourceEvent, step: 'DRAWN' | 'RECEIVED'): Item {
  return {
    kind: 'LOAN_OR_GRANT',
    sourceKind: step === 'DRAWN' ? 'LOAN_DRAWN' : 'GRANT_RECEIVED',
    severity: 'REVIEW',
    abuseCases: [71],
    actorId: str(p(e), 'recordedBy'),
    subject: ref(str(p(e), 'financingId'), 'FINANCING'),
    amountPesewas: int(p(e), 'amountPesewas'),
    summary: `${str(p(e), 'financingNo') ?? 'A financing'} from ${str(p(e), 'lenderName') ?? 'a lender'}: ${cedis(int(p(e), 'amountPesewas'))} ${step === 'DRAWN' ? 'drawn' : 'received'}`,
    details: pick(p(e), ['financingNo', 'kind', 'lenderName', 'bankAccountId', 'postingDate', 'recordedBy', 'approvedBy']),
    restrictedTo: INVESTOR_ITEM_PERMISSION,
  };
}

function grantChange(e: SourceEvent): Item {
  const change = str(p(e), 'change') ?? (e.type === 'iam.RoleRevoked' ? 'REVOKED' : 'GRANTED');
  return {
    kind: 'PERMISSION_CHANGE',
    sourceKind: `GRANT_${change}`,
    severity: 'REVIEW',
    abuseCases: [16],
    actorId: e.actorId,
    subject: null,
    amountPesewas: null,
    summary: `Role ${str(p(e), 'roleCode') ?? ''} ${change === 'REVOKED' ? 'revoked from' : 'granted to'} a person${e.actorId === str(p(e), 'principalId') ? ' by themselves' : ''}`,
    details: { ...pick(p(e), ['grantId', 'change', 'principalId', 'roleCode', 'locationId']), selfGrant: e.actorId === str(p(e), 'principalId') },
    branchId: str(p(e), 'branchId') ?? e.branchId,
  };
}

/** The event types the projector reads for items (the consumer's subscription). */
export const CLASSIFIED_EVENT_TYPES: readonly string[] = Object.keys(CLASSIFIERS).sort();

/** The exception items one event raises: none, one, or (a void's dispatch, a part delivery short) several. */
export function classify(event: SourceEvent): ExceptionDraft[] {
  const classifier = CLASSIFIERS[event.type];
  return classifier === undefined ? [] : drafts(event, classifier(event));
}
