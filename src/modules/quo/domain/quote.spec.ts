import { Quantity } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { canMoveQuote, canMoveVersion, judgeMargin, linkState, lineCost, lineNet, marginPercent, planHold, unitCost, versionFigures } from './quote';

const q = (text: string) => Quantity.parse(text);

describe('a quote line is extended once, half-up (FR-QUO-003, ADR-0001)', () => {
  it('prices 20 goats at 85,000 at 1,700,000', () => {
    expect(lineNet(85_000n, q('20.000'))).toBe(1_700_000n);
  });
  it('rounds an exact half up once: 2.500 at 3 is 8, 2.499 at 3 is 7', () => {
    expect([lineNet(3n, q('2.500')), lineNet(3n, q('2.499'))]).toEqual([8n, 7n]);
  });
  it('prices 3 crates at 6,000 at 18,000 and 7 single eggs at 220 at 1,540, each in its own unit (CR-045)', () => {
    expect([lineNet(6_000n, q('3.000')), lineNet(220n, q('7.000'))]).toEqual([18_000n, 1_540n]);
  });
  it('costs a line by its unit cost and quantity, half-up once, and an unknown cost stays unknown', () => {
    expect([lineCost(71_400n, q('20.000')), lineCost(3_500n, q('0.500')), lineCost(null, q('1.000'))]).toEqual([1_428_000n, 1_750n, null]);
  });
});

describe('margin over cost (FR-QUO-003, FR-QUO-005)', () => {
  it('is 19.05 percent on 1,700,000 over a cost of 1,428,000', () => {
    expect(marginPercent(1_700_000n, 1_428_000n)).toBe('19.05');
  });
  it('is 9.24 percent on 1,560,000 and exactly 10.00 on 1,570,800', () => {
    expect([marginPercent(1_560_000n, 1_428_000n), marginPercent(1_570_800n, 1_428_000n)]).toEqual(['9.24', '10.00']);
  });
  it('rounds half away from zero: 1 over 8 is 12.50, 1 under 8 is -12.50, 1 over 3 is 33.33', () => {
    expect([marginPercent(9n, 8n), marginPercent(7n, 8n), marginPercent(4n, 3n)]).toEqual(['12.50', '-12.50', '33.33']);
  });
  it('is above 100 when the price is more than twice the cost, and null with no cost or a nil cost', () => {
    expect([marginPercent(6_000n, 1_750n), marginPercent(100n, null), marginPercent(100n, 0n)]).toEqual(['242.86', null, null]);
  });
  it('is below a 10 percent floor at 1,570,799 and not at 1,570,800, compared exactly, never on the rounded figure', () => {
    expect([judgeMargin(1_570_799n, 1_428_000n, 1_000), judgeMargin(1_570_800n, 1_428_000n, 1_000)]).toEqual([true, false]);
  });
  it('is below the floor when the cost is unknown, and never below it on a nil cost', () => {
    expect([judgeMargin(100n, null, 1_000), judgeMargin(100n, 0n, 1_000)]).toEqual([true, false]);
  });
});

describe("a version's figures (FR-QUO-003)", () => {
  const goats = { qty: q('20.000'), unitPricePesewas: 85_000n, unitCostPesewas: 71_400n, belowEngineFloor: false };
  it('adds the delivery fee and the tax to the net, and judges the margin on the lines alone', () => {
    const f = versionFigures([goats], { deliveryFeePesewas: 6_000n, taxPesewas: 0n, floorBasisPoints: 1_000 });
    expect(f).toEqual({ netPesewas: 1_706_000n, taxPesewas: 0n, grossPesewas: 1_706_000n, estimatedCostPesewas: 1_428_000n, marginPercent: '19.05', belowMarginFloor: false, lineNets: [1_700_000n] });
  });
  it('needs approval for one line below the engine floor even when the margin clears the floor', () => {
    expect(versionFigures([{ ...goats, belowEngineFloor: true }], { deliveryFeePesewas: 0n, taxPesewas: 0n, floorBasisPoints: 1_000 }).belowMarginFloor).toBe(true);
  });
  it('has no cost and needs approval when one line has no cost', () => {
    const f = versionFigures([goats, { qty: q('1.000'), unitPricePesewas: 5_000n, unitCostPesewas: null, belowEngineFloor: false }], { deliveryFeePesewas: 0n, taxPesewas: 0n, floorBasisPoints: 1_000 });
    expect([f.estimatedCostPesewas, f.marginPercent, f.belowMarginFloor, f.netPesewas]).toEqual([null, null, true, 1_705_000n]);
  });
  it('adds the tax on top of a tax-exclusive net: 18,000 with 2,700 tax is 20,700 gross', () => {
    const f = versionFigures([{ qty: q('3.000'), unitPricePesewas: 6_000n, unitCostPesewas: 3_500n, belowEngineFloor: false }], { deliveryFeePesewas: 0n, taxPesewas: 2_700n, floorBasisPoints: 1_000 });
    expect([f.netPesewas, f.taxPesewas, f.grossPesewas, f.marginPercent]).toEqual([18_000n, 2_700n, 20_700n, '71.43']);
  });
  it('takes the tax out of tax-inclusive lines: 20,700 with 2,700 tax is a net of 18,000, judged on 18,000', () => {
    const f = versionFigures([{ qty: q('3.000'), unitPricePesewas: 6_900n, unitCostPesewas: 3_500n, belowEngineFloor: false }], { deliveryFeePesewas: 500n, taxPesewas: 2_700n, floorBasisPoints: 1_000, taxInclusive: true });
    expect([f.lineNets, f.netPesewas, f.taxPesewas, f.grossPesewas, f.marginPercent]).toEqual([[20_700n], 18_500n, 2_700n, 21_200n, '71.43']);
  });
});

describe('a quote link opens its version only while it is live (FR-QUO-008, CR-047)', () => {
  const at = new Date('2026-11-20T12:00:00Z');
  const live = { versionStatus: 'ISSUED' as const, quoteStatus: 'ISSUED' as const, isCurrent: true, validUntil: new Date('2026-11-27T23:59:59Z'), tokenExpiresAt: new Date('2026-11-27T23:59:59Z'), now: at };
  it('is open on the live version inside its validity', () => {
    expect(linkState(live)).toBe('OPEN');
  });
  it('is expired one millisecond after its validity, or after its own expiry', () => {
    expect(linkState({ ...live, now: new Date('2026-11-28T00:00:00Z') })).toBe('EXPIRED');
    expect(linkState({ ...live, tokenExpiresAt: new Date('2026-11-20T11:59:59Z') })).toBe('EXPIRED');
    expect(linkState({ ...live, quoteStatus: 'EXPIRED' })).toBe('EXPIRED');
  });
  it('is replaced once a newer version is issued', () => {
    expect(linkState({ ...live, versionStatus: 'SUPERSEDED', isCurrent: false })).toBe('REPLACED');
  });
  it('answers accepted on the accepted version, even once converted, and declined on a declined quote', () => {
    expect(linkState({ ...live, versionStatus: 'ACCEPTED', quoteStatus: 'ACCEPTED' })).toBe('ACCEPTED');
    expect(linkState({ ...live, versionStatus: 'ACCEPTED', quoteStatus: 'CONVERTED' })).toBe('ACCEPTED');
    expect(linkState({ ...live, quoteStatus: 'DECLINED' })).toBe('DECLINED');
  });
  it('is withdrawn when the quote was cancelled, whatever its version', () => {
    expect(linkState({ ...live, quoteStatus: 'CANCELLED' })).toBe('WITHDRAWN');
    expect(linkState({ ...live, versionStatus: 'ACCEPTED', quoteStatus: 'CANCELLED' })).toBe('WITHDRAWN');
  });
});

describe('the status machines (FR-QUO-006, FR-QUO-009)', () => {
  it('moves a quote only along its edges', () => {
    expect([canMoveQuote('DRAFT', 'ISSUED'), canMoveQuote('ISSUED', 'ACCEPTED'), canMoveQuote('ACCEPTED', 'CONVERTED'), canMoveQuote('EXPIRED', 'ACCEPTED'), canMoveQuote('CONVERTED', 'CANCELLED')]).toEqual([true, true, true, false, false]);
  });
  it('approves a version below the floor without issuing it; only the approved version is issued (the owner, 2026-11-19)', () => {
    expect([canMoveVersion('PENDING_APPROVAL', 'APPROVED'), canMoveVersion('PENDING_APPROVAL', 'ISSUED'), canMoveVersion('APPROVED', 'ISSUED'), canMoveVersion('APPROVED', 'DRAFT'), canMoveVersion('DRAFT', 'APPROVED')]).toEqual([true, false, true, false, false]);
  });
  it('freezes an issued version: it is only superseded or accepted', () => {
    expect([canMoveVersion('ISSUED', 'SUPERSEDED'), canMoveVersion('ISSUED', 'ACCEPTED'), canMoveVersion('ISSUED', 'DRAFT'), canMoveVersion('PENDING_APPROVAL', 'DRAFT'), canMoveVersion('SUPERSEDED', 'ISSUED')]).toEqual([true, true, false, true, false]);
  });
});

describe('the stock a quote line holds: only what is on hand, never more (FR-QUO-012, CR-045, the owner 2026-11-18, ADR-0019)', () => {
  it('fully on hand: 90 eggs take 60 of the first lot and 30 of the next, nothing short', () => {
    expect(planHold(q('90.000'), [q('60.000'), q('100.000')])).toEqual({
      pieces: [{ index: 0, qty: q('60.000') }, { index: 1, qty: q('30.000') }],
      available: q('160.000'),
      held: q('90.000'),
      short: q('0.000'),
    });
  });
  it('partly on hand: 900.001 eggs hold the 900.000 there and are short 0.001', () => {
    expect(planHold(q('900.001'), [q('900.000')])).toEqual({ pieces: [{ index: 0, qty: q('900.000') }], available: q('900.000'), held: q('900.000'), short: q('0.001') });
  });
  it('not on hand: 20 goats with none there hold nothing and are short 20', () => {
    expect(planHold(q('20.000'), [])).toEqual({ pieces: [], available: q('0.000'), held: q('0.000'), short: q('20.000') });
  });
  it('a balance below zero (an offline sale ahead of receipt, ADR-0081) is nothing on hand, never less', () => {
    expect(planHold(q('12.000'), [q('-5.000'), q('7.000'), q('0.000')])).toEqual({ pieces: [{ index: 1, qty: q('7.000') }], available: q('7.000'), held: q('7.000'), short: q('5.000') });
    expect(planHold(q('3.000'), [q('-4.000')])).toEqual({ pieces: [], available: q('0.000'), held: q('0.000'), short: q('3.000') });
  });
});

describe('the estimated unit cost of a line (FR-QUO-003)', () => {
  it('is 3,500 a crate of 30 from a pool of 105,000 for 900 eggs, and 116.667 an egg rounds to 117', () => {
    const pools = [{ valuePesewas: 105_000n, qty: q('900.000') }];
    expect([unitCost(pools, q('90.000'), q('3.000')), unitCost(pools, q('7.000'), q('7.000'))]).toEqual([3_500n, 117n]);
  });
  it('averages pools: two goats at 60,000 and 71,400 are 65,700 a head, and nothing to read is unknown', () => {
    const pools = [{ valuePesewas: 60_000n, qty: q('1.000') }, { valuePesewas: 71_400n, qty: q('1.000') }];
    expect([unitCost(pools, q('20.000'), q('20.000')), unitCost([], q('1.000'), q('1.000'))]).toEqual([65_700n, null]);
  });
});
