/** A chargeback opened at the provider (B09c, abuse case 45): raised for a person, nothing posted. */
export const DISPUTE_OPENED_EVENT = 'charge.dispute.create';

/** The provider events PAY acts on; any other signed event is logged and ignored. */
export const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set(['charge.success', DISPUTE_OPENED_EVENT]);

export type WebhookJudgement = 'PROCEED' | 'REJECTED_STALE' | 'IGNORED_EVENT_TYPE';

/**
 * A signed webhook before the provider is asked (FR-PAY-004, docs/API.md section 13, A-210): an event type PAY acts
 * on, whose own time (the provider signs no separate timestamp, so the signed body's event time is used) lies within
 * the window either side of the server's clock. The event id and the amount are checked after this.
 */
export function judgeWebhookEvent(event: { readonly eventType: string; readonly eventAt: Date | null; readonly now: Date; readonly windowSeconds: number }): WebhookJudgement {
  if (!HANDLED_EVENT_TYPES.has(event.eventType)) return 'IGNORED_EVENT_TYPE';
  if (event.eventAt === null || Math.abs(event.now.getTime() - event.eventAt.getTime()) > event.windowSeconds * 1000) return 'REJECTED_STALE';
  return 'PROCEED';
}
