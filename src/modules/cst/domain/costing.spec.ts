import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { assignFixedCosts, breakEvenLine, contributionShares } from './break-even';
import { elementsOf, processingOrderCost, splitConsumed, type ElementAmounts } from './cost-object';
import { headDaysOf, judgePost, spreadOverhead, treatmentOf } from './allocation';
import { lossRows, type LossFactInput } from './losses';
import { marginFigures, marginRow, percentOf, type MarginFactInput } from './margin';

const money = (n: number | bigint) => Money.ofPesewas(BigInt(n));
const nothing: ElementAmounts = { PURCHASE: 0n, FEED: 0n, VETERINARY: 0n, LABOUR: 0n, OVERHEAD: 0n, PROCESSING: 0n };

describe('overhead allocation (FR-CST-002)', () => {
  it('allocates 30,001 over head-days of 10, 10 and 5 as 12,001, 12,000 and 6,000', () => {
    const parts = spreadOverhead(money(30_001), [
      { stockUnitId: 'c', identifier: 'G-0118', weight: 5n },
      { stockUnitId: 'a', identifier: 'G-0142', weight: 10n },
      { stockUnitId: 'b', identifier: 'G-0157', weight: 10n },
    ]);
    expect(parts.ok).toBe(true);
    if (!parts.ok) return;
    expect(parts.value.map((p) => [p.identifier, p.amount.pesewas])).toEqual([
      ['G-0118', 6_000n],
      ['G-0142', 12_001n],
      ['G-0157', 12_000n],
    ]);
    expect(parts.value.reduce((s, p) => s + p.amount.pesewas, 0n)).toBe(30_001n);
  });

  it('gives a tie the leftover pesewa by tag, so 9,001 over three equal animals puts it on the first tag', () => {
    const parts = spreadOverhead(money(9_001), [
      { stockUnitId: 'z', identifier: 'G-0003', weight: 1n },
      { stockUnitId: 'y', identifier: 'G-0001', weight: 1n },
      { stockUnitId: 'x', identifier: 'G-0002', weight: 1n },
    ]);
    expect(parts.ok && parts.value.map((p) => [p.identifier, p.amount.pesewas])).toEqual([
      ['G-0001', 3_001n],
      ['G-0002', 3_000n],
      ['G-0003', 3_000n],
    ]);
  });

  it('breaks a tie of one tag on two units by the unit id', () => {
    const parts = spreadOverhead(money(3), [
      { stockUnitId: 'b', identifier: 'L-1', weight: 1n },
      { stockUnitId: 'a', identifier: 'L-1', weight: 1n },
    ]);
    expect(parts.ok && parts.value.map((p) => [p.stockUnitId, p.amount.pesewas])).toEqual([
      ['a', 2n],
      ['b', 1n],
    ]);
    const again = spreadOverhead(money(3), [
      { stockUnitId: 'a', identifier: 'L-1', weight: 1n },
      { stockUnitId: 'c', identifier: 'L-1', weight: 1n },
      { stockUnitId: 'b', identifier: 'L-1', weight: 1n },
    ]);
    expect(again.ok && again.value.map((p) => p.stockUnitId)).toEqual(['a', 'b', 'c']);
  });

  it('spreads the largest amount without losing a pesewa', () => {
    const parts = spreadOverhead(money(Money.MAX_PESEWAS), [
      { stockUnitId: 'a', identifier: 'A', weight: 2n },
      { stockUnitId: 'b', identifier: 'B', weight: 1n },
    ]);
    expect(parts.ok && parts.value.map((p) => p.amount.pesewas)).toEqual([6_004_799_503_160_661n, 3_002_399_751_580_330n]);
  });

  it('refuses nothing to spread over, a unit with no weight and a unit named twice', () => {
    expect(spreadOverhead(money(100), [])).toEqual({ ok: false, error: 'NO_ANIMALS_IN_SCOPE' });
    expect(spreadOverhead(money(100), [{ stockUnitId: 'a', identifier: 'A', weight: 0n }])).toEqual({ ok: false, error: 'NO_ANIMALS_IN_SCOPE' });
    expect(
      spreadOverhead(money(100), [
        { stockUnitId: 'a', identifier: 'A', weight: 1n },
        { stockUnitId: 'a', identifier: 'A', weight: 2n },
      ]),
    ).toEqual({ ok: false, error: 'UNIT_REPEATED' });
  });

  it('counts head-days as the whole head on hand at the end of each day: an animal one a day, a flock its head', () => {
    expect(headDaysOf('SERIAL', ['1.000', '1.000', '1.000'])).toBe(3n);
    expect(headDaysOf('LOT', ['20.000', '19.000', '18.500', '0.000'])).toBe(57n);
    expect(headDaysOf('LOT', [])).toBe(0n);
    expect(headDaysOf('SERIAL', ['0.000'])).toBe(0n);
  });

  it('capitalises a growing animal’s share and expenses a breeding or laying one’s (ADR-0018)', () => {
    expect(treatmentOf('GROWING')).toBe('CAPITALISED');
    expect(treatmentOf('BREEDING')).toBe('EXPENSED');
    expect(treatmentOf('LAYING')).toBe('EXPENSED');
  });

  it('posts only a draft, and never by the person who created it', () => {
    expect(judgePost({ status: 'DRAFT', createdBy: 'efua' }, 'kwame')).toBeNull();
    expect(judgePost({ status: 'DRAFT', createdBy: 'efua' }, 'efua')).toBe('MAKER_CANNOT_CHECK');
    expect(judgePost({ status: 'POSTED', createdBy: 'efua' }, 'kwame')).toBe('ALREADY_POSTED');
  });
});

describe('cost object by element (FR-CST-001)', () => {
  it('sums purchase 60,000, feed 8,400 and veterinary 3,000 to 71,400', () => {
    const elements = elementsOf({ ...nothing, PURCHASE: 60_000n, FEED: 8_400n, VETERINARY: 3_000n });
    expect(elements.total).toBe(71_400n);
    expect(elements.byElement.map((e) => [e.costElement, e.valuePesewas])).toEqual([
      ['PURCHASE', 60_000n],
      ['FEED', 8_400n],
      ['VETERINARY', 3_000n],
    ]);
  });

  it('shows every element when nothing has been added, so a born kid reads nil', () => {
    expect(elementsOf(nothing).byElement.map((e) => e.costElement)).toEqual(['PURCHASE', 'FEED', 'VETERINARY', 'LABOUR', 'OVERHEAD', 'PROCESSING']);
    expect(elementsOf(nothing).total).toBe(0n);
  });

  it('carries a whole consumed animal’s own elements into the order exactly', () => {
    expect(splitConsumed(71_400n, { ...nothing, PURCHASE: 60_000n, FEED: 8_400n, VETERINARY: 3_000n })).toEqual({ ...nothing, PURCHASE: 60_000n, FEED: 8_400n, VETERINARY: 3_000n });
  });

  it('splits part of a lot by its elements through allocate, the leftover to the largest remainder', () => {
    // 1,001 of a lot of 2,000 purchase and 1,000 feed: exact 667.33 and 333.67, the pesewa to feed.
    expect(splitConsumed(1_001n, { ...nothing, PURCHASE: 2_000n, FEED: 1_000n })).toEqual({ ...nothing, PURCHASE: 667n, FEED: 334n });
  });

  it('puts a consumed value with no positive element under purchase, and nothing under nothing', () => {
    expect(splitConsumed(500n, nothing)).toEqual({ ...nothing, PURCHASE: 500n });
    expect(splitConsumed(0n, { ...nothing, FEED: 10n })).toEqual(nothing);
  });

  it('takes a reversed consumption back by the same split', () => {
    expect(splitConsumed(-1_001n, { ...nothing, PURCHASE: 2_000n, FEED: 1_000n })).toEqual({ ...nothing, PURCHASE: -667n, FEED: -334n });
  });

  it('shows a processing order as input cost 71,400 plus direct 5,000 under processing', () => {
    const order = processingOrderCost(
      [{ consumed: 71_400n, unit: { ...nothing, PURCHASE: 60_000n, FEED: 8_400n, VETERINARY: 3_000n } }],
      76_400n,
    );
    expect(order).toEqual({ ...nothing, PURCHASE: 60_000n, FEED: 8_400n, VETERINARY: 3_000n, PROCESSING: 5_000n });
    expect(elementsOf(order).total).toBe(76_400n);
  });
});

describe('margin over the selling price (FR-CST-003)', () => {
  const fact = (f: Partial<MarginFactInput>): MarginFactInput => ({ kind: 'REVENUE', isCredit: false, revenue: 0n, cost: 0n, variance: 0n, ...f });

  it('makes goat sales of 85,000 with cost of sales 71,400 a margin of 13,600 and 16.00 percent, the variance of 5,000 shown', () => {
    const figures = marginFigures([fact({ revenue: 85_000n, variance: 5_000n }), fact({ kind: 'COST', cost: 71_400n })]);
    expect(figures).toEqual({ revenue: 85_000n, cost: 71_400n, margin: 13_600n, variance: 5_000n });
    expect(marginRow(figures)).toEqual({
      revenuePesewas: 85_000,
      revenueIsNegative: false,
      costPesewas: 71_400,
      costIsNegative: false,
      grossMarginPesewas: 13_600,
      marginIsNegative: false,
      marginPercent: '16.00',
      priceVariancePesewas: 5_000,
      priceVarianceIsNegative: false,
    });
  });

  it('takes a credit note’s revenue and a return’s cost back', () => {
    expect(marginFigures([fact({ revenue: 85_000n }), fact({ revenue: 85_000n, isCredit: true }), fact({ kind: 'COST', cost: 71_400n }), fact({ kind: 'COST', cost: 71_400n, isCredit: true })])).toEqual({
      revenue: 0n,
      cost: 0n,
      margin: 0n,
      variance: 0n,
    });
  });

  it('answers a loss as its size with marginIsNegative, and a price above list as a negative variance', () => {
    const row = marginRow(marginFigures([fact({ revenue: 10_000n, variance: -500n }), fact({ kind: 'COST', cost: 12_500n })]));
    expect(row).toMatchObject({ grossMarginPesewas: 2_500, marginIsNegative: true, marginPercent: '25.00', priceVariancePesewas: 500, priceVarianceIsNegative: true });
  });

  it('gives no percent with no revenue, or a loss beyond the whole price', () => {
    expect(marginRow({ revenue: 0n, cost: 100n, margin: -100n, variance: 0n }).marginPercent).toBeNull();
    expect(marginRow({ revenue: 100n, cost: 301n, margin: -201n, variance: 0n }).marginPercent).toBeNull();
    expect(marginRow({ revenue: -100n, cost: 0n, margin: -100n, variance: 0n })).toMatchObject({ revenuePesewas: 100, revenueIsNegative: true, marginPercent: null });
    expect(marginRow({ revenue: 100n, cost: -50n, margin: 150n, variance: 0n })).toMatchObject({ costPesewas: 50, costIsNegative: true, marginPercent: null });
  });

  it('rounds the percent half-up to two places: exactly half, below and above', () => {
    expect(percentOf(1n, 8n)).toBe('12.50');
    expect(percentOf(1n, 80_000n)).toBe('0.00');
    expect(percentOf(1n, 40_000n)).toBe('0.00');
    expect(percentOf(1n, 20_000n)).toBe('0.01');
    expect(percentOf(2_730_000n, 8_840_000n)).toBe('30.88');
    expect(percentOf(0n, 5n)).toBe('0.00');
    expect(percentOf(5n, 5n)).toBe('100.00');
    expect(percentOf(BigInt(Money.MAX_PESEWAS), BigInt(Money.MAX_PESEWAS))).toBe('100.00');
  });
});

describe('break-even and contribution (FR-CST-005, FR-CST-006)', () => {
  it('makes fixed costs 600,000 at 85,000 a head with variable cost 71,400 a break-even of 45 heads and 3,825,000', () => {
    const line = breakEvenLine({ revenue: 85_000n, variableCost: 71_400n, unitsThousandths: 1_000n, fixedCost: 600_000n });
    expect(line).toEqual({
      contribution: 13_600n,
      contributionMarginPercent: '16.00',
      averagePrice: 85_000n,
      variableCostPerUnit: 71_400n,
      contributionPerUnit: 13_600n,
      breakEvenUnits: 45n,
      breakEvenRevenue: 3_825_000n,
      coveredPercent: '2.22',
    });
  });

  it('says there is no break-even when contribution is nothing or negative, or nothing was sold', () => {
    expect(breakEvenLine({ revenue: 71_400n, variableCost: 71_400n, unitsThousandths: 1_000n, fixedCost: 600_000n })).toMatchObject({ contribution: 0n, breakEvenUnits: null, breakEvenRevenue: null, coveredPercent: null });
    expect(breakEvenLine({ revenue: 60_000n, variableCost: 71_400n, unitsThousandths: 1_000n, fixedCost: 1n })).toMatchObject({ contribution: -11_400n, contributionMarginPercent: '19.00', breakEvenUnits: null });
    expect(breakEvenLine({ revenue: 0n, variableCost: 0n, unitsThousandths: 0n, fixedCost: 1n })).toMatchObject({ averagePrice: null, breakEvenUnits: null, contributionMarginPercent: null });
  });

  it('breaks even at nothing when there is no fixed cost, every sale covering it', () => {
    expect(breakEvenLine({ revenue: 85_000n, variableCost: 71_400n, unitsThousandths: 2_000n, fixedCost: 0n })).toMatchObject({ breakEvenUnits: 0n, breakEvenRevenue: 0n, coveredPercent: '100.00' });
  });

  it('counts units by the whole unit sold and caps covered at 100 percent', () => {
    // 2.5 heads for 212,500: 85,000 a unit, half-up per unit; 13,600 a unit over 27,200 fixed is exactly 2 units.
    expect(breakEvenLine({ revenue: 212_500n, variableCost: 178_500n, unitsThousandths: 2_500n, fixedCost: 27_200n })).toMatchObject({ averagePrice: 85_000n, variableCostPerUnit: 71_400n, breakEvenUnits: 2n, breakEvenRevenue: 170_000n, coveredPercent: '100.00' });
  });

  it('counts a variable cost taken below nothing by returns as a negative cost per unit', () => {
    expect(breakEvenLine({ revenue: 1_000n, variableCost: -500n, unitsThousandths: 1_000n, fixedCost: 3_000n })).toMatchObject({ variableCostPerUnit: -500n, contributionPerUnit: 1_500n, breakEvenUnits: 2n, coveredPercent: '50.00' });
  });

  it('assigns the period’s fixed costs to the lines by their revenue through allocate', () => {
    expect(assignFixedCosts(1_000_001n, [{ key: 'LIVE', revenue: 2n }, { key: 'MEAT', revenue: 1n }]).map((a) => a.fixedCost)).toEqual([666_667n, 333_334n]);
    expect(assignFixedCosts(10n, [{ key: 'LIVE', revenue: 0n }, { key: 'MEAT', revenue: 0n }]).map((a) => a.fixedCost)).toEqual([5n, 5n]);
    expect(assignFixedCosts(0n, [{ key: 'LIVE', revenue: 5n }]).map((a) => a.fixedCost)).toEqual([0n]);
    expect(assignFixedCosts(7n, [])).toEqual([]);
  });

  it('gives each line its share of the total contribution, the shares summing to the whole', () => {
    expect(contributionShares([2_730_000n, 1_325_100n, 408_000n])).toEqual(['61.17', '29.69', '9.14']);
    expect(contributionShares([100n, -100n])).toEqual([null, null]);
    expect(contributionShares([0n, 0n])).toEqual([null, null]);
  });
});

describe('losses as their own figure (FR-CST-007)', () => {
  const loss = (f: Partial<LossFactInput>): LossFactInput => ({ groupId: null, label: 'Mortality', lossGroup: 'MORTALITY', isReversal: false, qty: '1.000', value: 0n, ...f });

  it('reports the doe at 62,500 under mortality and an expired lot of 8,000 under wastage, a reversal taking one back', () => {
    const rows = lossRows([
      loss({ value: 62_500n }),
      loss({ groupId: null, label: 'Wastage and expiry', lossGroup: 'WASTAGE', qty: '30.000', value: 8_000n }),
      loss({ value: 1_000n }),
      loss({ value: 1_000n, isReversal: true }),
    ]);
    expect(rows).toEqual([
      { key: 'null|Mortality|MORTALITY', groupId: null, label: 'Mortality', lossGroup: 'MORTALITY', events: 1, qty: '1.000', value: 62_500n },
      { key: 'null|Wastage and expiry|WASTAGE', groupId: null, label: 'Wastage and expiry', lossGroup: 'WASTAGE', events: 1, qty: '30.000', value: 8_000n },
    ]);
  });

  it('drops a group whose every loss was reversed', () => {
    expect(lossRows([loss({ value: 5n }), loss({ value: 5n, isReversal: true })])).toEqual([]);
  });
});
