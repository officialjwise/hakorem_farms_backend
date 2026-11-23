import { describe, expect, it } from 'vitest';
import { judgeWebhookEvent } from './webhook';

const now = new Date('2026-11-16T09:10:00Z');
const fresh = { eventType: 'charge.success', eventAt: new Date('2026-11-16T09:05:00Z'), now, windowSeconds: 300 };

describe('the checks a signed webhook passes before the provider is asked (FR-PAY-004, security architecture section 8)', () => {
  it('proceeds with a charge success inside the window, five minutes exactly', () => {
    expect(judgeWebhookEvent(fresh)).toBe('PROCEED');
  });

  it('rejects one timestamped six minutes ago, and one a millisecond outside the window, as stale', () => {
    expect(judgeWebhookEvent({ ...fresh, eventAt: new Date('2026-11-16T09:04:00Z') })).toBe('REJECTED_STALE');
    expect(judgeWebhookEvent({ ...fresh, eventAt: new Date('2026-11-16T09:04:59.999Z') })).toBe('REJECTED_STALE');
  });

  it('rejects one dated in the future beyond the window, and one with no time at all', () => {
    expect(judgeWebhookEvent({ ...fresh, eventAt: new Date('2026-11-16T09:15:00.001Z') })).toBe('REJECTED_STALE');
    expect(judgeWebhookEvent({ ...fresh, eventAt: null })).toBe('REJECTED_STALE');
  });

  it('ignores an event type it does not act on, whatever its time', () => {
    expect(judgeWebhookEvent({ ...fresh, eventType: 'transfer.success' })).toBe('IGNORED_EVENT_TYPE');
  });

  it('acts on a chargeback opened at the provider within the window, as on a payment (B09c, abuse case 45)', () => {
    expect(judgeWebhookEvent({ ...fresh, eventType: 'charge.dispute.create' })).toBe('PROCEED');
    expect(judgeWebhookEvent({ ...fresh, eventType: 'charge.dispute.create', eventAt: null })).toBe('REJECTED_STALE');
  });
});
