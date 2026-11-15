import { describe, expect, it } from 'vitest';
import { checkHoldPlacement, holdState, judgeRelease, type HoldWindow } from './stock-hold';

const at = (iso: string) => new Date(iso);
const investigation: HoldWindow = { kind: 'INVESTIGATION', startsAt: at('2026-11-15T08:00:00Z'), endsAt: null, releasedAt: null };
const withdrawal: HoldWindow = { kind: 'WITHDRAWAL', startsAt: at('2026-11-01T10:00:00Z'), endsAt: at('2026-11-28T23:59:00Z'), releasedAt: null };

describe('where a hold stands (ADR-0019)', () => {
  it('is scheduled before its start, in force from it, ended at its end, released once released', () => {
    expect(holdState(investigation, at('2026-11-15T07:59:59Z'))).toBe('SCHEDULED');
    expect(holdState(investigation, at('2026-11-15T08:00:00Z'))).toBe('ACTIVE');
    expect(holdState(withdrawal, at('2026-11-28T23:58:59Z'))).toBe('ACTIVE');
    expect(holdState(withdrawal, at('2026-11-28T23:59:00Z'))).toBe('ENDED');
    expect(holdState({ ...investigation, releasedAt: at('2026-11-15T09:00:00Z') }, at('2026-11-15T08:30:00Z'))).toBe('RELEASED');
  });
});

describe('placing a hold (FR-INV-022)', () => {
  const now = at('2026-11-15T08:00:00Z');
  it('accepts an open-ended investigation of an active lot and a withdrawal with its end', () => {
    expect(checkHoldPlacement({ kind: 'INVESTIGATION', unitStatus: 'ACTIVE', startsAt: now, endsAt: null })).toEqual([]);
    expect(checkHoldPlacement({ kind: 'WITHDRAWAL', unitStatus: 'ACTIVE', startsAt: now, endsAt: at('2026-11-28T23:59:00Z') })).toEqual([]);
  });

  it('refuses a sold or depleted unit, an end not after the start, and a withdrawal without an end', () => {
    expect(checkHoldPlacement({ kind: 'QUARANTINE', unitStatus: 'DEPLETED', startsAt: now, endsAt: now })).toEqual([
      { field: '/stockUnitId', rule: 'STOCK_UNIT_NOT_ACTIVE' },
      { field: '/endsAt', rule: 'ENDS_BEFORE_IT_STARTS' },
    ]);
    expect(checkHoldPlacement({ kind: 'WITHDRAWAL', unitStatus: 'ACTIVE', startsAt: now, endsAt: null })).toEqual([{ field: '/endsAt', rule: 'WITHDRAWAL_NEEDS_AN_END' }]);
  });
});

describe('releasing a hold early (FR-INV-022, FR-INV-008)', () => {
  const placed = { ...investigation, createdBy: 'manager' };
  const now = at('2026-11-15T10:00:00Z');
  it('lets a different person release an investigation with a HOLD_RELEASE reason', () => {
    expect(judgeRelease({ hold: placed, at: now, releasedBy: 'owner', reasonDomain: 'HOLD_RELEASE' })).toEqual({ refusal: null, broken: [] });
  });

  it('never releases a withdrawal hold, in force or not, whoever asks', () => {
    expect(judgeRelease({ hold: { ...withdrawal, createdBy: 'vet' }, at: now, releasedBy: 'owner', reasonDomain: 'HOLD_RELEASE' })).toEqual({ refusal: 'WITHDRAWAL' });
  });

  it('refuses a second release and the release of a hold that has ended', () => {
    expect(judgeRelease({ hold: { ...placed, releasedAt: at('2026-11-15T09:00:00Z') }, at: now, releasedBy: 'owner', reasonDomain: 'HOLD_RELEASE' })).toEqual({ refusal: 'NOT_IN_FORCE' });
    expect(judgeRelease({ hold: { ...placed, endsAt: at('2026-11-15T09:00:00Z') }, at: now, releasedBy: 'owner', reasonDomain: 'HOLD_RELEASE' })).toEqual({ refusal: 'NOT_IN_FORCE' });
  });

  it('refuses a reason from another list or none, and the person who placed it', () => {
    expect(judgeRelease({ hold: placed, at: now, releasedBy: 'manager', reasonDomain: 'WASTAGE' })).toEqual({
      refusal: null,
      broken: [
        { field: '/reasonCode', rule: 'REASON_NOT_ALLOWED' },
        { field: '/id', rule: 'RELEASED_BY_PLACER' },
      ],
    });
    expect(judgeRelease({ hold: placed, at: now, releasedBy: 'owner', reasonDomain: null }).refusal).toBeNull();
  });
});
