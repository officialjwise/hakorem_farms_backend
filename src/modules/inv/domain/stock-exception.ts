import type { StockRuleBroken } from './stock-documents';

export type StockExceptionKind =
  | 'NEGATIVE_STOCK'
  | 'SERIAL_CONFLICT'
  | 'HOLD_CONFLICT'
  | 'RESERVATION_CONFLICT'
  | 'TEMPERATURE_EXCURSION'
  | 'BALANCE_DRIFT'
  | 'TRANSFER_VARIANCE';

/**
 * How an exception was settled (FR-INV-023, ADR-0048, A-144): a held transfer variance is written off (a loss through
 * the adjustment path) or found (returned to stock where it was found); any other exception is settled by a posted
 * adjustment that names it, or explained with no correction.
 */
export type ResolutionKind = 'WRITE_OFF' | 'FOUND' | 'ADJUSTED' | 'NO_CORRECTION';

/** A transfer shortfall received from ADR-0048 on is held in transit: it has no movement until it is resolved. */
export function isHeldVariance(exception: { readonly kind: string; readonly movementId: string | null }): boolean {
  return exception.kind === 'TRANSFER_VARIANCE' && exception.movementId === null;
}

export interface ResolutionRequest {
  readonly exceptionKind: string;
  readonly held: boolean;
  readonly requested: ResolutionKind | undefined;
  readonly hasDocument: boolean;
  readonly hasFoundLocation: boolean;
  /** A write-off of this exception is waiting for approval. */
  readonly writeOffPending: boolean;
}

/**
 * The resolution a request asks for, and the rules it breaks. A held variance needs its kind, `WRITE_OFF` or `FOUND`,
 * and takes no document of the caller's (the write-off makes its own adjustment; found is posted against the
 * transfer); nothing more is decided while a write-off waits for approval. Any other exception takes `ADJUSTED` with
 * the adjustment that settled it or `NO_CORRECTION` without one; with no kind given, the document decides which.
 */
export function judgeResolution(request: ResolutionRequest): { readonly kind: ResolutionKind | null; readonly broken: StockRuleBroken[] } {
  const broken: StockRuleBroken[] = [];
  const at = (field: string, rule: string) => broken.push({ field, rule });
  const kind = request.requested ?? (request.held ? null : request.hasDocument ? 'ADJUSTED' : 'NO_CORRECTION');
  if (request.held) {
    if (kind === null) at('/resolutionKind', 'RESOLUTION_KIND_REQUIRED');
    else if (kind !== 'WRITE_OFF' && kind !== 'FOUND') at('/resolutionKind', 'NOT_FOR_A_HELD_VARIANCE');
    else if (request.writeOffPending) at('/resolutionKind', 'WRITE_OFF_PENDING');
    if (request.hasDocument) at('/resolutionDocumentId', 'NOT_FOR_A_HELD_VARIANCE');
  } else if (kind === 'WRITE_OFF' || kind === 'FOUND') {
    at('/resolutionKind', 'ONLY_FOR_A_HELD_VARIANCE');
  } else if (kind === 'ADJUSTED' && !request.hasDocument) {
    at('/resolutionDocumentId', 'DOCUMENT_REQUIRED');
  } else if (kind === 'NO_CORRECTION' && request.hasDocument) {
    at('/resolutionDocumentId', 'NOT_FOR_NO_CORRECTION');
  }
  if (kind === 'FOUND' && !request.hasFoundLocation && broken.length === 0) at('/foundLocationId', 'FOUND_LOCATION_REQUIRED');
  if (kind !== 'FOUND' && request.hasFoundLocation) at('/foundLocationId', 'ONLY_FOR_FOUND');
  return { kind, broken };
}

export interface ExceptionFacts {
  readonly kind: string;
  readonly movementId: string | null;
  readonly qty: string | null;
  readonly details: Readonly<Record<string, unknown>>;
}

const text = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : '?');

/** One line naming the two conflicting facts, as the exception queue and the daily report show it. */
export function exceptionSummary(e: ExceptionFacts): string {
  const d = e.details;
  switch (e.kind) {
    case 'TRANSFER_VARIANCE':
      return `Received ${text(d['qtyReceived'])} of ${text(d['qtyDispatched'])} dispatched; ${text(e.qty)} ${isHeldVariance(e) ? 'held in transit until written off or found' : 'posted as a loss'}`;
    case 'NEGATIVE_STOCK':
      return `${text(d['movementType'])} took on hand to ${text(d['onHandAfter'])}; the uncovered quantity carried no cost`;
    case 'RESERVATION_CONFLICT':
      return `${text(d['movementType'])} left ${text(d['onHandAfter'])} on hand against ${text(d['reserved'])} reserved`;
    case 'BALANCE_DRIFT':
      return `Nightly recompute: ${text(d['projection'])} ${text(d['projectedQty'])}, ledger ${text(d['ledgerQty'])}; nothing was corrected`;
    default:
      return typeof d['summary'] === 'string' ? d['summary'] : `${e.kind}: a stock fact that needs a person`;
  }
}
