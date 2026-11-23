/**
 * The van's two other ways out (FR-DEL-011; the owner, 2026-11-23: "every item is delivered, returned to stock or
 * written off with a reason, and anything unaccounted for goes on the driver variance report"; A-360). A failed
 * delivery's goods leave the vehicle either back into the branch's returns hold, not sellable until inspected, or as a
 * write-off through INV's adjustment path: spoiled or damaged (a `WASTAGE` reason) or unaccounted for
 * (`UNACCOUNTED_ON_VAN`), the last on the driver variance report as its own line.
 */
export type WayOut = 'RETURN_TO_STOCK' | 'WRITE_OFF';

/** The reason a write-off from the van names when the driver cannot account for the goods (migration 0321). */
export const UNACCOUNTED_ON_VAN = 'UNACCOUNTED_ON_VAN';
const WASTAGE = 'WASTAGE';

export interface WayOutFacts {
  readonly wayOut: WayOut;
  readonly deliveryStatus: string;
  /** A write-off of the same goods is waiting for its stock write-off approval. */
  readonly pendingWriteOff: boolean;
  readonly branchId: string;
  /** The returns location named for a return to stock; `MISSING` when no location has that id; null for a write-off. */
  readonly returnsLocation: { readonly kind: string; readonly branchId: string; readonly isLive: boolean } | 'MISSING' | null;
  /** The write-off's reason as the fixed list holds it; `UNKNOWN` when none has that code; null when none was given. */
  readonly reason: { readonly code: string; readonly domain: string; readonly requiresNote: boolean } | 'UNKNOWN' | null;
  readonly note: string | null;
  /** Where what the customer paid goes once the credit note is issued. */
  readonly refundDestination: 'ORIGINAL_METHOD' | 'STORE_CREDIT';
  /** The order is a customer account's; a guest has no store credit to keep it in. */
  readonly hasCustomer: boolean;
}

export interface VanRule {
  readonly field: string;
  readonly rule: string;
}

/**
 * A way out is taken only by a FAILED delivery (its goods still on the van, the order DELIVERY_FAILED), never while a
 * write-off of the same goods waits for approval. A return goes to a live RETURNS_HOLD of the delivery's branch; a
 * write-off names a `WASTAGE` reason or `UNACCOUNTED_ON_VAN`, with its note where the reason asks for one. Store credit
 * is kept only for a customer account (a guest's money goes back the way it was paid). A state refusal is answered alone
 * (`INVALID_STATE_TRANSITION`).
 */
export function judgeWayOut(f: WayOutFacts): VanRule[] {
  if (f.deliveryStatus !== 'FAILED') return [{ field: '', rule: 'INVALID_STATE_TRANSITION' }];
  if (f.pendingWriteOff) return [{ field: '', rule: 'WRITE_OFF_PENDING' }];
  if (f.refundDestination === 'STORE_CREDIT' && !f.hasCustomer) return [{ field: '/refundDestination', rule: 'STORE_CREDIT_NEEDS_CUSTOMER' }];
  if (f.wayOut === 'RETURN_TO_STOCK') {
    const hold = f.returnsLocation;
    return hold === null || hold === 'MISSING' || hold.kind !== 'RETURNS_HOLD' || hold.branchId !== f.branchId || !hold.isLive ? [{ field: '/returnsLocationId', rule: 'NOT_A_RETURNS_HOLD' }] : [];
  }
  if (f.reason === null || f.reason === 'UNKNOWN') return [{ field: '/reasonCode', rule: 'REASON_UNKNOWN' }];
  if (f.reason.domain !== WASTAGE && f.reason.code !== UNACCOUNTED_ON_VAN) return [{ field: '/reasonCode', rule: 'REASON_NOT_ALLOWED' }];
  if (f.reason.requiresNote && (f.note === null || f.note.trim() === '')) return [{ field: '/note', rule: 'NOTE_REQUIRED' }];
  return [];
}

/** A cancellation's reason is a `CANCELLATION` reason, as an order's (cancelOrder). */
const CANCELLATION = 'CANCELLATION';

export interface CancelFacts {
  readonly branchId: string;
  readonly orderStatus: string;
  readonly returnsLocation: WayOutFacts['returnsLocation'];
  readonly reason: WayOutFacts['reason'];
  readonly note: string | null;
  readonly refundDestination: WayOutFacts['refundDestination'];
  readonly hasCustomer: boolean;
}

/**
 * The goods of a delivery cancelled before it left the farm (A-364 (a)) go back as a failed delivery's do: into a live
 * RETURNS_HOLD of the branch, not sellable until inspected, the whole document credited. The order must be DISPATCHED
 * (DEL judges the delivery itself); the reason is a `CANCELLATION` reason, with its note where it asks for one; store
 * credit is kept only for a customer account. A state refusal is answered alone.
 */
export function judgeCancelReturn(f: CancelFacts): VanRule[] {
  if (f.orderStatus !== 'DISPATCHED') return [{ field: '', rule: 'INVALID_STATE_TRANSITION' }];
  if (f.reason === null || f.reason === 'UNKNOWN') return [{ field: '/reasonCode', rule: 'REASON_UNKNOWN' }];
  if (f.reason.domain !== CANCELLATION) return [{ field: '/reasonCode', rule: 'REASON_NOT_ALLOWED' }];
  if (f.reason.requiresNote && (f.note === null || f.note.trim() === '')) return [{ field: '/note', rule: 'NOTE_REQUIRED' }];
  if (f.refundDestination === 'STORE_CREDIT' && !f.hasCustomer) return [{ field: '/refundDestination', rule: 'STORE_CREDIT_NEEDS_CUSTOMER' }];
  const hold = f.returnsLocation;
  return hold === null || hold === 'MISSING' || hold.kind !== 'RETURNS_HOLD' || hold.branchId !== f.branchId || !hold.isLive ? [{ field: '/returnsLocationId', rule: 'NOT_A_RETURNS_HOLD' }] : [];
}

/** Goods written off as unaccounted for are the driver's variance; spoiled or damaged goods are wastage. */
export function isDriverVariance(reasonCode: string | null): boolean {
  return reasonCode === UNACCOUNTED_ON_VAN;
}
