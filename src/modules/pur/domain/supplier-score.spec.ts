import { describe, expect, it } from 'vitest';
import { combineScore, onTimeComponent, percent, percentText, priceComponent, priceVariance, qualityComponent, rejectedAtReceipt, rejectionComponent, type ScoreWeights } from './supplier-score';

const SRS_WEIGHTS: ScoreWeights = { price: 30n, leadTime: 25n, quality: 25n, rejection: 20n };

describe('a supplier score from its four components (FR-PUR-014)', () => {
  it('combines the four components with weights: 0.30 x 90 + 0.25 x 80 + 0.25 x 100 + 0.20 x 95 = 91.0', () => {
    const score = combineScore({ price: percent(90n), leadTime: percent(80n), quality: percent(100n), rejection: percent(95n) }, SRS_WEIGHTS);
    expect(score === null ? null : percentText(score)).toBe('91.00');
  });

  it('reaches 91.0 from the farm facts behind each component, by hand', () => {
    // Price: Kpone was paid 110,000 for 20 goats where the farm paid 5,000 a head on average: 10 percent over, so 90.
    const price = priceComponent([{ supplierNetPesewas: 110_000n, supplierQtyThousandths: 20_000n, allNetPesewas: 500_000n, allQtyThousandths: 100_000n }]);
    // Lead time: four of five receipts came on or before the promised day, so 80.
    const leadTime = onTimeComponent(['2026-10-03', '2026-10-09', '2026-10-15', '2026-10-21', '2026-10-28'].map((receivedOn, i) => ({ receivedOn, promisedOn: i === 4 ? '2026-10-27' : receivedOn })));
    // Quality: all 20 received were accepted, so 100. Rejection: 1 of the 20 accepted went back to the supplier, 5 percent, so 95.
    const quality = qualityComponent(20_000n, 0n);
    const rejection = rejectionComponent(1_000n, 20_000n);
    expect([price, leadTime, quality, rejection].map((c) => (c === null ? null : percentText(c)))).toEqual(['90.00', '80.00', '100.00', '95.00']);
    const score = combineScore({ price: price!, leadTime: leadTime!, quality: quality!, rejection: rejection! }, SRS_WEIGHTS);
    expect(percentText(score!)).toBe('91.00');
  });

  it('divides by the weights as they are set, so weights that do not add up to 100 still give a score from 0 to 100', () => {
    const score = combineScore({ price: percent(90n), leadTime: percent(80n), quality: percent(100n), rejection: percent(95n) }, { price: 3n, leadTime: 0n, quality: 0n, rejection: 1n });
    // (3 x 90 + 1 x 95) / 4 = 91.25
    expect(percentText(score!)).toBe('91.25');
  });

  it('has no score while any component has no facts, or when every weight is zero', () => {
    expect(combineScore({ price: null, leadTime: percent(80n), quality: percent(100n), rejection: percent(95n) }, SRS_WEIGHTS)).toBeNull();
    expect(combineScore({ price: percent(1n), leadTime: percent(1n), quality: percent(1n), rejection: percent(1n) }, { price: 0n, leadTime: 0n, quality: 0n, rejection: 0n })).toBeNull();
  });

  it('rounds the shown percentage half-up once, to two places', () => {
    // One of three on time is 33.333... percent; two of three is 66.666...
    expect(percentText(onTimeComponent([{ receivedOn: '2026-10-02', promisedOn: '2026-10-02' }, { receivedOn: '2026-10-05', promisedOn: '2026-10-04' }, { receivedOn: '2026-10-09', promisedOn: '2026-10-08' }])!)).toBe('33.33');
    expect(percentText(onTimeComponent([{ receivedOn: '2026-10-02', promisedOn: '2026-10-02' }, { receivedOn: '2026-10-05', promisedOn: '2026-10-06' }, { receivedOn: '2026-10-09', promisedOn: '2026-10-08' }])!)).toBe('66.67');
    // 1 of 8 returned is 12.5 percent: exactly representable, so 87.50.
    expect(percentText(rejectionComponent(1_000n, 8_000n)!)).toBe('87.50');
    // An exact half rounds up: 1 thousandth accepted of 20,000 received is 0.005 percent, shown as 0.01; one less is 0.00.
    expect(percentText(qualityComponent(1n, 19_999n)!)).toBe('0.01');
    expect(percentText(qualityComponent(1n, 20_000n)!)).toBe('0.00');
  });
});

describe('each component (FR-PUR-014)', () => {
  it('scores price against the average paid for each product, never above 100 for a cheaper supplier and never below 0', () => {
    const cheaper = priceComponent([{ supplierNetPesewas: 90_000n, supplierQtyThousandths: 20_000n, allNetPesewas: 500_000n, allQtyThousandths: 100_000n }]);
    expect(percentText(cheaper!)).toBe('100.00');
    const triple = priceComponent([{ supplierNetPesewas: 330_000n, supplierQtyThousandths: 20_000n, allNetPesewas: 500_000n, allQtyThousandths: 100_000n }]);
    expect(percentText(triple!)).toBe('0.00');
    // Two products: 20 goats at 5,500 against 5,000 (10,000 over) and 100 kg of feed at 400 against 400; over by 10,000 of 140,000.
    const two = priceComponent([
      { supplierNetPesewas: 110_000n, supplierQtyThousandths: 20_000n, allNetPesewas: 500_000n, allQtyThousandths: 100_000n },
      { supplierNetPesewas: 40_000n, supplierQtyThousandths: 100_000n, allNetPesewas: 80_000n, allQtyThousandths: 200_000n },
    ]);
    expect(percentText(two!)).toBe('92.86');
    expect(priceComponent([])).toBeNull();
  });

  it('scores lead time as the share of receipts on or before the promised day, leaving out receipts with no promise', () => {
    expect(onTimeComponent([{ receivedOn: '2026-10-02', promisedOn: null }])).toBeNull();
    expect(percentText(onTimeComponent([{ receivedOn: '2026-10-02', promisedOn: null }, { receivedOn: '2026-10-03', promisedOn: '2026-10-04' }])!)).toBe('100.00');
  });

  it('scores quality as the accepted share of what was received, and rejection as 100 less the share sent back', () => {
    expect(percentText(qualityComponent(19_000n, 1_000n)!)).toBe('95.00');
    expect(qualityComponent(0n, 0n)).toBeNull();
    expect(rejectionComponent(0n, 0n)).toBeNull();
    // More sent back than accepted in the period (returns of an earlier month's goods) scores 0, not below.
    expect(percentText(rejectionComponent(30_000n, 20_000n)!)).toBe('0.00');
  });

  it('shows the price over the average and the share rejected at the gate as the contract fields', () => {
    expect(percentText(priceVariance([{ supplierNetPesewas: 110_000n, supplierQtyThousandths: 20_000n, allNetPesewas: 500_000n, allQtyThousandths: 100_000n }])!)).toBe('10.00');
    expect(priceVariance([])).toBeNull();
    expect(percentText(rejectedAtReceipt(19_000n, 1_000n)!)).toBe('5.00');
    expect(rejectedAtReceipt(0n, 0n)).toBeNull();
  });
});
