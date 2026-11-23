import { describe, expect, it } from 'vitest';
import { offsetPage, pipelineFigures, pipelinePeriod, type PipelineStatus } from './pipeline';

describe('the quote pipeline (FR-QUO-013)', () => {
  const cell = (status: PipelineStatus, count: number, grossPesewas: bigint) => ({ status, count, grossPesewas });
  it("gives the SRS's 4 accepted, 3 declined and 3 expired a win rate of 40.00, a converted quote counted as accepted", () => {
    expect(
      pipelineFigures([cell('ACCEPTED', 3, 300_000n), cell('CONVERTED', 1, 120_000n), cell('DECLINED', 3, 90_000n), cell('EXPIRED', 3, 60_000n), cell('ISSUED', 2, 50_000n)]),
    ).toEqual({ issued: 12, accepted: 4, declined: 3, expired: 3, converted: 1, winRatePercent: '40.00', issuedValuePesewas: 620_000n, wonValuePesewas: 420_000n });
  });
  it('rounds the rate half-up once to two places: 2 of 3 is 66.67, 1 of 8 is 12.50, 1 of 6 is 16.67', () => {
    const rate = (won: number, lost: number) => pipelineFigures([cell('ACCEPTED', won, 0n), cell('DECLINED', lost, 0n)]).winRatePercent;
    expect([rate(2, 1), rate(1, 7), rate(1, 5), rate(1, 0)]).toEqual(['66.67', '12.50', '16.67', '100.00']);
  });
  it('is 0.00 with nothing closed yet: open quotes are not lost ones', () => {
    expect(pipelineFigures([cell('ISSUED', 5, 10_000n)])).toEqual({ issued: 5, accepted: 0, declined: 0, expired: 0, converted: 0, winRatePercent: '0.00', issuedValuePesewas: 10_000n, wonValuePesewas: 0n });
  });
});

describe('the pipeline period and its pages', () => {
  it('runs from the start of the first Accra day to the end of the last, both included', () => {
    expect(pipelinePeriod('2026-11-01', '2026-11-30')).toEqual({ from: new Date('2026-11-01T00:00:00.000Z'), to: new Date('2026-12-01T00:00:00.000Z') });
    expect(pipelinePeriod('2026-12-31', '2026-12-31').to).toEqual(new Date('2027-01-01T00:00:00.000Z'));
  });
  it('pages rows by offset: two of five from 2, then the last from 4, then none', () => {
    expect(offsetPage(['a', 'b', 'c', 'd', 'e'], 2, 2)).toEqual({ page: ['c', 'd'], next: 4 });
    expect(offsetPage(['a', 'b', 'c', 'd', 'e'], 4, 2)).toEqual({ page: ['e'], next: null });
    expect(offsetPage(['a', 'b'], 0, 2)).toEqual({ page: ['a', 'b'], next: null });
  });
});
