import type { OrderStatus } from './order';

/** The steps a customer sees, in order, for each way an online order reaches them (trackOrder, A-232). */
export const TRACKING_STEPS: Readonly<Record<'COLLECTION' | 'DELIVERY', readonly OrderStatus[]>> = {
  DELIVERY: ['PLACED', 'CONFIRMED', 'PACKED', 'DISPATCHED', 'DELIVERED'],
  COLLECTION: ['PLACED', 'CONFIRMED', 'PACKED', 'READY_FOR_COLLECTION', 'COMPLETED'],
};

export interface TrackingStep {
  readonly status: OrderStatus;
  readonly at: Date | null;
  readonly done: boolean;
}

/**
 * The steps of an order's progress from its status history: each listed step is done, with its first time, once the
 * order reached it; a delivered order that then completes keeps DELIVERED as its last step. An order that ended
 * CANCELLED or VOIDED shows the steps it reached and then its end, done.
 */
export function trackingSteps(mode: 'COLLECTION' | 'DELIVERY', history: readonly { readonly toStatus: OrderStatus; readonly occurredAt: Date }[]): TrackingStep[] {
  const reached = new Map<OrderStatus, Date>();
  for (const change of history) if (!reached.has(change.toStatus)) reached.set(change.toStatus, change.occurredAt);
  const end = history.find((c) => c.toStatus === 'CANCELLED' || c.toStatus === 'VOIDED');
  const steps = TRACKING_STEPS[mode].map((status) => ({ status, at: reached.get(status) ?? null, done: reached.has(status) }));
  if (end === undefined) return steps;
  return [...steps.filter((s) => s.done), { status: end.toStatus, at: end.occurredAt, done: true }];
}

/**
 * Whether a cleared payment confirms the order it names (FR-ORD-005, FR-PAY-008, A-232): only an online order placed
 * from a checkout, still PLACED and prepaid, and only for money that is the order's, never money held as unmatched
 * because it came after the order stopped waiting. Anything else is left for a person.
 */
export function paymentConfirms(order: { readonly channel: string; readonly status: OrderStatus; readonly paymentTerms: string; readonly fromCheckout: boolean }, heldAsUnmatched: boolean): boolean {
  return !heldAsUnmatched && order.channel === 'ONLINE' && order.fromCheckout && order.status === 'PLACED' && order.paymentTerms === 'PREPAID';
}
