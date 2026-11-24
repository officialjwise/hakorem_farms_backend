import { Money, Rate } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import {
  DAY_COUNT_CONVENTION,
  allocateDistribution,
  daysInPeriod,
  distributableProfit,
  formatUnits,
  heldOn,
  investorTieKey,
  judgeDistributionPayment,
  judgeRunAction,
  judgeWithdrawal,
  parseUnits,
  sharePercent,
  unitDaysByInvestor,
  unitsFor,
  type UnitMovement,
} from './index';

const issue = (investorId: string, units: string, on: string): UnitMovement => ({ investorId, kind: 'ISSUE', unitsE4: parseUnits(units), effectiveOn: on });
const redeem = (investorId: string, units: string, on: string): UnitMovement => ({ investorId, kind: 'REDEEM', unitsE4: parseUnits(units), effectiveOn: on });
const E4 = 10_000n;
const Q1_2027 = { start: '2027-01-01', end: '2027-03-31' } as const;

/** ADR-0028 Test 1's three investors over 1 January to 31 March 2027. */
const ADR_TEST_1: UnitMovement[] = [
  issue('ama', '1000', '2026-06-01'),
  issue('kofi', '500', '2027-02-15'),
  issue('esi', '250', '2026-06-01'),
  issue('esi', '250', '2027-03-01'),
];
const LINES_OF = (unitDays: Map<string, bigint>) => [
  { investorId: 'ama', investorNo: 'INV-001', unitDaysE4: unitDays.get('ama') ?? 0n },
  { investorId: 'kofi', investorNo: 'INV-002', unitDaysE4: unitDays.get('kofi') ?? 0n },
  { investorId: 'esi', investorNo: 'INV-003', unitDaysE4: unitDays.get('esi') ?? 0n },
];

describe('distribution allocation (ADR-0028, FR-CAP-008, FR-CAP-009)', () => {
  it('allocates an awkward amount across three investors without creating or losing a pesewa', () => {
    const { netProfit, retained, distributable } = distributableProfit(1_666_668n, Rate.parsePercent('40'));
    expect([netProfit.pesewas, retained.pesewas, distributable.pesewas]).toEqual([1_666_668n, 666_667n, 1_000_001n]);
    const unitDays = unitDaysByInvestor(ADR_TEST_1, Q1_2027);
    expect([...unitDays.entries()].sort()).toEqual([
      ['ama', 90_000n * E4],
      ['esi', 30_250n * E4],
      ['kofi', 22_500n * E4],
    ]);
    const result = allocateDistribution(distributable, LINES_OF(unitDays), Rate.parsePercent('0'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((l) => l.allocated.pesewas)).toEqual([630_474n, 157_618n, 211_909n]);
    expect(result.value.reduce((sum, l) => sum + l.allocated.pesewas, 0n)).toBe(1_000_001n);
    expect(result.value.map((l) => l.receivedExtraPesewa)).toEqual([true, false, false]);
    expect(result.value.map((l) => [l.withheld.pesewas, l.netPayable.pesewas])).toEqual([
      [0n, 630_474n],
      [0n, 157_618n],
      [0n, 211_909n],
    ]);
    // Rounding each share half-up on its own loses a pesewa; the allocation does not do that.
    const halfUpEach = [90_000n, 22_500n, 30_250n].map((w) => (2n * 1_000_001n * w + 142_750n) / (2n * 142_750n));
    expect(halfUpEach).toEqual([630_473n, 157_618n, 211_909n]);
    expect(halfUpEach.reduce((a, b) => a + b, 0n)).toBe(1_000_000n);
    expect(result.value.map((l) => l.allocated.pesewas)).not.toEqual(halfUpEach);
  });

  it('breaks a tie between equal remainders by investor number', () => {
    const result = allocateDistribution(
      Money.ofPesewas(100n),
      [
        { investorId: 'c', investorNo: 'INV-003', unitDaysE4: 5n },
        { investorId: 'a', investorNo: 'INV-001', unitDaysE4: 5n },
        { investorId: 'b', investorNo: 'INV-002', unitDaysE4: 5n },
      ],
      Rate.parsePercent('0'),
    );
    expect(result.ok && result.value.map((l) => [l.investorId, l.allocated.pesewas, l.receivedExtraPesewa])).toEqual([
      ['c', 33n, false],
      ['a', 34n, true],
      ['b', 33n, false],
    ]);
  });

  it('breaks a tie by the investor number’s value, so INV-1000 comes after INV-999', () => {
    expect(investorTieKey('INV-999') < investorTieKey('INV-1000')).toBe(true);
    const result = allocateDistribution(
      Money.ofPesewas(1n),
      [
        { investorId: 'late', investorNo: 'INV-1000', unitDaysE4: 1n },
        { investorId: 'early', investorNo: 'INV-999', unitDaysE4: 1n },
      ],
      Rate.parsePercent('0'),
    );
    expect(result.ok && result.value.map((l) => l.allocated.pesewas)).toEqual([0n, 1n]);
  });

  it('refuses to allocate when all weights are zero', () => {
    const result = allocateDistribution(Money.ofPesewas(100n), LINES_OF(new Map()), Rate.parsePercent('0'));
    expect(result).toEqual({ ok: false, error: 'NO_UNIT_DAYS' });
    expect(allocateDistribution(Money.ofPesewas(100n), [], Rate.parsePercent('0'))).toEqual({ ok: false, error: 'NO_UNIT_DAYS' });
  });

  it('refuses two lines under one investor number', () => {
    const lines = [
      { investorId: 'a', investorNo: 'INV-001', unitDaysE4: 1n },
      { investorId: 'b', investorNo: 'INV-0001', unitDaysE4: 1n },
    ];
    expect(allocateDistribution(Money.ofPesewas(2n), lines, Rate.parsePercent('0'))).toEqual({ ok: false, error: 'DUPLICATE_INVESTOR' });
  });

  it('leaves out an investor who held nothing in the period', () => {
    const result = allocateDistribution(
      Money.ofPesewas(10n),
      [
        { investorId: 'a', investorNo: 'INV-001', unitDaysE4: 0n },
        { investorId: 'b', investorNo: 'INV-002', unitDaysE4: 7n },
      ],
      Rate.parsePercent('0'),
    );
    expect(result.ok && result.value.map((l) => [l.investorId, l.allocated.pesewas])).toEqual([['b', 10n]]);
  });

  it('allocates nothing of a zero distributable amount, to nobody’s extra pesewa', () => {
    const result = allocateDistribution(Money.zero(), [{ investorId: 'a', investorNo: 'INV-001', unitDaysE4: 7n }], Rate.parsePercent('0'));
    expect(result.ok && result.value.map((l) => [l.allocated.pesewas, l.receivedExtraPesewa])).toEqual([[0n, false]]);
  });

  it('withholds half-up of each investor’s allocation and pays the rest (FR-CAP-011)', () => {
    // 630,474 at 8 percent is 50,437.92: 50,438 withheld; 15 at 10 percent is 1.5: 2 withheld (exactly half rounds up);
    // 14 at 10 percent is 1.4: 1 withheld (just below half).
    const lines = allocateDistribution(
      Money.ofPesewas(630_474n),
      [{ investorId: 'a', investorNo: 'INV-001', unitDaysE4: 1n }],
      Rate.parsePercent('8'),
    );
    expect(lines.ok && [lines.value[0]!.withheld.pesewas, lines.value[0]!.netPayable.pesewas]).toEqual([50_438n, 580_036n]);
    const half = allocateDistribution(Money.ofPesewas(15n), [{ investorId: 'a', investorNo: 'INV-001', unitDaysE4: 1n }], Rate.parsePercent('10'));
    expect(half.ok && half.value[0]!.withheld.pesewas).toBe(2n);
    const below = allocateDistribution(Money.ofPesewas(14n), [{ investorId: 'a', investorNo: 'INV-001', unitDaysE4: 1n }], Rate.parsePercent('10'));
    expect(below.ok && below.value[0]!.withheld.pesewas).toBe(1n);
  });

  it('allocates the largest amount the ledger can hold exactly', () => {
    const max = Money.ofPesewas(Money.MAX_PESEWAS);
    const result = allocateDistribution(
      max,
      [
        { investorId: 'a', investorNo: 'INV-001', unitDaysE4: 920_000_000n },
        { investorId: 'b', investorNo: 'INV-002', unitDaysE4: 235_000_000n },
      ],
      Rate.parsePercent('0'),
    );
    expect(result.ok && result.value.reduce((s, l) => s + l.allocated.pesewas, 0n)).toBe(Money.MAX_PESEWAS);
  });
});

describe('distributable profit (FR-CAP-006)', () => {
  it('applies the retention rate with half-up', () => {
    // 1,666,668 at 40 percent is 666,667.2: 666,667 kept, 1,000,001 to share.
    expect(distributableProfit(1_666_668n, Rate.parsePercent('40'))).toMatchObject({ isLoss: false });
    // UAT scenario 4: 4,166,670 at 40 percent is exactly 1,666,668.
    const uat = distributableProfit(4_166_670n, Rate.parsePercent('40'));
    expect([uat.netProfit.pesewas, uat.retained.pesewas, uat.distributable.pesewas]).toEqual([4_166_670n, 1_666_668n, 2_500_002n]);
    // 5 at 10 percent is 0.5: exactly half rounds up to 1; 4 at 10 percent is 0.4: 0.
    expect(distributableProfit(5n, Rate.parsePercent('10')).retained.pesewas).toBe(1n);
    expect(distributableProfit(4n, Rate.parsePercent('10')).retained.pesewas).toBe(0n);
  });

  it('records a loss or a break-even period as nothing to share', () => {
    for (const net of [0n, -250_000n]) {
      const result = distributableProfit(net, Rate.parsePercent('40'));
      expect([result.isLoss, result.netProfit.pesewas, result.retained.pesewas, result.distributable.pesewas]).toEqual([net < 0n, 0n, 0n, 0n]);
    }
  });

  it('keeps everything at 100 percent retention and shares everything at 0 percent', () => {
    expect(distributableProfit(1_234n, Rate.parsePercent('100')).distributable.pesewas).toBe(0n);
    expect(distributableProfit(1_234n, Rate.parsePercent('0')).distributable.pesewas).toBe(1_234n);
  });
});

describe('unit-days (FR-CAP-007, ADR-0028)', () => {
  it('counts the contribution day and not the withdrawal day', () => {
    const unitDays = unitDaysByInvestor([issue('ama', '100', '2027-04-10'), redeem('ama', '100', '2027-04-20')], { start: '2027-04-01', end: '2027-04-30' });
    expect(unitDays.get('ama')).toBe(1_000n * E4);
    expect(daysInPeriod({ start: '2027-04-01', end: '2027-04-30' })).toBe(30);
  });

  it('counts actual calendar days, both ends of the period, across a leap day', () => {
    expect(daysInPeriod({ start: '2026-07-01', end: '2026-09-30' })).toBe(92);
    expect(daysInPeriod({ start: '2028-02-01', end: '2028-02-29' })).toBe(29);
    expect(unitDaysByInvestor([issue('a', '1', '2028-02-28')], { start: '2028-02-01', end: '2028-03-01' }).get('a')).toBe(3n * E4);
  });

  it('counts nothing for units issued after the period or redeemed before it', () => {
    const unitDays = unitDaysByInvestor(
      [issue('late', '100', '2027-05-01'), issue('gone', '100', '2026-01-01'), redeem('gone', '100', '2027-03-01')],
      { start: '2027-04-01', end: '2027-04-30' },
    );
    expect(unitDays.get('late')).toBeUndefined();
    expect(unitDays.get('gone')).toBe(0n);
  });

  it('weights fractional units exactly, four places', () => {
    expect(unitDaysByInvestor([issue('a', '0.0001', '2027-04-30')], { start: '2027-04-01', end: '2027-04-30' }).get('a')).toBe(1n);
  });

  it('matches UAT scenario 4 part A: 320,400 unit-days over July to September 2026', () => {
    const q3 = { start: '2026-07-01', end: '2026-09-30' } as const;
    const unitDays = unitDaysByInvestor(
      [
        issue('ama', '1000', '2025-06-01'),
        issue('kofi', '500', '2026-08-15'),
        issue('esi', '250', '2025-06-01'),
        issue('esi', '250', '2026-09-01'),
        issue('yaw', '200', '2025-11-01'),
        issue('akwaaba', '2000', '2026-07-15'),
      ],
      q3,
    );
    expect(Object.fromEntries([...unitDays].map(([k, v]) => [k, v / E4]))).toEqual({ ama: 92_000n, kofi: 23_500n, esi: 30_500n, yaw: 18_400n, akwaaba: 156_000n });
    const { distributable } = distributableProfit(4_166_670n, Rate.parsePercent('40'));
    const lines = allocateDistribution(
      distributable,
      ([['ama', 'INV-001'], ['kofi', 'INV-002'], ['esi', 'INV-003'], ['yaw', 'INV-004'], ['akwaaba', 'INV-005']] as const).map(([id, no]) => ({ investorId: id, investorNo: no, unitDaysE4: unitDays.get(id)! })),
      Rate.parsePercent('0'),
    );
    expect(lines.ok && lines.value.map((l) => [l.allocated.pesewas, l.receivedExtraPesewa])).toEqual([
      [717_853n, false],
      [183_365n, true],
      [237_984n, true],
      [143_571n, true],
      [1_217_229n, false],
    ]);
  });
});

describe('units and holdings (FR-CAP-003 to FR-CAP-005)', () => {
  it('issues units at the unit price, to four places, only when they divide exactly', () => {
    expect(unitsFor(Money.ofPesewas(50_000n), Money.ofPesewas(100n))).toEqual({ ok: true, value: 5_000_000n });
    expect(formatUnits(5_000_000n)).toBe('500.0000');
    expect(unitsFor(Money.ofPesewas(10_000_000n), Money.ofPesewas(10_000n))).toEqual({ ok: true, value: 10_000_000n });
    expect(unitsFor(Money.ofPesewas(1n), Money.ofPesewas(3n))).toEqual({ ok: false, error: 'UNITS_NOT_EXACT' });
  });

  it('reads and writes units as four-place decimals', () => {
    expect(parseUnits('1000')).toBe(10_000_000n);
    expect(parseUnits('0.5')).toBe(5_000n);
    expect(parseUnits('12.3456')).toBe(123_456n);
    expect(formatUnits(0n)).toBe('0.0000');
    expect(formatUnits(123_456n)).toBe('12.3456');
    expect(() => parseUnits('1.23456')).toThrow();
    expect(() => parseUnits('-1')).toThrow();
  });

  it('recomputes the percentages from the effective date', () => {
    const movements = [issue('ama', '1000', '2027-01-01'), issue('kofi', '500', '2027-01-01'), issue('esi', '500', '2027-03-01')];
    const feb = heldOn(movements, '2027-02-28');
    expect([sharePercent(feb.get('ama')!, 15_000_000n), sharePercent(feb.get('kofi')!, 15_000_000n)]).toEqual(['66.6667', '33.3333']);
    expect(feb.get('esi')).toBeUndefined();
    const march = heldOn(movements, '2027-03-01');
    const total = [...march.values()].reduce((a, b) => a + b, 0n);
    expect(['ama', 'kofi', 'esi'].map((id) => sharePercent(march.get(id)!, total))).toEqual(['50.0000', '25.0000', '25.0000']);
    expect(sharePercent(0n, 0n)).toBe('0.0000');
    expect(sharePercent(1n, 1n)).toBe('100.0000');
  });

  it('holds a redemption from its effective date: the withdrawal day is not a day held', () => {
    const movements = [issue('ama', '500', '2027-01-01'), redeem('ama', '100', '2027-04-20')];
    expect(heldOn(movements, '2027-04-19').get('ama')).toBe(5_000_000n);
    expect(heldOn(movements, '2027-04-20').get('ama')).toBe(4_000_000n);
  });

  it('refuses a withdrawal of more units than are held on its effective date or any day after', () => {
    const movements = [issue('ama', '500', '2027-01-01'), redeem('ama', '300', '2027-06-01')];
    expect(judgeWithdrawal(movements, 'ama', parseUnits('600'), '2027-03-01')).toEqual(['MORE_THAN_HELD']);
    expect(judgeWithdrawal(movements, 'ama', parseUnits('100'), '2027-03-01')).toEqual([]);
    // 300 more on 1 March leaves 200, and the 300 already redeemed on 1 June would take it below nothing.
    expect(judgeWithdrawal(movements, 'ama', parseUnits('300'), '2027-03-01')).toEqual(['MORE_THAN_HELD']);
    expect(judgeWithdrawal(movements, 'ama', parseUnits('100'), '2026-12-31')).toEqual(['MORE_THAN_HELD']);
    expect(judgeWithdrawal(movements, 'kofi', parseUnits('1'), '2027-03-01')).toEqual(['MORE_THAN_HELD']);
  });
});

describe('the run’s lifecycle (FR-CAP-010)', () => {
  it('moves draft, pending approval, approved, posted, paid, and nothing else', () => {
    expect(judgeRunAction('RECOMPUTE', 'DRAFT', 1n)).toBeNull();
    expect(judgeRunAction('SUBMIT', 'DRAFT', 1n)).toBeNull();
    expect(judgeRunAction('POST', 'APPROVED', 1n)).toBeNull();
    expect(judgeRunAction('PAY', 'POSTED', 1n)).toBeNull();
    for (const status of ['PENDING_APPROVAL', 'APPROVED', 'POSTED', 'PAID', 'REJECTED'] as const) expect(judgeRunAction('RECOMPUTE', status, 1n)).toBe('RUN_NOT_EDITABLE');
    for (const status of ['PENDING_APPROVAL', 'APPROVED', 'POSTED', 'PAID', 'REJECTED'] as const) expect(judgeRunAction('SUBMIT', status, 1n)).toBe('RUN_NOT_DRAFT');
    for (const status of ['DRAFT', 'PENDING_APPROVAL', 'POSTED', 'PAID', 'REJECTED'] as const) expect(judgeRunAction('POST', status, 1n)).toBe('RUN_NOT_APPROVED');
    for (const status of ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAID', 'REJECTED'] as const) expect(judgeRunAction('PAY', status, 1n)).toBe('RUN_NOT_POSTED');
  });

  it('refuses to submit a run with nothing to share', () => {
    expect(judgeRunAction('SUBMIT', 'DRAFT', 0n)).toBe('NOTHING_TO_DISTRIBUTE');
  });

  it('states the day-count convention as text', () => {
    expect(DAY_COUNT_CONVENTION).toContain('the contribution day counts, the withdrawal day does not');
  });
});

describe('paying a distribution line (FR-CAP-012)', () => {
  it('cannot exceed net payable', () => {
    expect(judgeDistributionPayment({ netPayable: 630_474n, paid: 0n }, 300_000n)).toEqual({ ok: true, value: { paid: 300_000n, fullyPaid: false } });
    expect(judgeDistributionPayment({ netPayable: 630_474n, paid: 300_000n }, 330_474n)).toEqual({ ok: true, value: { paid: 630_474n, fullyPaid: true } });
    expect(judgeDistributionPayment({ netPayable: 630_474n, paid: 300_000n }, 330_475n)).toEqual({ ok: false, error: 'MORE_THAN_PAYABLE' });
    expect(judgeDistributionPayment({ netPayable: 630_474n, paid: 630_474n }, 1n)).toEqual({ ok: false, error: 'LINE_PAID' });
    expect(judgeDistributionPayment({ netPayable: 630_474n, paid: 0n }, 0n)).toEqual({ ok: false, error: 'NOT_POSITIVE' });
  });
});
