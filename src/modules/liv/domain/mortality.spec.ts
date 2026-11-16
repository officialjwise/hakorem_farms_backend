import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { checkMortalityReport, evidenceVerdict, judgeSubmission, judgeWriteOff, statusAfterLoss } from './mortality';

const now = new Date('2026-11-10T10:00:00Z');
const goat = { kind: 'DEATH' as const, reasonDomain: 'MORTALITY', tracking: 'SERIAL' as const, head: 1, headOnHand: 1n, alive: true, foundAt: new Date('2026-11-10T06:30:00Z'), now };

describe('what a death or cull report must hold (FR-LIV-012)', () => {
  it('accepts a goat found dead with a reason from the mortality list', () => {
    expect(checkMortalityReport(goat)).toEqual([]);
  });

  it('accepts a cull with a cull reason, and two birds lost from a flock of 18', () => {
    expect(checkMortalityReport({ ...goat, kind: 'CULL', reasonDomain: 'CULL' })).toEqual([]);
    expect(checkMortalityReport({ ...goat, tracking: 'LOT', head: 2, headOnHand: 18n })).toEqual([]);
    expect(checkMortalityReport({ ...goat, tracking: 'LOT', head: 18, headOnHand: 18n })).toEqual([]);
  });

  it('needs a reason distinct from death for a cull, and a death reason for a death', () => {
    expect(checkMortalityReport({ ...goat, kind: 'CULL' })).toEqual([{ field: '/reasonCode', rule: 'REASON_NOT_FOR_KIND' }]);
    expect(checkMortalityReport({ ...goat, reasonDomain: 'CULL' })).toEqual([{ field: '/reasonCode', rule: 'REASON_NOT_FOR_KIND' }]);
    expect(checkMortalityReport({ ...goat, reasonDomain: 'STOCK_ADJUSTMENT' })).toEqual([{ field: '/reasonCode', rule: 'REASON_NOT_FOR_KIND' }]);
  });

  it('loses one head of an animal and no more birds than the flock has', () => {
    expect(checkMortalityReport({ ...goat, head: 2 })).toEqual([{ field: '/head', rule: 'ONE_HEAD_FOR_AN_ANIMAL' }]);
    expect(checkMortalityReport({ ...goat, tracking: 'LOT', head: 19, headOnHand: 18n })).toEqual([{ field: '/head', rule: 'HEAD_ABOVE_FLOCK' }]);
  });

  it('refuses an animal no longer alive, and a finding in the future', () => {
    expect(checkMortalityReport({ ...goat, alive: false })).toEqual([{ field: '/stockUnitId', rule: 'ANIMAL_NOT_ALIVE' }]);
    expect(checkMortalityReport({ ...goat, foundAt: new Date('2026-11-10T10:00:01Z') })).toEqual([{ field: '/foundAt', rule: 'IN_THE_FUTURE' }]);
  });
});

describe('whether a write-off posts at once or waits for a second person (FR-LIV-012, abuse case 2)', () => {
  const threshold = Money.ofPesewas(50_000n);

  it('posts a kid with accumulated cost 12,000 on submit, with or without a photograph', () => {
    expect(judgeWriteOff(Money.ofPesewas(12_000n), threshold, false)).toEqual({ ok: true, value: 'POST' });
    expect(judgeWriteOff(Money.ofPesewas(49_999n), threshold, true)).toEqual({ ok: true, value: 'POST' });
  });

  it('sends a doe with cost 62,500 for approval only with a photograph', () => {
    expect(judgeWriteOff(Money.ofPesewas(62_500n), threshold, true)).toEqual({ ok: true, value: 'APPROVAL' });
    expect(judgeWriteOff(Money.ofPesewas(62_500n), threshold, false)).toEqual({ ok: false, error: 'PHOTO_REQUIRED' });
  });

  it('treats exactly the threshold as at or above it', () => {
    expect(judgeWriteOff(Money.ofPesewas(50_000n), threshold, false)).toEqual({ ok: false, error: 'PHOTO_REQUIRED' });
    expect(judgeWriteOff(Money.ofPesewas(50_000n), threshold, true)).toEqual({ ok: true, value: 'APPROVAL' });
  });
});

describe('the status a loss leaves the animal in (FR-LIV-017)', () => {
  it('is DEAD for a death and CULLED for a cull', () => {
    expect(statusAfterLoss('DEATH')).toBe('DEAD');
    expect(statusAfterLoss('CULL')).toBe('CULLED');
  });
});

describe('who confirms a submission: the reporter alone, a supervisor, or the mortality approver (owner, 2026-11-15; B06r)', () => {
  const threshold = Money.ofPesewas(50_000n);

  it('posts below the threshold when the reporter may post a write-off', () => {
    expect(judgeSubmission(Money.ofPesewas(49_999n), threshold, { hasPhoto: false, reporterMayPost: true })).toEqual({ ok: true, value: 'POST' });
  });

  it('waits for a supervisor below the threshold when the reporter may not, with or without a photograph', () => {
    expect(judgeSubmission(Money.ofPesewas(18_000n), threshold, { hasPhoto: false, reporterMayPost: false })).toEqual({ ok: true, value: 'CONFIRMATION' });
    expect(judgeSubmission(Money.ofPesewas(49_999n), threshold, { hasPhoto: true, reporterMayPost: false })).toEqual({ ok: true, value: 'CONFIRMATION' });
    expect(judgeSubmission(Money.zero(), threshold, { hasPhoto: false, reporterMayPost: false })).toEqual({ ok: true, value: 'CONFIRMATION' });
  });

  it('sends exactly the threshold and above to the approver, whoever reports, only with a photograph', () => {
    for (const reporterMayPost of [true, false]) {
      expect(judgeSubmission(Money.ofPesewas(50_000n), threshold, { hasPhoto: true, reporterMayPost })).toEqual({ ok: true, value: 'APPROVAL' });
      expect(judgeSubmission(Money.ofPesewas(50_000n), threshold, { hasPhoto: false, reporterMayPost })).toEqual({ ok: false, error: 'PHOTO_REQUIRED' });
    }
  });
});

describe("what the photograph's scan allows (B06r)", () => {
  it('lets a report be submitted while the scan is PENDING and approved only once CLEAN', () => {
    expect(evidenceVerdict('PENDING')).toEqual({ submit: true, post: false, returnReason: null });
    expect(evidenceVerdict('CLEAN')).toEqual({ submit: true, post: true, returnReason: null });
  });

  it('sends a report back to its maker when the scan finds the file infected or cannot read it', () => {
    expect(evidenceVerdict('INFECTED')).toEqual({ submit: false, post: false, returnReason: 'EVIDENCE_INFECTED' });
    expect(evidenceVerdict('FAILED')).toEqual({ submit: false, post: false, returnReason: 'EVIDENCE_UNSCANNABLE' });
  });
});
