import { Money, Rate } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { Settings } from '../../../platform/settings/settings';
import type { Authoriser } from '../../iam';
import { categoryTaxRule, sumTaxedLines, taxExclusive, taxInclusive, type CategoryTaxRule, type TaxBreakdown, type TaxTotals } from '../domain/tax/tax-calculator';
import { taxSchemeInForce } from '../domain/tax/tax-scheme';
import { referencesNotFound, TaxSchemeNotInForceError } from './errors';
import { percentText } from './tax-admin';
import type { TaxCellRow, TaxStore } from './tax-store';

/** Whether the business charges levies at all (ADR-0020). An absent setting means it does: the seeded farm is registered. */
export const TAX_REGISTERED_SETTING = 'tax.registered';
const REGISTERED_BY_DEFAULT = true;

export interface TaxLineRequest {
  readonly lineRef: string;
  readonly taxCategoryId: string;
  /** The line anchor: net if tax-exclusive, gross if tax-inclusive. */
  readonly amountPesewas: bigint;
}

export interface TaxRequest {
  readonly taxInclusive: boolean;
  /** Business date, Africa/Accra, `YYYY-MM-DD`. */
  readonly taxDate: string;
  readonly lines: readonly TaxLineRequest[];
}

/** What a selling or purchasing module stores: the version used and, per line, every levy row (ADR-0020). */
export interface TaxCalculation {
  readonly versionId: string;
  readonly lines: readonly (TaxBreakdown & { readonly lineRef: string })[];
  readonly totals: TaxTotals;
}

/** The contract's `TaxCalculationResult`. */
export interface TaxCalculationResultView {
  readonly taxSchemeVersionId: string;
  readonly taxInclusive: boolean;
  readonly lines: readonly {
    readonly lineRef: string;
    readonly netPesewas: number;
    readonly taxPesewas: number;
    readonly grossPesewas: number;
    readonly levies: readonly {
      readonly levyCode: string;
      readonly levyName: string;
      readonly treatment: string;
      readonly ratePercent: string;
      readonly basePesewas: number;
      readonly amountPesewas: number;
    }[];
  }[];
  readonly netPesewas: number;
  readonly taxPesewas: number;
  readonly grossPesewas: number;
  readonly currency: 'GHS';
}

function ruleFor(versionId: string, categoryId: string, cells: readonly TaxCellRow[]): CategoryTaxRule {
  const rule = categoryTaxRule({
    versionId,
    categoryId,
    cells: cells
      .filter((cell) => cell.category.id === categoryId)
      .map((cell) => ({
        levy: cell.levy,
        treatment: cell.treatment,
        rate: Rate.parsePercent(cell.ratePercent),
        baseKind: cell.baseKind,
        baseLevyIds: cell.baseLevies.map((levy) => levy.id),
        isReclaimable: cell.isReclaimable,
        calcOrder: cell.calcOrder,
      })),
  });
  if (!rule.ok) {
    // An ACTIVE version passed the same rules when it was submitted and is frozen since; this is a broken invariant.
    throw new Error(`tax scheme version ${versionId} holds an invalid rule for category ${categoryId}: ${rule.error.code}`);
  }
  return rule.value;
}

/**
 * Tax calculation (FR-MDM-013, FR-MDM-014): finds the ACTIVE scheme version for the tax date, builds each line's
 * category rule from its cells and runs the pure calculator. Quotes, carts, orders, billing and purchasing call
 * `calculateIn` inside their own transaction; `calculate` is the read-only `calculateTax` operation.
 */
export class TaxService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: TaxStore,
    private readonly authoriser: Authoriser,
    private readonly settings: Settings,
  ) {}

  async calculate(actor: Actor | undefined, request: TaxRequest): Promise<TaxCalculationResultView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'mdm.tax.calculate');
      return toView(request.taxInclusive, await this.calculateIn(tx, request));
    });
  }

  async calculateIn(tx: Transaction, request: TaxRequest): Promise<TaxCalculation> {
    const known = await this.store.existingCategoryIds(tx, [...new Set(request.lines.map((line) => line.taxCategoryId))]);
    const unknown = request.lines.flatMap((line, index) => (known.has(line.taxCategoryId) ? [] : [`/lines/${index}/taxCategoryId`]));
    if (unknown.length > 0) {
      throw referencesNotFound(unknown);
    }
    const versionId = taxSchemeInForce(await this.store.activeWindows(tx, false), request.taxDate);
    if (versionId === null) {
      throw new TaxSchemeNotInForceError(request.taxDate);
    }
    const cells = await this.store.cells(tx, versionId);
    // Registration as at the start of the tax date; Africa/Accra keeps UTC all year, so that is midnight UTC.
    const registered = await this.settings.booleanAt(TAX_REGISTERED_SETTING, REGISTERED_BY_DEFAULT, new Date(`${request.taxDate}T00:00:00Z`));
    const rules = new Map<string, CategoryTaxRule>();
    const lines = request.lines.map((line) => {
      const rule = rules.get(line.taxCategoryId) ?? ruleFor(versionId, line.taxCategoryId, cells);
      rules.set(line.taxCategoryId, rule);
      const anchor = Money.ofPesewas(line.amountPesewas);
      if (!request.taxInclusive) {
        return { ...taxExclusive(anchor, rule, registered), lineRef: line.lineRef };
      }
      const split = taxInclusive(anchor, rule, registered);
      if (!split.ok) {
        // The net always carries a positive weight, so allocate cannot refuse; this is a broken invariant.
        throw new Error(`allocation refused for line ${line.lineRef}: ${split.error.code}`);
      }
      return { ...split.value, lineRef: line.lineRef };
    });
    return { versionId, lines, totals: sumTaxedLines(lines) };
  }
}

function toView(taxInclusive: boolean, calculation: TaxCalculation): TaxCalculationResultView {
  return {
    taxSchemeVersionId: calculation.versionId,
    taxInclusive,
    lines: calculation.lines.map((line) => ({
      lineRef: line.lineRef,
      netPesewas: line.net.toJsonInteger(),
      taxPesewas: line.tax.toJsonInteger(),
      grossPesewas: line.gross.toJsonInteger(),
      levies: line.levies.map((levy) => ({
        levyCode: levy.levyCode,
        levyName: levy.levyName,
        treatment: levy.treatment,
        // The rate actually applied: nothing is charged while the business is not registered.
        ratePercent: percentText(line.registered ? levy.rate.toPercentString() : '0'),
        basePesewas: levy.base.toJsonInteger(),
        amountPesewas: levy.amount.toJsonInteger(),
      })),
    })),
    netPesewas: calculation.totals.net.toJsonInteger(),
    taxPesewas: calculation.totals.tax.toJsonInteger(),
    grossPesewas: calculation.totals.gross.toJsonInteger(),
    currency: 'GHS',
  };
}
