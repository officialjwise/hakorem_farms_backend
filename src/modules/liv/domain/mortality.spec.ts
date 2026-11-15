import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { checkMortalityReport, judgeWriteOff, statusAfterLoss } from './mortality';

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
