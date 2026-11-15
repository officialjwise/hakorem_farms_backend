import { allocate, mapResult, Money, err, ok, type AllocationError, type Rate, type Result } from '@hakorem/kernel';

/**
 * The tax calculator (ADR-0020; FR-MDM-013, FR-MDM-014). Pure, and the only place levy arithmetic lives: quotes,
 * carts, orders, billing and purchasing all call it. The application layer loads the cells of the scheme version in
 * force for the line's category and tax date, builds a `CategoryTaxRule` from them, and passes it in.
 *
 * - Tax-exclusive: the anchor is the line net. In calculation order, each levy is `half_up(base x rate)` on an
 *   integer base, the base being the net plus the amounts of the levies it names. Gross is net plus the amounts.
 * - Tax-inclusive: the anchor is the line gross. Each levy's effective rate on the net is
 *   `e_i = r_i x (1 + sum of e_j over its base levies)`, exact. The gross is split by `allocate` with weights
 *   `1 : e_1 : ... : e_n`, so the parts sum to the gross exactly; a tied leftover pesewa goes to the net first, then to
 *   the levies in calculation order.
 * - Every levy gets a row, zero or not, so a document can say a line is zero-rated or exempt.
 */

export const TAX_TREATMENTS = ['STANDARD', 'ZERO_RATED', 'EXEMPT', 'OUT_OF_SCOPE'] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];
export const TAX_BASE_KINDS = ['NET', 'NET_PLUS_LEVIES'] as const;
export type TaxBaseKind = (typeof TAX_BASE_KINDS)[number];
/** The treatment of a whole category: its cells' one treatment, or MIXED when they differ. */
export type CategoryTreatment = TaxTreatment | 'MIXED';

export interface TaxLevyRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** One cell of the matrix for one category, as stored in `mdm.tax_category_levy`. */
export interface TaxCellInput {
  readonly levy: TaxLevyRef;
  readonly treatment: TaxTreatment;
  readonly rate: Rate;
  readonly baseKind: TaxBaseKind;
  /** For NET_PLUS_LEVIES: the levies of the same category whose amounts are added to this levy's base. */
  readonly baseLevyIds: readonly string[];
  readonly isReclaimable: boolean;
  readonly calcOrder: number;
}

export type TaxRuleErrorCode =
  | 'TAX_MATRIX_INCOMPLETE'
  | 'TAX_CALC_ORDER_INVALID'
  | 'TAX_CALC_ORDER_DUPLICATE'
  | 'TAX_LEVY_DUPLICATE'
  | 'TAX_RATE_NOT_ALLOWED'
  | 'TAX_BASE_INVALID'
  | 'TAX_BASE_CIRCULAR';

export interface TaxRuleError {
  readonly code: TaxRuleErrorCode;
  /** The levy whose cell is wrong; null when the category has no cells at all. */
  readonly levyCode: string | null;
}

/** The validated cells of one category in one scheme version, in calculation order. Built only by `categoryTaxRule`. */
export interface CategoryTaxRule {
  readonly versionId: string;
  readonly categoryId: string;
  readonly cells: readonly TaxCellInput[];
  readonly treatment: CategoryTreatment;
}

export interface LevyLine {
  readonly levyId: string;
  readonly levyCode: string;
  readonly levyName: string;
  readonly treatment: TaxTreatment;
  readonly rate: Rate;
  readonly baseKind: TaxBaseKind;
  readonly isReclaimable: boolean;
  readonly calcOrder: number;
  readonly base: Money;
  readonly amount: Money;
}

export interface TaxBreakdown {
  readonly versionId: string;
  readonly categoryId: string;
  readonly pricing: 'EXCLUSIVE' | 'INCLUSIVE';
  /** False when `tax.registered` is off on the tax date: every levy is zero and nothing is reclaimable. */
  readonly registered: boolean;
  readonly categoryTreatment: CategoryTreatment;
  readonly net: Money;
  readonly tax: Money;
  readonly gross: Money;
  readonly levies: readonly LevyLine[];
}

export interface TaxTotals {
  readonly net: Money;
  readonly tax: Money;
  readonly gross: Money;
}

function refuse(code: TaxRuleErrorCode, levyCode: string | null): Result<never, TaxRuleError> {
  return err({ code, levyCode });
}

/** Calculation orders are unique by the time cells are sorted, so no two cells compare equal. */
function byCalcOrder(a: TaxCellInput, b: TaxCellInput): -1 | 1 {
  return a.calcOrder < b.calcOrder ? -1 : 1;
}

/** The first refusal for a single cell, judged on its own. */
function cellOwnError(cell: TaxCellInput): TaxRuleErrorCode | null {
  if (!Number.isInteger(cell.calcOrder) || cell.calcOrder < 1) {
    return 'TAX_CALC_ORDER_INVALID';
  }
  if (cell.treatment !== 'STANDARD' && !cell.rate.isZero()) {
    return 'TAX_RATE_NOT_ALLOWED';
  }
  if ((cell.baseKind === 'NET') !== (cell.baseLevyIds.length === 0)) {
    return 'TAX_BASE_INVALID';
  }
  return null;
}

/** The first refusal for a cell's base levies, judged against the other cells of its category. */
function baseError(cell: TaxCellInput, calcOrderByLevyId: ReadonlyMap<string, number>): TaxRuleErrorCode | null {
  for (const levyId of cell.baseLevyIds) {
    const componentOrder = calcOrderByLevyId.get(levyId);
    if (componentOrder === undefined) {
      return 'TAX_BASE_INVALID';
    }
    if (componentOrder >= cell.calcOrder) {
      return 'TAX_BASE_CIRCULAR';
    }
  }
  return null;
}

function categoryTreatmentOf(cells: readonly TaxCellInput[]): CategoryTreatment {
  const first = cells[0]!.treatment;
  return cells.every((cell) => cell.treatment === first) ? first : 'MIXED';
}

/**
 * Validates the cells of one category and puts them in calculation order. A cell is refused for a rate on a
 * non-standard treatment, a base that does not match its kind, a base levy outside the category, a base levy
 * calculated at or after it (which is what makes a circular definition impossible), or a calculation order that is
 * not a unique whole number from one. A category with no cells is incomplete: a missing cell never means zero.
 */
export function categoryTaxRule(input: {
  readonly versionId: string;
  readonly categoryId: string;
  readonly cells: readonly TaxCellInput[];
}): Result<CategoryTaxRule, TaxRuleError> {
  if (input.cells.length === 0) {
    return refuse('TAX_MATRIX_INCOMPLETE', null);
  }
  const calcOrderByLevyId = new Map<string, number>();
  const calcOrders = new Set<number>();
  for (const cell of input.cells) {
    const ownError = cellOwnError(cell);
    if (ownError !== null) {
      return refuse(ownError, cell.levy.code);
    }
    if (calcOrderByLevyId.has(cell.levy.id)) {
      return refuse('TAX_LEVY_DUPLICATE', cell.levy.code);
    }
    if (calcOrders.has(cell.calcOrder)) {
      return refuse('TAX_CALC_ORDER_DUPLICATE', cell.levy.code);
    }
    calcOrderByLevyId.set(cell.levy.id, cell.calcOrder);
    calcOrders.add(cell.calcOrder);
  }
  const ordered = [...input.cells].sort(byCalcOrder);
  for (const cell of ordered) {
    const error = baseError(cell, calcOrderByLevyId);
    if (error !== null) {
      return refuse(error, cell.levy.code);
    }
  }
  return ok({ versionId: input.versionId, categoryId: input.categoryId, cells: ordered, treatment: categoryTreatmentOf(ordered) });
}

function baseOf(net: Money, cell: TaxCellInput, amountByLevyId: ReadonlyMap<string, Money>): Money {
  return Money.sum([net, ...cell.baseLevyIds.map((levyId) => amountByLevyId.get(levyId)!)]);
}

function breakdown(
  rule: CategoryTaxRule,
  pricing: TaxBreakdown['pricing'],
  registered: boolean,
  net: Money,
  amountOf: (cell: TaxCellInput, base: Money) => Money,
): TaxBreakdown {
  const amountByLevyId = new Map<string, Money>();
  const levies = rule.cells.map((cell): LevyLine => {
    const base = baseOf(net, cell, amountByLevyId);
    const amount = amountOf(cell, base);
    amountByLevyId.set(cell.levy.id, amount);
    return {
      levyId: cell.levy.id,
      levyCode: cell.levy.code,
      levyName: cell.levy.name,
      treatment: cell.treatment,
      rate: cell.rate,
      baseKind: cell.baseKind,
      isReclaimable: cell.isReclaimable,
      calcOrder: cell.calcOrder,
      base,
      amount,
    };
  });
  const tax = Money.sum(levies.map((line) => line.amount));
  return {
    versionId: rule.versionId,
    categoryId: rule.categoryId,
    pricing,
    registered,
    categoryTreatment: rule.treatment,
    net,
    tax,
    gross: net.plus(tax),
    levies,
  };
}

/**
 * A tax-exclusive line: the anchor is the net. Each levy is rounded half-up once on its own integer base. A gross
 * beyond the largest amount throws the kernel's range error rather than losing a pesewa.
 */
export function taxExclusive(net: Money, rule: CategoryTaxRule, registered: boolean): TaxBreakdown {
  return breakdown(rule, 'EXCLUSIVE', registered, net, (cell, base) => (registered ? base.timesRate(cell.rate) : Money.zero()));
}

/** An exact non-negative fraction of bigints, reduced. Only for effective rates, never for an amount. */
interface Fraction {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? a : gcd(b, a % b);
}

function fraction(numerator: bigint, denominator: bigint): Fraction {
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function addFractions(a: Fraction, b: Fraction): Fraction {
  return fraction(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
}

/** `e_i = r_i x (1 + sum of e_j over its base levies)`, in calculation order; zero for every levy when unregistered. */
function effectiveRates(rule: CategoryTaxRule, registered: boolean): Fraction[] {
  const rateByLevyId = new Map<string, Fraction>();
  return rule.cells.map((cell) => {
    const rate = registered ? fraction(cell.rate.numerator, cell.rate.denominator) : fraction(0n, 1n);
    const onePlusBase = cell.baseLevyIds.reduce((sum, levyId) => addFractions(sum, rateByLevyId.get(levyId)!), fraction(1n, 1n));
    const effective = fraction(rate.numerator * onePlusBase.numerator, rate.denominator * onePlusBase.denominator);
    rateByLevyId.set(cell.levy.id, effective);
    return effective;
  });
}

function lcm(a: bigint, b: bigint): bigint {
  return (a / gcd(a, b)) * b;
}

/** The net's allocation key. Levies use their calculation order, which starts at one, so the net wins a tie. */
const NET_KEY = 0n;

/**
 * A tax-inclusive price: the anchor is the gross, split by `allocate` over the net and the effective rates so that
 * the parts sum to it exactly. Each levy's reported base is the net plus its base levies' allocated amounts.
 */
export function taxInclusive(gross: Money, rule: CategoryTaxRule, registered: boolean): Result<TaxBreakdown, AllocationError> {
  const rates = effectiveRates(rule, registered);
  const commonDenominator = rates.reduce((acc, rate) => lcm(acc, rate.denominator), 1n);
  const shares = [
    { key: NET_KEY, weight: commonDenominator },
    ...rule.cells.map((cell, index) => ({
      key: BigInt(cell.calcOrder),
      weight: rates[index]!.numerator * (commonDenominator / rates[index]!.denominator),
    })),
  ];
  return mapResult(allocate(gross, shares), ([net, ...levyAmounts]) => {
    const amountByLevyId = new Map(rule.cells.map((cell, index) => [cell.levy.id, levyAmounts[index]!]));
    return breakdown(rule, 'INCLUSIVE', registered, net!, (cell) => amountByLevyId.get(cell.levy.id)!);
  });
}

/** Document totals: sums of the line integers, never a levy recomputed on a total. */
export function sumTaxedLines(lines: readonly TaxBreakdown[]): TaxTotals {
  return {
    net: Money.sum(lines.map((line) => line.net)),
    tax: Money.sum(lines.map((line) => line.tax)),
    gross: Money.sum(lines.map((line) => line.gross)),
  };
}
