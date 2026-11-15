import { err, ok, type Result } from '@hakorem/kernel';
import { categoryTaxRule, type CategoryTaxRule, type TaxCellInput, type TaxLevyRef, type TaxRuleErrorCode } from './tax-calculator';

/**
 * Tax scheme versions (FR-MDM-012, ADR-0020, ADR-0039). Pure rules; the database repeats the ones it can. Tax dates
 * are business dates in Africa/Accra written `YYYY-MM-DD`, which compare correctly as strings. A window is half-open:
 * `validFrom` is its first day and `validTo`, when set, the first day it no longer applies.
 */

export interface MatrixCellInput extends TaxCellInput {
  readonly categoryId: string;
}

export interface MatrixReferences {
  /** The live tax categories and levies: a version must hold a cell for every pair. */
  readonly categories: readonly { readonly id: string; readonly code: string }[];
  readonly levies: readonly TaxLevyRef[];
}

export interface TaxMatrixError {
  readonly code: TaxRuleErrorCode | 'TAX_CELL_UNKNOWN_REFERENCE';
  /** For TAX_MATRIX_INCOMPLETE: every category and levy pair without a cell. */
  readonly missing: readonly { readonly categoryCode: string; readonly levyCode: string }[];
  /** For a refusal of one cell: which. */
  readonly cell: { readonly categoryId: string; readonly levyCode: string | null } | null;
}

function matrixError(code: TaxMatrixError['code'], fields: Partial<Pick<TaxMatrixError, 'missing' | 'cell'>>): Result<never, TaxMatrixError> {
  return err({ code, missing: fields.missing ?? [], cell: fields.cell ?? null });
}

/**
 * Validates a whole matrix: every cell names a live category and levy, each category's cells form a valid rule, and
 * there is a cell for every live category and levy. Missing never means zero; a levy that does not apply has a cell
 * at rate zero with its treatment. An empty matrix is incomplete even with nothing to cover.
 */
export function defineTaxMatrix(versionId: string, cells: readonly MatrixCellInput[], refs: MatrixReferences): Result<CategoryTaxRule[], TaxMatrixError> {
  const categoryIds = new Set(refs.categories.map((category) => category.id));
  const levyIds = new Set(refs.levies.map((levy) => levy.id));
  const unknown = cells.find((cell) => !categoryIds.has(cell.categoryId) || !levyIds.has(cell.levy.id));
  if (unknown !== undefined) {
    return matrixError('TAX_CELL_UNKNOWN_REFERENCE', { cell: { categoryId: unknown.categoryId, levyCode: unknown.levy.code } });
  }
  const present = new Set(cells.map((cell) => `${cell.categoryId}|${cell.levy.id}`));
  const missing = refs.categories.flatMap((category) =>
    refs.levies.filter((levy) => !present.has(`${category.id}|${levy.id}`)).map((levy) => ({ categoryCode: category.code, levyCode: levy.code })),
  );
  if (missing.length > 0 || cells.length === 0) {
    return matrixError('TAX_MATRIX_INCOMPLETE', { missing });
  }
  const rules: CategoryTaxRule[] = [];
  for (const category of refs.categories) {
    const rule = categoryTaxRule({ versionId, categoryId: category.id, cells: cells.filter((cell) => cell.categoryId === category.id) });
    if (!rule.ok) {
      return matrixError(rule.error.code, { cell: { categoryId: category.id, levyCode: rule.error.levyCode } });
    }
    rules.push(rule.value);
  }
  return ok(rules);
}

export interface TaxWindow {
  readonly validFrom: string;
  readonly validTo: string | null;
}

/**
 * The window a version is activated with: from its first day, or from the day of approval if that is later, so a
 * late approval never changes the scheme tax was already charged under. A version whose whole window ended by the
 * day of approval cannot be activated; the accountant drafts a new one (ADR-0039, as ADR-0036 does for prices).
 */
export function taxActivationWindow(window: TaxWindow, today: string): Result<TaxWindow, 'WINDOW_PASSED'> {
  if (window.validTo !== null && window.validTo <= today) {
    return err('WINDOW_PASSED');
  }
  return ok(window.validFrom >= today ? window : { validFrom: today, validTo: window.validTo });
}

export interface ActiveTaxWindow extends TaxWindow {
  readonly id: string;
}

export type TaxActivationStep = { readonly id: string; readonly action: 'END'; readonly validTo: string } | { readonly id: string; readonly action: 'SUPERSEDE' };

/** Later than any business date, for an open-ended window. */
const OPEN_END = '9999-12-31';

/**
 * What activating a version does to the active versions it overlaps: one that started earlier is ended the day the
 * new one starts; one that starts on or after it is superseded. The database exclusion constraint is the backstop.
 */
export function planTaxActivation(next: TaxWindow, actives: readonly ActiveTaxWindow[]): TaxActivationStep[] {
  const nextTo = next.validTo ?? OPEN_END;
  return actives
    .filter((active) => active.validFrom < nextTo && (active.validTo ?? OPEN_END) > next.validFrom)
    .map((active) => (active.validFrom < next.validFrom ? { id: active.id, action: 'END', validTo: next.validFrom } : { id: active.id, action: 'SUPERSEDE' }));
}

/** The active version whose window holds the tax date, or null. Active windows never overlap, so there is one at most. */
export function taxSchemeInForce(actives: readonly ActiveTaxWindow[], taxDate: string): string | null {
  return actives.find((active) => active.validFrom <= taxDate && (active.validTo ?? OPEN_END) > taxDate)?.id ?? null;
}
