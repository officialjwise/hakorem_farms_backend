import { describe, expect, it } from 'vitest';
import { averageDailyGain, daysBetween, feedConversion, feedShare, gainOf, groupGrowth, percentOf, type GrowthWeighing } from './growth';

const weighed = (day: string, kg: string): GrowthWeighing => ({ at: new Date(`${day}T07:00:00Z`), day, kg });
const goat = (head = 1n) => ({ head, weighings: [weighed('2026-10-31', '24.600'), weighed('2026-10-01', '18.000')] });

describe('average daily gain (FR-LIV-005)', () => {
  it('gives an animal at 18.000 kg on 1 October and 24.600 kg on 31 October 0.220 kg a day', () => {
    expect(averageDailyGain(goat().weighings)).toBe('0.220');
    expect(gainOf(goat().weighings)).toEqual({ firstGrams: 18_000n, lastGrams: 24_600n, days: 30n });
  });

  it('counts calendar days between the two business dates', () => {
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30n);
    expect(daysBetween('2027-03-01', '2027-07-28')).toBe(149n);
  });

  it('states no gain for an animal weighed once, or twice on the same day', () => {
    expect(averageDailyGain([weighed('2026-10-01', '18.000')])).toBeNull();
    expect(averageDailyGain([weighed('2026-10-01', '18.000'), { at: new Date('2026-10-01T15:00:00Z'), day: '2026-10-01', kg: '18.200' }])).toBeNull();
  });

  it('states no daily gain for an animal that lost weight, since a gain is never negative', () => {
    expect(averageDailyGain([weighed('2026-10-01', '20.000'), weighed('2026-10-11', '19.500')])).toBeNull();
  });

  it('rounds a third of a gram down and two thirds up, once', () => {
    expect(averageDailyGain([weighed('2026-10-01', '10.000'), weighed('2026-10-04', '11.000')])).toBe('0.333');
    expect(averageDailyGain([weighed('2026-10-01', '10.000'), weighed('2026-10-04', '12.000')])).toBe('0.667');
  });

  it('rounds exactly half a gram a day up, and just under half down', () => {
    expect(averageDailyGain([weighed('2026-10-01', '10.000'), weighed('2026-10-11', '10.005')])).toBe('0.001');
    expect(averageDailyGain([weighed('2026-10-01', '10.000'), weighed('2026-10-11', '10.004')])).toBe('0.000');
  });
});

describe("a pen's or batch's growth over a window (FR-LIV-005, FR-LIV-016)", () => {
  it('reports a pen of two full-window goats at 0.220 kg a day, the goat added on 15 October left out by the caller', () => {
    const pen = groupGrowth([goat(), goat()], null, 0n, 2n);
    expect(pen).toEqual({
      head: 2n,
      startAverageKg: '18.000',
      endAverageKg: '24.600',
      averageDailyGainKg: '0.220',
      gainKg: '13.200',
      feedConversionRatio: null,
      mortalityPercent: '0.00',
    });
  });

  it('gives a batch gaining 40.000 kg on 100.000 kg of feed a conversion of 2.500', () => {
    const flock = { head: 20n, weighings: [weighed('2026-10-01', '0.500'), weighed('2026-10-21', '2.500')] };
    const batch = groupGrowth([flock], '100.000', 0n, 20n);
    expect(batch.gainKg).toBe('40.000');
    expect(batch.feedConversionRatio).toBe('2.500');
    expect(batch.averageDailyGainKg).toBe('0.100');
    expect(batch.startAverageKg).toBe('0.500');
    expect(batch.endAverageKg).toBe('2.500');
  });

  it('weights each member by its head, so a flock of ten outweighs one goat in the averages', () => {
    const flock = { head: 10n, weighings: [weighed('2026-10-01', '1.000'), weighed('2026-10-11', '2.000')] };
    const one = { head: 1n, weighings: [weighed('2026-10-01', '12.000'), weighed('2026-10-11', '13.100')] };
    // (10 x 1,000 + 12,000) / 11 = 2,000 g; (10 x 2,000 + 13,100) / 11 = 3,009.09 g; gain 11,100 g over 110 head-days.
    expect(groupGrowth([flock, one], null, 0n, 11n)).toMatchObject({ head: 11n, startAverageKg: '2.000', endAverageKg: '3.009', averageDailyGainKg: '0.101', gainKg: '11.100' });
  });

  it('counts an unweighed member in the head but not in the averages', () => {
    expect(groupGrowth([goat(), { head: 1n, weighings: [] }], null, 0n, 2n)).toMatchObject({ head: 2n, startAverageKg: '18.000', averageDailyGainKg: '0.220' });
  });

  it('states nothing but head and mortality when no member was weighed twice', () => {
    expect(groupGrowth([{ head: 3n, weighings: [weighed('2026-10-01', '20.000')] }], '10.000', 1n, 4n)).toEqual({
      head: 3n,
      startAverageKg: null,
      endAverageKg: null,
      averageDailyGainKg: null,
      gainKg: null,
      feedConversionRatio: null,
      mortalityPercent: '25.00',
    });
  });

  it('shows averages but no gain, daily gain or conversion for a pen that lost weight', () => {
    const thin = { head: 1n, weighings: [weighed('2026-10-01', '20.000'), weighed('2026-10-11', '19.000')] };
    expect(groupGrowth([thin], '5.000', 0n, 1n)).toMatchObject({ startAverageKg: '20.000', endAverageKg: '19.000', averageDailyGainKg: null, gainKg: null, feedConversionRatio: null });
  });

  it('reports an empty group with nothing in it', () => {
    expect(groupGrowth([], null, 0n, 0n)).toMatchObject({ head: 0n, mortalityPercent: '0.00', averageDailyGainKg: null });
  });
});

describe('feed conversion (FR-LIV-016)', () => {
  it('rounds to three places, a third down and two thirds up', () => {
    expect(feedConversion('10.000', 3_000n)).toBe('3.333');
    expect(feedConversion('20.000', 3_000n)).toBe('6.667');
  });

  it('rounds an exact half up', () => {
    // 1.001 kg of feed for 2.000 kg gained is 0.5005.
    expect(feedConversion('1.001', 2_000n)).toBe('0.501');
    expect(feedConversion('0.999', 2_000n)).toBe('0.500');
    expect(feedConversion('0.999', 2_001n)).toBe('0.499');
  });

  it('states no ratio without a gain', () => {
    expect(feedConversion('10.000', 0n)).toBeNull();
    expect(feedConversion('10.000', -1n)).toBeNull();
  });
});

describe('mortality percent (FR-LIV-006, SA-21)', () => {
  it('gives 38 deaths of 500 head 7.60 percent', () => {
    expect(percentOf(38n, 500n)).toBe('7.60');
  });

  it('rounds to two places half-up, once', () => {
    expect(percentOf(1n, 3n)).toBe('33.33');
    expect(percentOf(2n, 3n)).toBe('66.67');
    expect(percentOf(1n, 800n)).toBe('0.13');
    expect(percentOf(1n, 8n)).toBe('12.50');
  });

  it('is 0.00 of no head and 100.00 of all of it', () => {
    expect(percentOf(0n, 0n)).toBe('0.00');
    expect(percentOf(20n, 20n)).toBe('100.00');
  });
});

describe("a group's share of the feed issued (FR-LIV-016)", () => {
  it('gives a pen fed alone the whole of every issue', () => {
    expect(feedShare([{ qty: '10.000', share: 3n, total: 3n }, { qty: '2.500', share: 1n, total: 1n }])).toBe('12.500');
  });

  it('gives a flock its head-day share of an issue spread over several flocks, rounded once at the end', () => {
    // 10.000 kg over head-days 10, 10 and 5: the first flock's share is 4.000 kg; 10.000 kg twice over 1 of 3 is 6.667.
    expect(feedShare([{ qty: '10.000', share: 10n, total: 25n }])).toBe('4.000');
    expect(feedShare([{ qty: '10.000', share: 1n, total: 3n }, { qty: '10.000', share: 1n, total: 3n }])).toBe('6.667');
  });

  it('rounds an exact half thousandth up and is nothing when nothing was issued', () => {
    expect(feedShare([{ qty: '0.001', share: 1n, total: 2n }])).toBe('0.001');
    expect(feedShare([])).toBe('0.000');
  });
});
