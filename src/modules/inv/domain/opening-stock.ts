import { Quantity } from '@hakorem/kernel';

/**
 * The `OPENING_STOCK` spreadsheet (A-128, A-147, ADR-0050): one row per stock line, per lot or per animal, at a
 * physical location of a branch, each with its value at cost in integer pesewas. A row's cells are read here; whether
 * its codes exist and its tracking is right is checked against the database by the sheet.
 */
export const OPENING_STOCK_COLUMNS = {
  all: ['branch', 'location', 'sku', 'qty', 'valuePesewas', 'batch', 'expiresOn', 'tag', 'sex', 'weightKg'],
  required: ['branch', 'location', 'sku', 'qty', 'valuePesewas'],
} as const;

export type OpeningSex = 'MALE' | 'FEMALE' | 'UNKNOWN';

export interface OpeningRow {
  readonly rowNo: number;
  readonly branch: string;
  readonly location: string;
  readonly sku: string;
  readonly qty: Quantity | null;
  readonly valuePesewas: bigint | null;
  readonly batch: string | null;
  readonly expiresOn: string | null;
  readonly tag: string | null;
  readonly sex: OpeningSex | null;
  readonly weightKg: string | null;
}

export interface OpeningRowError {
  readonly rowNo: number;
  readonly column: string | null;
  readonly message: string;
}

/** The largest amount of pesewas a JSON number carries exactly (FR-INV-024). */
const MAX_PESEWAS = 9_007_199_254_740_991n;
const QTY = /^\d{1,11}(\.\d{1,3})?$/;
const PESEWAS = /^\d{1,16}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KG = /^\d{1,7}(\.\d{1,3})?$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9/_-]{0,39}$/;
const SEXES: readonly OpeningSex[] = ['MALE', 'FEMALE', 'UNKNOWN'];

function isCalendarDate(text: string): boolean {
  return DATE.test(text) && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;
}

/** Reads one record's cells; a blank optional cell is null. Every problem is a row error naming its column. */
export function readOpeningRow(rowNo: number, cells: ReadonlyMap<string, string>): { readonly row: OpeningRow; readonly errors: OpeningRowError[] } {
  const errors: OpeningRowError[] = [];
  const fail = (column: string, message: string) => errors.push({ rowNo, column, message });
  const cell = (column: string): string | null => {
    const value = cells.get(column)?.trim() ?? '';
    return value === '' ? null : value;
  };
  for (const column of OPENING_STOCK_COLUMNS.required) if (cell(column) === null) fail(column, `${column} is required`);

  const qtyText = cell('qty');
  let qty: Quantity | null = null;
  if (qtyText !== null) {
    if (!QTY.test(qtyText)) fail('qty', 'qty must be a number with at most three decimal places');
    else if (Quantity.parse(qtyText).isZero()) fail('qty', 'qty must be above zero');
    else qty = Quantity.parse(qtyText);
  }
  const valueText = cell('valuePesewas');
  let valuePesewas: bigint | null = null;
  if (valueText !== null) {
    if (!PESEWAS.test(valueText) || BigInt(valueText) > MAX_PESEWAS) fail('valuePesewas', 'valuePesewas must be a whole number of pesewas (85000 is GHS 850.00)');
    else if (BigInt(valueText) === 0n) fail('valuePesewas', 'Opening stock is carried at its cost: valuePesewas must be above zero');
    else valuePesewas = BigInt(valueText);
  }
  const expiresOn = cell('expiresOn');
  if (expiresOn !== null && !isCalendarDate(expiresOn)) fail('expiresOn', 'expiresOn must be a date written YYYY-MM-DD');
  const sexText = cell('sex')?.toUpperCase() ?? null;
  if (sexText !== null && !SEXES.includes(sexText as OpeningSex)) fail('sex', 'sex must be MALE, FEMALE or UNKNOWN');
  const weightKg = cell('weightKg');
  if (weightKg !== null && !KG.test(weightKg)) fail('weightKg', 'weightKg must be kilograms with at most three decimal places');
  const batch = cell('batch');
  if (batch !== null && !IDENTIFIER.test(batch)) fail('batch', 'batch must be letters, digits, / _ or -, at most 40 characters');
  const tag = cell('tag');
  if (tag !== null && !IDENTIFIER.test(tag)) fail('tag', 'tag must be letters, digits, / _ or -, at most 40 characters');

  return {
    row: {
      rowNo,
      branch: cell('branch') ?? '',
      location: cell('location') ?? '',
      sku: cell('sku') ?? '',
      qty,
      valuePesewas,
      batch,
      expiresOn,
      tag,
      sex: sexText as OpeningSex | null,
      weightKg,
    },
    errors,
  };
}

/** A receipt rule broken by a row, in the words its row error shows. */
export const OPENING_RULE_MESSAGES: Readonly<Record<string, string>> = {
  PRODUCT_NOT_ACTIVE: 'The product is archived or inactive',
  PRODUCT_NOT_STOCKED: 'The product is not a stock product',
  VALUE_REQUIRED: 'Opening stock is carried at its cost: valuePesewas must be above zero',
  WHOLE_ANIMALS_ONLY: 'An animal is one row with qty 1',
  ONE_ANIMAL_PER_HEAD: 'An animal is one row with its tag and qty 1',
  NOT_FOR_SERIAL_PRODUCT: 'An animal has a tag, not a batch or an expiry date',
  NOT_FOR_THIS_PRODUCT: 'Only an animal has a tag',
  PRODUCT_NOT_TRACKED: 'This product is not tracked by lot: leave batch and expiresOn blank',
  BATCH_REQUIRED: 'A lot needs its batch number',
  EXPIRY_REQUIRED: 'This product has a shelf life: expiresOn is required',
  EXPIRED_ON_ARRIVAL: 'The lot has already expired',
};
