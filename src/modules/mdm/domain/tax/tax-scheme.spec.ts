import { Rate } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import type { TaxCellInput } from './tax-calculator';
import { defineTaxMatrix, planTaxActivation, taxActivationWindow, taxSchemeInForce, type MatrixCellInput } from './tax-scheme';

const VAT = { id: 'levy-vat', code: 'VAT', name: 'Value added tax' };
const NHIL = { id: 'levy-nhil', code: 'NHIL', name: 'National Health Insurance Levy' };
const LEVIES = [VAT, NHIL];
const EGGS = { id: 'cat-eggs', code: 'EGGS' };
const MEAT = { id: 'cat-meat', code: 'PROCESSED_MEAT' };
const CATEGORIES = [EGGS, MEAT];

function cell(category: typeof EGGS, levy: typeof VAT, fields: Partial<TaxCellInput> = {}): MatrixCellInput {
  return {
    categoryId: category.id,
    levy,
    treatment: 'ZERO_RATED',
    rate: Rate.parsePercent('0'),
    baseKind: 'NET',
    baseLevyIds: [],
    isReclaimable: true,
    calcOrder: levy === VAT ? 1 : 2,
    ...fields,
  };
}

const COMPLETE = [
  cell(EGGS, VAT),
  cell(EGGS, NHIL),
  cell(MEAT, VAT, { treatment: 'STANDARD', rate: Rate.parsePercent('15') }),
  cell(MEAT, NHIL, { treatment: 'STANDARD', rate: Rate.parsePercent('2.5') }),
];

describe('tax scheme matrix (FR-MDM-012, ADR-0020)', () => {
  it('accepts a matrix with a valid cell for every category and levy, one rule per category', () => {
    const matrix = defineTaxMatrix('scheme-v2', COMPLETE, { categories: CATEGORIES, levies: LEVIES });

    expect(matrix.ok).toBe(true);
    expect(matrix.ok && matrix.value.map((rule) => [rule.categoryId, rule.cells.map((c) => c.levy.code), rule.treatment])).toEqual([
      ['cat-eggs', ['VAT', 'NHIL'], 'ZERO_RATED'],
      ['cat-meat', ['VAT', 'NHIL'], 'STANDARD'],
    ]);
  });

  it('refuses a matrix missing the EGGS/NHIL cell as TAX_MATRIX_INCOMPLETE, naming the gap', () => {
    const matrix = defineTaxMatrix('scheme-v2', COMPLETE.slice(0, 1).concat(COMPLETE.slice(2)), { categories: CATEGORIES, levies: LEVIES });

    expect(matrix).toEqual({ ok: false, error: { code: 'TAX_MATRIX_INCOMPLETE', missing: [{ categoryCode: 'EGGS', levyCode: 'NHIL' }], cell: null } });
  });

  it('refuses a matrix that lacks a cell for a levy added after it was drafted', () => {
    const GETFUND = { id: 'levy-getfund', code: 'GETFUND', name: 'GETFund Levy' };

    const matrix = defineTaxMatrix('scheme-v2', COMPLETE, { categories: CATEGORIES, levies: [...LEVIES, GETFUND] });

    expect(matrix.ok === false && matrix.error).toEqual({
      code: 'TAX_MATRIX_INCOMPLETE',
      missing: [
        { categoryCode: 'EGGS', levyCode: 'GETFUND' },
        { categoryCode: 'PROCESSED_MEAT', levyCode: 'GETFUND' },
      ],
      cell: null,
    });
  });

  it('refuses a cell for a category that is not a live category', () => {
    const matrix = defineTaxMatrix('scheme-v2', [...COMPLETE, cell({ id: 'cat-gone', code: 'GONE' }, VAT)], { categories: CATEGORIES, levies: LEVIES });

    expect(matrix).toEqual({ ok: false, error: { code: 'TAX_CELL_UNKNOWN_REFERENCE', missing: [], cell: { categoryId: 'cat-gone', levyCode: 'VAT' } } });
  });

  it('refuses a cell for a levy that is not a live levy', () => {
    const OLD = { id: 'levy-old', code: 'COVID', name: 'COVID-19 Health Recovery Levy' };

    const matrix = defineTaxMatrix('scheme-v2', [...COMPLETE, cell(EGGS, OLD, { calcOrder: 3 })], { categories: CATEGORIES, levies: LEVIES });

    expect(matrix).toEqual({ ok: false, error: { code: 'TAX_CELL_UNKNOWN_REFERENCE', missing: [], cell: { categoryId: 'cat-eggs', levyCode: 'COVID' } } });
  });

  it("passes on a category's own refusal, naming the category and the levy", () => {
    const bad = COMPLETE.map((c) => (c.categoryId === EGGS.id && c.levy === VAT ? { ...c, rate: Rate.parsePercent('15') } : c));

    const matrix = defineTaxMatrix('scheme-v2', bad, { categories: CATEGORIES, levies: LEVIES });

    expect(matrix).toEqual({ ok: false, error: { code: 'TAX_RATE_NOT_ALLOWED', missing: [], cell: { categoryId: 'cat-eggs', levyCode: 'VAT' } } });
  });

  it('refuses a matrix for a business with no live category or levy at all', () => {
    const matrix = defineTaxMatrix('scheme-v2', [], { categories: [], levies: [] });

    expect(matrix).toEqual({ ok: false, error: { code: 'TAX_MATRIX_INCOMPLETE', missing: [], cell: null } });
  });
});

describe('tax scheme version window (ADR-0020, ADR-0039)', () => {
  it('keeps a window that starts on or after the day of approval', () => {
    expect(taxActivationWindow({ validFrom: '2026-12-01', validTo: null }, '2026-11-14')).toEqual({ ok: true, value: { validFrom: '2026-12-01', validTo: null } });
    expect(taxActivationWindow({ validFrom: '2026-11-14', validTo: null }, '2026-11-14')).toEqual({ ok: true, value: { validFrom: '2026-11-14', validTo: null } });
  });

  it('starts a late-approved version on the day of approval, so tax already charged keeps its scheme', () => {
    expect(taxActivationWindow({ validFrom: '2026-11-01', validTo: '2027-01-01' }, '2026-11-14')).toEqual({
      ok: true,
      value: { validFrom: '2026-11-14', validTo: '2027-01-01' },
    });
  });

  it('refuses to activate a version whose whole window ended before the day of approval', () => {
    expect(taxActivationWindow({ validFrom: '2026-10-01', validTo: '2026-11-14' }, '2026-11-14')).toEqual({ ok: false, error: 'WINDOW_PASSED' });
  });
});

describe('tax scheme activation and the version in force (ADR-0020)', () => {
  const V1 = { id: 'v1', validFrom: '2026-01-01', validTo: null };

  it('ends an open-ended earlier version the day the new one starts', () => {
    expect(planTaxActivation({ validFrom: '2026-12-01', validTo: null }, [V1])).toEqual([{ id: 'v1', action: 'END', validTo: '2026-12-01' }]);
  });

  it('supersedes an active version that starts on or after the new one', () => {
    const later = { id: 'v3', validFrom: '2027-01-01', validTo: null };

    expect(planTaxActivation({ validFrom: '2026-12-01', validTo: null }, [later])).toEqual([{ id: 'v3', action: 'SUPERSEDE' }]);
  });

  it('leaves alone versions that do not overlap the new window', () => {
    const before = { id: 'v0', validFrom: '2025-01-01', validTo: '2026-01-01' };
    const after = { id: 'v4', validFrom: '2027-06-01', validTo: null };

    expect(planTaxActivation({ validFrom: '2026-01-01', validTo: '2027-06-01' }, [before, after])).toEqual([]);
  });

  it('finds the one version whose window holds the tax date, start inclusive and end exclusive', () => {
    const versions = [
      { id: 'v1', validFrom: '2026-01-01', validTo: '2026-12-01' },
      { id: 'v2', validFrom: '2026-12-01', validTo: null },
    ];

    expect(taxSchemeInForce(versions, '2026-11-30')).toBe('v1');
    expect(taxSchemeInForce(versions, '2026-12-01')).toBe('v2');
    expect(taxSchemeInForce(versions, '2030-01-01')).toBe('v2');
    expect(taxSchemeInForce(versions, '2025-12-31')).toBeNull();
  });
});
