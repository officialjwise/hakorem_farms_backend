import { Money, MoneyRangeError, Rate } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import {
  categoryTaxRule,
  sumTaxedLines,
  taxExclusive,
  taxInclusive,
  type CategoryTaxRule,
  type TaxBreakdown,
  type TaxCellInput,
  type TaxTreatment,
} from './tax-calculator';

// The seeded levies (ADR-0020). Calculation order VAT, NHIL, GETFund: a tied leftover pesewa goes to the earlier one.
const VAT = { id: 'levy-vat', code: 'VAT', name: 'Value added tax' };
const NHIL = { id: 'levy-nhil', code: 'NHIL', name: 'National Health Insurance Levy' };
const GETFUND = { id: 'levy-getfund', code: 'GETFUND', name: 'GETFund Levy' };

function cell(levy: typeof VAT, fields: Partial<Omit<TaxCellInput, 'levy'>> = {}): TaxCellInput {
  return {
    levy,
    treatment: 'STANDARD',
    rate: Rate.parsePercent('0'),
    baseKind: 'NET',
    baseLevyIds: [],
    isReclaimable: true,
    calcOrder: 1,
    ...fields,
  };
}

function rule(cells: TaxCellInput[], categoryId = 'cat-processed-meat'): CategoryTaxRule {
  const built = categoryTaxRule({ versionId: 'scheme-v1', categoryId, cells });
  if (!built.ok) {
    throw new Error(`test rule refused: ${built.error.code}`);
  }
  return built.value;
}

/** PROCESSED_MEAT, OTHER_GOODS and DELIVERY_SERVICE in the seed: 15, 2.5 and 2.5 percent, all on the net. */
const STANDARD = rule([
  cell(VAT, { rate: Rate.parsePercent('15'), calcOrder: 1 }),
  cell(NHIL, { rate: Rate.parsePercent('2.5'), calcOrder: 2 }),
  cell(GETFUND, { rate: Rate.parsePercent('2.5'), calcOrder: 3 }),
]);

function noLevies(treatment: TaxTreatment, isReclaimable: boolean): CategoryTaxRule {
  return rule(
    [
      cell(VAT, { treatment, isReclaimable, calcOrder: 1 }),
      cell(NHIL, { treatment, isReclaimable, calcOrder: 2 }),
      cell(GETFUND, { treatment, isReclaimable, calcOrder: 3 }),
    ],
    `cat-${treatment.toLowerCase()}`,
  );
}

/** LIVE_ANIMALS, RAW_PRODUCE, EGGS and FARM_INPUTS in the seed. */
const ZERO_RATED = noLevies('ZERO_RATED', true);
/** Not in the seed: the accountant may yet move raw produce here (ADR-0020). Nothing charged, nothing reclaimable. */
const EXEMPT = noLevies('EXEMPT', false);

/** The pre-2023 shape: NHIL and GETFund on the net, VAT on the net plus both levies. */
const COMPOUNDING = rule([
  cell(NHIL, { rate: Rate.parsePercent('2.5'), calcOrder: 1 }),
  cell(GETFUND, { rate: Rate.parsePercent('2.5'), calcOrder: 2 }),
  cell(VAT, { rate: Rate.parsePercent('15'), calcOrder: 3, baseKind: 'NET_PLUS_LEVIES', baseLevyIds: [NHIL.id, GETFUND.id] }),
]);

const REGISTERED = true;
const NOT_REGISTERED = false;

function pesewas(amount: Money): bigint {
  return amount.pesewas;
}

function amounts(breakdown: TaxBreakdown): Record<string, bigint> {
  return Object.fromEntries(breakdown.levies.map((line) => [line.levyCode, line.amount.pesewas]));
}

function bases(breakdown: TaxBreakdown): Record<string, bigint> {
  return Object.fromEntries(breakdown.levies.map((line) => [line.levyCode, line.base.pesewas]));
}

function partsSum(breakdown: TaxBreakdown): bigint {
  return breakdown.levies.reduce((sum, line) => sum + line.amount.pesewas, breakdown.net.pesewas);
}

function inclusive(gross: bigint, scheme: CategoryTaxRule, registered = REGISTERED): TaxBreakdown {
  const result = taxInclusive(Money.ofPesewas(gross), scheme, registered);
  if (!result.ok) {
    throw new Error(`allocation refused: ${result.error.code}`);
  }
  return result.value;
}

describe('tax calculator, tax-exclusive line (FR-MDM-013, ADR-0020)', () => {
  it('charges VAT 1,500, NHIL 250 and GETFund 250 on a processed-meat net of 10,000, gross 12,000', () => {
    const line = taxExclusive(Money.ofPesewas(10_000n), STANDARD, REGISTERED);

    expect(pesewas(line.net)).toBe(10_000n);
    expect(amounts(line)).toEqual({ VAT: 1_500n, NHIL: 250n, GETFUND: 250n });
    expect(bases(line)).toEqual({ VAT: 10_000n, NHIL: 10_000n, GETFUND: 10_000n });
    expect(pesewas(line.tax)).toBe(2_000n);
    expect(pesewas(line.gross)).toBe(12_000n);
    expect(line.pricing).toBe('EXCLUSIVE');
    expect(line.versionId).toBe('scheme-v1');
    expect(line.categoryTreatment).toBe('STANDARD');
  });

  it('states a zero-rated goat line as three ZERO_RATED rows at 0, gross equal to net', () => {
    const line = taxExclusive(Money.ofPesewas(65_000n), ZERO_RATED, REGISTERED);

    expect(line.levies.map((row) => [row.levyCode, row.treatment, row.amount.pesewas, row.isReclaimable])).toEqual([
      ['VAT', 'ZERO_RATED', 0n, true],
      ['NHIL', 'ZERO_RATED', 0n, true],
      ['GETFUND', 'ZERO_RATED', 0n, true],
    ]);
    expect(pesewas(line.gross)).toBe(65_000n);
    expect(line.categoryTreatment).toBe('ZERO_RATED');
  });

  it('states an exempt line as three EXEMPT rows at 0, none reclaimable, gross equal to net', () => {
    const line = taxExclusive(Money.ofPesewas(4_500n), EXEMPT, REGISTERED);

    expect(line.levies.map((row) => [row.levyCode, row.treatment, row.amount.pesewas, row.isReclaimable])).toEqual([
      ['VAT', 'EXEMPT', 0n, false],
      ['NHIL', 'EXEMPT', 0n, false],
      ['GETFUND', 'EXEMPT', 0n, false],
    ]);
    expect(pesewas(line.tax)).toBe(0n);
    expect(pesewas(line.gross)).toBe(4_500n);
    expect(line.categoryTreatment).toBe('EXEMPT');
  });

  it('charges nothing when the business is not registered, and still produces a row per levy', () => {
    const line = taxExclusive(Money.ofPesewas(10_000n), STANDARD, NOT_REGISTERED);

    expect(amounts(line)).toEqual({ VAT: 0n, NHIL: 0n, GETFUND: 0n });
    expect(pesewas(line.gross)).toBe(10_000n);
    expect(line.registered).toBe(false);
    expect(line.levies.map((row) => row.rate.toPercentString())).toEqual(['15', '2.5', '2.5']);
  });

  it('compounds VAT on the net plus NHIL and GETFund: net 10,000 gives 250, 250 and VAT 1,575 on a base of 10,500', () => {
    const line = taxExclusive(Money.ofPesewas(10_000n), COMPOUNDING, REGISTERED);

    expect(amounts(line)).toEqual({ NHIL: 250n, GETFUND: 250n, VAT: 1_575n });
    expect(bases(line)).toEqual({ NHIL: 10_000n, GETFUND: 10_000n, VAT: 10_500n });
    expect(pesewas(line.gross)).toBe(12_075n);
  });

  it('rounds a compounded levy half-up once on its integer base', () => {
    // NHIL and GETFund on 30 are 0.75 each, so 1 and 1; VAT on 32 is 4.8, so 5. Never 15 percent of 31.5.
    const line = taxExclusive(Money.ofPesewas(30n), COMPOUNDING, REGISTERED);

    expect(amounts(line)).toEqual({ NHIL: 1n, GETFUND: 1n, VAT: 5n });
    expect(bases(line).VAT).toBe(32n);
    expect(pesewas(line.gross)).toBe(37n);
  });

  it('rounds a levy of exactly half a pesewa up: NHIL on 20 is 0.5, so 1', () => {
    const line = taxExclusive(Money.ofPesewas(20n), STANDARD, REGISTERED);

    expect(amounts(line)).toEqual({ VAT: 3n, NHIL: 1n, GETFUND: 1n });
    expect(pesewas(line.gross)).toBe(25n);
  });

  it('rounds a levy just below half a pesewa down: NHIL on 19 is 0.475, so 0', () => {
    const line = taxExclusive(Money.ofPesewas(19n), STANDARD, REGISTERED);

    expect(amounts(line)).toEqual({ VAT: 3n, NHIL: 0n, GETFUND: 0n });
    expect(pesewas(line.gross)).toBe(22n);
  });

  it('rounds a levy just above half a pesewa up: NHIL on 21 is 0.525, so 1', () => {
    const line = taxExclusive(Money.ofPesewas(21n), STANDARD, REGISTERED);

    expect(amounts(line)).toEqual({ VAT: 3n, NHIL: 1n, GETFUND: 1n });
    expect(pesewas(line.gross)).toBe(26n);
  });

  it('charges nothing on a net of zero', () => {
    const line = taxExclusive(Money.zero(), STANDARD, REGISTERED);

    expect(amounts(line)).toEqual({ VAT: 0n, NHIL: 0n, GETFUND: 0n });
    expect(pesewas(line.gross)).toBe(0n);
  });

  it('carries the largest amount through a zero-rated line exactly', () => {
    const line = taxExclusive(Money.ofPesewas(Money.MAX_PESEWAS), ZERO_RATED, REGISTERED);

    expect(pesewas(line.gross)).toBe(9_007_199_254_740_991n);
  });

  it('refuses a gross above the largest amount rather than wrapping or losing a pesewa', () => {
    expect(() => taxExclusive(Money.ofPesewas(Money.MAX_PESEWAS), STANDARD, REGISTERED)).toThrow(MoneyRangeError);
  });

  it('returns the rows in calculation order whatever order the cells were given in', () => {
    const shuffled = rule([
      cell(GETFUND, { rate: Rate.parsePercent('2.5'), calcOrder: 3 }),
      cell(VAT, { rate: Rate.parsePercent('15'), calcOrder: 1 }),
      cell(NHIL, { rate: Rate.parsePercent('2.5'), calcOrder: 2 }),
    ]);

    const line = taxExclusive(Money.ofPesewas(10_000n), shuffled, REGISTERED);

    expect(line.levies.map((row) => [row.levyCode, row.calcOrder])).toEqual([
      ['VAT', 1],
      ['NHIL', 2],
      ['GETFUND', 3],
    ]);
  });
});

describe('tax calculator, tax-inclusive price (FR-MDM-014, ADR-0020)', () => {
  it('splits the GHS 459.00 beef pack into 382.50 net, 57.38 VAT, 9.56 NHIL and 9.56 GETFund, summing to 459.00', () => {
    const line = inclusive(45_900n, STANDARD);

    expect(pesewas(line.net)).toBe(38_250n);
    expect(amounts(line)).toEqual({ VAT: 5_738n, NHIL: 956n, GETFUND: 956n });
    expect(partsSum(line)).toBe(45_900n);
    expect(pesewas(line.gross)).toBe(45_900n);
    expect(pesewas(line.tax)).toBe(7_650n);
    expect(line.pricing).toBe('INCLUSIVE');
    expect([line.net, ...line.levies.map((row) => row.amount)].map((part) => part.toDecimalString())).toEqual([
      '382.50',
      '57.38',
      '9.56',
      '9.56',
    ]);
  });

  it('splits 10,000 into 8,334, 1,250, 208 and 208, giving the leftover pesewa to net first', () => {
    const line = inclusive(10_000n, STANDARD);

    expect(pesewas(line.net)).toBe(8_334n);
    expect(amounts(line)).toEqual({ VAT: 1_250n, NHIL: 208n, GETFUND: 208n });
    expect(partsSum(line)).toBe(10_000n);
  });

  it('does not round each part on its own, which would give 8,333 + 1,250 + 208 + 208 = 9,999', () => {
    // The rejected method: half_up(gross x weight / 1.2) part by part.
    const independent = [1_000n, 150n, 25n, 25n].map((weight) => (2n * 10_000n * weight + 1_200n) / 2_400n);
    expect(independent).toEqual([8_333n, 1_250n, 208n, 208n]);
    expect(independent.reduce((a, b) => a + b, 0n)).toBe(9_999n);

    expect(partsSum(inclusive(10_000n, STANDARD))).toBe(10_000n);
  });

  it('splits 12,000 back into net 10,000 and levies 1,500, 250 and 250', () => {
    const line = inclusive(12_000n, STANDARD);

    expect(pesewas(line.net)).toBe(10_000n);
    expect(amounts(line)).toEqual({ VAT: 1_500n, NHIL: 250n, GETFUND: 250n });
    expect(bases(line)).toEqual({ VAT: 10_000n, NHIL: 10_000n, GETFUND: 10_000n });
  });

  it('splits a GHS 30.00 delivery fee into 25.00, 3.75, 0.63 and 0.62: a tie between levies goes in calculation order', () => {
    const line = inclusive(3_000n, STANDARD);

    expect(pesewas(line.net)).toBe(2_500n);
    expect(amounts(line)).toEqual({ VAT: 375n, NHIL: 63n, GETFUND: 62n });
    expect(partsSum(line)).toBe(3_000n);
  });

  it('keeps a single pesewa as net', () => {
    const line = inclusive(1n, STANDARD);

    expect(pesewas(line.net)).toBe(1n);
    expect(amounts(line)).toEqual({ VAT: 0n, NHIL: 0n, GETFUND: 0n });
  });

  it('splits a gross of zero into zeros', () => {
    const line = inclusive(0n, STANDARD);

    expect(pesewas(line.net)).toBe(0n);
    expect(partsSum(line)).toBe(0n);
  });

  it('splits the largest amount into parts that still sum to it exactly', () => {
    const line = inclusive(Money.MAX_PESEWAS, STANDARD);

    expect(pesewas(line.net)).toBe(7_505_999_378_950_826n);
    expect(amounts(line)).toEqual({ VAT: 1_125_899_906_842_624n, NHIL: 187_649_984_473_771n, GETFUND: 187_649_984_473_770n });
    expect(partsSum(line)).toBe(9_007_199_254_740_991n);
  });

  it('leaves a zero-rated gross wholly as net', () => {
    const line = inclusive(65_000n, ZERO_RATED);

    expect(pesewas(line.net)).toBe(65_000n);
    expect(amounts(line)).toEqual({ VAT: 0n, NHIL: 0n, GETFUND: 0n });
    expect(line.categoryTreatment).toBe('ZERO_RATED');
  });

  it('leaves an exempt gross wholly as net', () => {
    const line = inclusive(4_500n, EXEMPT);

    expect(pesewas(line.net)).toBe(4_500n);
    expect(amounts(line)).toEqual({ VAT: 0n, NHIL: 0n, GETFUND: 0n });
    expect(line.categoryTreatment).toBe('EXEMPT');
  });

  it('leaves the whole gross as net when the business is not registered', () => {
    const line = inclusive(12_000n, STANDARD, NOT_REGISTERED);

    expect(pesewas(line.net)).toBe(12_000n);
    expect(amounts(line)).toEqual({ VAT: 0n, NHIL: 0n, GETFUND: 0n });
    expect(line.registered).toBe(false);
  });

  it('splits a compounding gross of 12,075 into net 10,000, NHIL 250, GETFund 250 and VAT 1,575', () => {
    const line = inclusive(12_075n, COMPOUNDING);

    expect(pesewas(line.net)).toBe(10_000n);
    expect(amounts(line)).toEqual({ NHIL: 250n, GETFUND: 250n, VAT: 1_575n });
    expect(bases(line)).toEqual({ NHIL: 10_000n, GETFUND: 10_000n, VAT: 10_500n });
  });

  it('splits a compounding gross of 100 by effective rates 1 : 0.025 : 0.025 : 0.1575 into 83, 2, 2 and 13', () => {
    const line = inclusive(100n, COMPOUNDING);

    expect(pesewas(line.net)).toBe(83n);
    expect(amounts(line)).toEqual({ NHIL: 2n, GETFUND: 2n, VAT: 13n });
    expect(bases(line).VAT).toBe(87n);
    expect(partsSum(line)).toBe(100n);
  });
});

describe('tax calculator, the rule for one category (ADR-0020)', () => {
  it('refuses a rate on a cell whose treatment is not STANDARD', () => {
    const built = categoryTaxRule({
      versionId: 'scheme-v1',
      categoryId: 'cat-eggs',
      cells: [cell(VAT, { treatment: 'ZERO_RATED', rate: Rate.parsePercent('15') })],
    });

    expect(built).toEqual({ ok: false, error: { code: 'TAX_RATE_NOT_ALLOWED', levyCode: 'VAT' } });
  });

  it('refuses a base component on a levy whose base is the net', () => {
    const built = categoryTaxRule({
      versionId: 'scheme-v1',
      categoryId: 'cat-processed-meat',
      cells: [cell(NHIL, { calcOrder: 1 }), cell(VAT, { calcOrder: 2, baseLevyIds: [NHIL.id] })],
    });

    expect(built).toEqual({ ok: false, error: { code: 'TAX_BASE_INVALID', levyCode: 'VAT' } });
  });

  it('refuses a NET_PLUS_LEVIES base that names no levy', () => {
    const built = categoryTaxRule({
      versionId: 'scheme-v1',
      categoryId: 'cat-processed-meat',
      cells: [cell(VAT, { baseKind: 'NET_PLUS_LEVIES' })],
    });

    expect(built).toEqual({ ok: false, error: { code: 'TAX_BASE_INVALID', levyCode: 'VAT' } });
  });

  it('refuses a base component that is not a levy of the same category', () => {
    const built = categoryTaxRule({
      versionId: 'scheme-v1',
      categoryId: 'cat-processed-meat',
      cells: [cell(VAT, { calcOrder: 2, baseKind: 'NET_PLUS_LEVIES', baseLevyIds: [NHIL.id] })],
    });

    expect(built).toEqual({ ok: false, error: { code: 'TAX_BASE_INVALID', levyCode: 'VAT' } });
  });

  it('refuses a base component calculated at or after the levy, so a definition cannot be circular', () => {
    const built = categoryTaxRule({
      versionId: 'scheme-v1',
      categoryId: 'cat-processed-meat',
      cells: [
        cell(VAT, { calcOrder: 1, baseKind: 'NET_PLUS_LEVIES', baseLevyIds: [NHIL.id] }),
        cell(NHIL, { calcOrder: 2, baseKind: 'NET_PLUS_LEVIES', baseLevyIds: [VAT.id] }),
      ],
    });

    expect(built).toEqual({ ok: false, error: { code: 'TAX_BASE_CIRCULAR', levyCode: 'VAT' } });
  });

  it('refuses two cells with one calculation order, which would leave a tied pesewa to chance', () => {
    const built = categoryTaxRule({
      versionId: 'scheme-v1',
      categoryId: 'cat-processed-meat',
      cells: [cell(NHIL, { calcOrder: 2 }), cell(GETFUND, { calcOrder: 2 })],
    });

    expect(built).toEqual({ ok: false, error: { code: 'TAX_CALC_ORDER_DUPLICATE', levyCode: 'GETFUND' } });
  });

  it('refuses a calculation order below one', () => {
    const built = categoryTaxRule({ versionId: 'scheme-v1', categoryId: 'cat-processed-meat', cells: [cell(VAT, { calcOrder: 0 })] });

    expect(built).toEqual({ ok: false, error: { code: 'TAX_CALC_ORDER_INVALID', levyCode: 'VAT' } });
  });

  it('refuses a calculation order that is not a whole number', () => {
    const built = categoryTaxRule({ versionId: 'scheme-v1', categoryId: 'cat-processed-meat', cells: [cell(VAT, { calcOrder: 1.5 })] });

    expect(built).toEqual({ ok: false, error: { code: 'TAX_CALC_ORDER_INVALID', levyCode: 'VAT' } });
  });

  it('refuses the same levy twice in one category', () => {
    const built = categoryTaxRule({
      versionId: 'scheme-v1',
      categoryId: 'cat-processed-meat',
      cells: [cell(VAT, { calcOrder: 1 }), cell(VAT, { calcOrder: 2 })],
    });

    expect(built).toEqual({ ok: false, error: { code: 'TAX_LEVY_DUPLICATE', levyCode: 'VAT' } });
  });

  it('refuses a category with no cells: missing never means zero', () => {
    const built = categoryTaxRule({ versionId: 'scheme-v1', categoryId: 'cat-eggs', cells: [] });

    expect(built).toEqual({ ok: false, error: { code: 'TAX_MATRIX_INCOMPLETE', levyCode: null } });
  });

  it('calls a category with standard and zero-rated levies MIXED', () => {
    const mixed = rule([
      cell(VAT, { rate: Rate.parsePercent('15'), calcOrder: 1 }),
      cell(NHIL, { treatment: 'ZERO_RATED', calcOrder: 2 }),
    ]);

    expect(taxExclusive(Money.ofPesewas(100n), mixed, REGISTERED).categoryTreatment).toBe('MIXED');
  });
});

describe('tax calculator, totals of several lines (FR-MDM-013)', () => {
  it('adds line integers for the totals and never recomputes tax on a total', () => {
    // Two lines of 19 each: NHIL 0 and GETFund 0 on each line, although 2.5 percent of 38 would round to 1.
    const lines = [taxExclusive(Money.ofPesewas(19n), STANDARD, REGISTERED), taxExclusive(Money.ofPesewas(19n), STANDARD, REGISTERED)];

    const totals = sumTaxedLines(lines);

    expect(pesewas(totals.net)).toBe(38n);
    expect(pesewas(totals.tax)).toBe(6n);
    expect(pesewas(totals.gross)).toBe(44n);
  });

  it('totals no lines as zero', () => {
    const totals = sumTaxedLines([]);

    expect([totals.net, totals.tax, totals.gross].map(pesewas)).toEqual([0n, 0n, 0n]);
  });
});
