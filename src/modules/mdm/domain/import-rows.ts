import { Money, Quantity } from '@hakorem/kernel';
import { VIRTUAL_KINDS, type LocationKind, type TempClass } from './locations';
import { normaliseGhanaPhone } from './parties';
import type { OnlineMode, StockPolicy } from './product';
import { PRICE_BASES, type PriceBasis } from './pricing/pricing-engine';
import type { RowError, SheetColumns } from './imports';
import { readPublicId } from './public-id';

/**
 * How each remaining master data sheet reads one row (FR-MDM-019, A-130): the form of every cell, checked without
 * the database. A blank cell is "not stated": on a row that creates a record it takes the default or is refused if
 * required; on a row that changes one it changes nothing. A message names the column and the rule, never a value
 * that could be personal (a phone, an email, an address).
 */

type Cells = ReadonlyMap<string, string>;
type Reading<R> = { readonly row: R; readonly errors: readonly RowError[] };

const blank = (value: string | undefined): string | null => (value === undefined || value === '' ? null : value);

function collector(rowNo: number) {
  const errors: RowError[] = [];
  return { errors, fail: (column: string, message: string) => errors.push({ rowNo, column, message }) };
}

/** A cell that must be one of a fixed list, matched without regard to case. */
function oneOf<T extends string>(cells: Cells, column: string, allowed: readonly T[], fail: (column: string, message: string) => void): T | null {
  const text = blank(cells.get(column))?.toUpperCase() ?? null;
  if (text === null) return null;
  const found = allowed.find((candidate) => candidate === text);
  if (found === undefined) fail(column, `${column} must be one of ${allowed.join(', ')}`);
  return found ?? null;
}

/** A code cell, upper-cased, checked against its pattern. */
function code(cells: Cells, column: string, pattern: RegExp, example: string, fail: (column: string, message: string) => void): string | null {
  const text = blank(cells.get(column))?.toUpperCase() ?? null;
  if (text !== null && !pattern.test(text)) {
    fail(column, `${column} must be a code such as ${example}`);
    return null;
  }
  return text;
}

function text(cells: Cells, column: string, max: number, fail: (column: string, message: string) => void): string | null {
  const value = blank(cells.get(column));
  if (value !== null && value.length > max) {
    fail(column, `${column} is longer than ${max} characters`);
    return null;
  }
  return value;
}

/** A whole number from `min` to `max`, written without a sign, a decimal point or a thousands separator. */
function wholeNumber(cells: Cells, column: string, min: number, max: number, fail: (column: string, message: string) => void): number | null {
  const value = blank(cells.get(column));
  if (value === null) return null;
  if (!/^[0-9]{1,7}$/.test(value) || Number(value) < min || Number(value) > max) {
    fail(column, `${column} must be a whole number from ${min} to ${max}`);
    return null;
  }
  return Number(value);
}

function yesNo(cells: Cells, column: string, fail: (column: string, message: string) => void): boolean | null {
  const value = blank(cells.get(column))?.toUpperCase() ?? null;
  if (value === null) return null;
  if (['TRUE', 'YES', 'Y', '1'].includes(value)) return true;
  if (['FALSE', 'NO', 'N', '0'].includes(value)) return false;
  fail(column, `${column} must be TRUE or FALSE`);
  return null;
}

const UOM = /^[A-Z]{2,10}$/;
const CATALOGUE_CODE = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;
const TAX_CATEGORY_CODE = /^[A-Z][A-Z_]{2,39}$/;
const SPECIES_CODE = /^[A-Z][A-Z0-9_]{1,19}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Products (FR-MDM-001, FR-MDM-003, FR-MDM-004).

/**
 * The product sheet's columns. The `sku` column is always there, as an export writes it: a SKU names a product the
 * catalogue holds, and a blank one creates a product, whose SKU the server generates (B09q, ADR-0072). There is no
 * barcode column from contract 2.0.0: a file that has one is refused as having an unknown column, never imported with
 * the barcode ignored.
 */
export const PRODUCT_COLUMNS: SheetColumns = {
  all: ['sku', 'name', 'category', 'stockPolicy', 'species', 'baseUom', 'saleUom', 'taxCategory', 'nominalPackKg', 'shelfLifeDays', 'description', 'onlineMode'],
  required: ['sku'],
};

const SKU = /^[A-Z0-9][A-Z0-9-]{1,39}$/;
const STOCK_POLICIES: readonly StockPolicy[] = ['SERIALISED', 'CATCH_WEIGHT', 'COUNTABLE', 'NON_STOCK'];
const ONLINE_MODES: readonly OnlineMode[] = ['HIDDEN', 'LISTED', 'REQUEST_TO_BUY'];
const KILOGRAMS = /^(0|[1-9][0-9]{0,6})(\.[0-9]{1,3})?$/;

/** A product row: a SKU names a product the catalogue holds; a row without one creates a product. */
export interface ProductRow {
  readonly rowNo: number;
  readonly sku: string | null;
  readonly name: string | null;
  readonly categoryCode: string | null;
  readonly stockPolicy: StockPolicy | null;
  readonly speciesCode: string | null;
  readonly baseUom: string | null;
  readonly saleUom: string | null;
  readonly taxCategoryCode: string | null;
  /** Kilograms with exactly three places ("15.000"), as the contract's `Kilograms`. */
  readonly nominalPackKg: string | null;
  readonly shelfLifeDays: number | null;
  readonly description: string | null;
  readonly onlineMode: OnlineMode | null;
}

/** Kilograms typed with up to three places, written with exactly three ("15" is "15.000"); never through a float. */
function kilograms(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  return `${whole!}.${fraction.padEnd(3, '0')}`;
}

export function readProductRow(rowNo: number, cells: Cells): Reading<ProductRow> {
  const { errors, fail } = collector(rowNo);
  const sku = blank(cells.get('sku'))?.toUpperCase() ?? null;
  if (sku !== null && !SKU.test(sku)) fail('sku', 'SKU must be a SKU the catalogue holds, such as EGG-0001, or blank to create a product');
  const name = text(cells, 'name', 120, fail);
  const packText = blank(cells.get('nominalPackKg'));
  let nominalPackKg: string | null = null;
  if (packText !== null) {
    if (KILOGRAMS.test(packText)) nominalPackKg = kilograms(packText);
    else fail('nominalPackKg', 'nominalPackKg must be kilograms with at most three decimal places, such as 15.000');
  }
  return {
    row: {
      rowNo,
      sku: sku !== null && SKU.test(sku) ? sku : null,
      name,
      categoryCode: code(cells, 'category', CATALOGUE_CODE, 'MEAT', fail),
      stockPolicy: oneOf(cells, 'stockPolicy', STOCK_POLICIES, fail),
      speciesCode: code(cells, 'species', SPECIES_CODE, 'GOAT', fail),
      baseUom: code(cells, 'baseUom', UOM, 'KG', fail),
      saleUom: code(cells, 'saleUom', UOM, 'KG', fail),
      taxCategoryCode: code(cells, 'taxCategory', TAX_CATEGORY_CODE, 'LIVE_ANIMALS', fail),
      nominalPackKg,
      shelfLifeDays: wholeNumber(cells, 'shelfLifeDays', 1, 3_650, fail),
      description: text(cells, 'description', 2_000, fail),
      onlineMode: oneOf(cells, 'onlineMode', ONLINE_MODES, fail),
    },
    errors,
  };
}

/** What a row that creates a product must state; the rest take the catalogue's defaults (online mode HIDDEN). */
export function productCreateErrors(row: ProductRow): RowError[] {
  const missing: RowError[] = [];
  const need = (value: unknown, column: string) => {
    if (value === null) missing.push({ rowNo: row.rowNo, column, message: `${column} is empty: a new product needs it` });
  };
  need(row.name, 'name');
  need(row.categoryCode, 'category');
  need(row.stockPolicy, 'stockPolicy');
  need(row.baseUom, 'baseUom');
  need(row.saleUom, 'saleUom');
  return missing;
}

// Suppliers (FR-MDM-007).

/** `publicId` names the supplier to change (B09q, ADR-0073); the sequential number is not a column from contract 2.0.0. */
export const SUPPLIER_COLUMNS: SheetColumns = { all: ['publicId', 'name', 'contactName', 'phone', 'email', 'address', 'categories'], required: ['name'] };

const MAX_SUPPLIER_CATEGORIES = 50;

/** A supplier row: a blank public ID registers a supplier, a public ID changes that supplier. */
export interface SupplierRow {
  readonly rowNo: number;
  readonly publicId: string | null;
  readonly name: string | null;
  readonly contactName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
  /** Category codes separated by semicolons; null when the cell is blank (no change). */
  readonly categoryCodes: readonly string[] | null;
}

export function readSupplierRow(rowNo: number, cells: Cells): Reading<SupplierRow> {
  const { errors, fail } = collector(rowNo);
  const publicIdText = blank(cells.get('publicId'));
  const publicId = publicIdText === null ? null : readPublicId('SUPPLIER', publicIdText);
  if (publicIdText !== null && publicId === null) fail('publicId', 'Public ID must look like sup_8F3K2M9Q7X4T1V6B');
  const name = text(cells, 'name', 160, fail);
  if (name === null && publicIdText === null && blank(cells.get('name')) === null) fail('name', 'Name is empty');
  let phone: string | null = null;
  const phoneText = blank(cells.get('phone'));
  if (phoneText !== null) {
    const normalised = normaliseGhanaPhone(phoneText);
    if (normalised.ok) phone = normalised.value;
    else fail('phone', 'Phone number must be a Ghanaian number such as 024 412 3456, or start with + and the country code');
  }
  const email = blank(cells.get('email'))?.toLowerCase() ?? null;
  if (email !== null && (email.length > 254 || !EMAIL.test(email))) fail('email', 'Email address is not valid');
  let categoryCodes: string[] | null = null;
  const categoriesText = blank(cells.get('categories'));
  if (categoriesText !== null) {
    categoryCodes = [...new Set(categoriesText.split(';').map((part) => part.trim().toUpperCase()).filter((part) => part !== ''))];
    if (categoryCodes.length > MAX_SUPPLIER_CATEGORIES) fail('categories', `A supplier supplies at most ${MAX_SUPPLIER_CATEGORIES} categories`);
    else if (categoryCodes.some((part) => !CATALOGUE_CODE.test(part))) fail('categories', 'categories must be category codes separated by semicolons, such as MEAT;EGGS');
  }
  return {
    row: {
      rowNo,
      publicId,
      name,
      contactName: text(cells, 'contactName', 160, fail),
      phone,
      email: email !== null && EMAIL.test(email) && email.length <= 254 ? email : null,
      address: text(cells, 'address', 300, fail),
      categoryCodes,
    },
    errors,
  };
}

// Locations (FR-MDM-006).

export const LOCATION_COLUMNS: SheetColumns = {
  all: ['branch', 'code', 'name', 'kind', 'parent', 'isSellable', 'tempClass', 'tempMinC', 'tempMaxC', 'capacityHead'],
  required: ['branch', 'code'],
};

const BRANCH_CODE = /^[A-Z0-9]{2,5}$/;
const LOCATION_CODE = /^[A-Z0-9_-]{2,20}$/;
const CELSIUS = /^-?[0-9]{1,2}(\.[0-9])?$/;
const PHYSICAL_KINDS: readonly LocationKind[] = ['SITE', 'PEN', 'COLD_ROOM', 'STORE', 'SHOP_FLOOR', 'VEHICLE', 'RETURNS_HOLD', 'QUARANTINE', 'IN_TRANSIT'];
const TEMP_CLASSES: readonly TempClass[] = ['AMBIENT', 'CHILLED', 'FROZEN'];

/** A location row: the branch and code name the location; a code not yet in the branch creates one. */
export interface LocationRow {
  readonly rowNo: number;
  readonly branchCode: string | null;
  readonly code: string | null;
  readonly name: string | null;
  readonly kind: LocationKind | null;
  readonly parentCode: string | null;
  readonly isSellable: boolean | null;
  readonly tempClass: TempClass | null;
  /** Celsius with one place ("2.0"), as the contract's `Celsius`. */
  readonly tempMinC: string | null;
  readonly tempMaxC: string | null;
  readonly capacityHead: number | null;
}

function celsius(cells: Cells, column: string, fail: (column: string, message: string) => void): string | null {
  const value = blank(cells.get(column));
  if (value === null) return null;
  if (!CELSIUS.test(value)) {
    fail(column, `${column} must be degrees Celsius with at most one decimal place, such as 4.0`);
    return null;
  }
  return value.includes('.') ? value : `${value}.0`;
}

export function readLocationRow(rowNo: number, cells: Cells): Reading<LocationRow> {
  const { errors, fail } = collector(rowNo);
  const branchCode = code(cells, 'branch', BRANCH_CODE, 'DDW', fail);
  if (blank(cells.get('branch')) === null) fail('branch', 'Branch is empty');
  const locationCode = code(cells, 'code', LOCATION_CODE, 'PEN-03', fail);
  if (blank(cells.get('code')) === null) fail('code', 'Code is empty');
  const kindText = blank(cells.get('kind'))?.toUpperCase() ?? null;
  let kind: LocationKind | null = null;
  if (kindText !== null) {
    if ((VIRTUAL_KINDS as readonly string[]).includes(kindText)) fail('kind', 'A virtual location is created with its branch and cannot be imported');
    else {
      kind = PHYSICAL_KINDS.find((candidate) => candidate === kindText) ?? null;
      if (kind === null) fail('kind', `kind must be one of ${PHYSICAL_KINDS.join(', ')}`);
    }
  }
  return {
    row: {
      rowNo,
      branchCode,
      code: locationCode,
      name: text(cells, 'name', 120, fail),
      kind,
      parentCode: code(cells, 'parent', LOCATION_CODE, 'SITE-01', fail),
      isSellable: yesNo(cells, 'isSellable', fail),
      tempClass: oneOf(cells, 'tempClass', TEMP_CLASSES, fail),
      tempMinC: celsius(cells, 'tempMinC', fail),
      tempMaxC: celsius(cells, 'tempMaxC', fail),
      capacityHead: wholeNumber(cells, 'capacityHead', 1, 100_000, fail),
    },
    errors,
  };
}

// Price list entries (FR-MDM-015, FR-MDM-017).

export const PRICE_ENTRY_COLUMNS: SheetColumns = {
  all: ['priceList', 'sku', 'grade', 'weightBand', 'minQty', 'basis', 'listPricePesewas', 'floorPricePesewas', 'ceilingPricePesewas', 'quoteOnly'],
  required: ['priceList', 'sku', 'basis', 'listPricePesewas', 'floorPricePesewas', 'ceilingPricePesewas'],
};

const PRICE_LIST_CODE = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;
const GRADE_CODE = /^[A-Z0-9][A-Z0-9_-]{0,19}$/;
const PESEWAS = /^[0-9]{1,16}$/;

/**
 * A price list entry row, money in integer pesewas (A-130): `85000` is GHS 850.00. The entry is written into the
 * list's draft version, matched on product, grade, band and minimum quantity: a match replaces that entry, anything
 * else adds one, and entries the sheet does not name stay as they are.
 */
export interface PriceEntryRow {
  readonly rowNo: number;
  readonly priceListCode: string | null;
  readonly sku: string | null;
  readonly gradeCode: string | null;
  readonly weightBandCode: string | null;
  /** Three places ("0.000" when blank). */
  readonly minQty: string;
  readonly basis: PriceBasis | null;
  readonly listPricePesewas: bigint | null;
  readonly floorPricePesewas: bigint | null;
  readonly ceilingPricePesewas: bigint | null;
  readonly quoteOnly: boolean;
}

/**
 * An amount of pesewas: digits only, no decimal point, no separator, never through a JavaScript number, at most
 * the `platform.pesewas` maximum.
 */
export function readPesewas(value: string): bigint | null {
  if (!PESEWAS.test(value)) return null;
  const amount = BigInt(value);
  return amount <= Money.MAX_PESEWAS ? amount : null;
}

function pesewas(cells: Cells, column: string, fail: (column: string, message: string) => void): bigint | null {
  const value = blank(cells.get(column));
  if (value === null) {
    fail(column, `${column} is empty`);
    return null;
  }
  const amount = readPesewas(value);
  if (amount === null) fail(column, `${column} must be a whole number of pesewas, such as 85000 for GHS 850.00`);
  return amount;
}

/** A minimum quantity: zero or more, at most three decimal places, written with three. */
export function readMinQty(value: string | null): string | null {
  if (value === null) return '0.000';
  if (!/^[0-9]{1,11}(\.[0-9]{1,3})?$/.test(value)) return null;
  return Quantity.parse(value).toDecimalString();
}

export function readPriceEntryRow(rowNo: number, cells: Cells): Reading<PriceEntryRow> {
  const { errors, fail } = collector(rowNo);
  const priceListCode = code(cells, 'priceList', PRICE_LIST_CODE, 'RETAIL-POS', fail);
  if (blank(cells.get('priceList')) === null) fail('priceList', 'priceList is empty');
  const sku = code(cells, 'sku', SKU, 'GOAT-LIVE', fail);
  if (blank(cells.get('sku')) === null) fail('sku', 'SKU is empty');
  const basis = oneOf(cells, 'basis', PRICE_BASES, fail);
  if (blank(cells.get('basis')) === null) fail('basis', 'basis is empty');
  const minQty = readMinQty(blank(cells.get('minQty')));
  if (minQty === null) fail('minQty', 'minQty must be zero or more with at most three decimal places');
  return {
    row: {
      rowNo,
      priceListCode,
      sku,
      gradeCode: code(cells, 'grade', GRADE_CODE, 'A', fail),
      weightBandCode: code(cells, 'weightBand', GRADE_CODE, 'B20-25', fail),
      minQty: minQty ?? '0.000',
      basis,
      listPricePesewas: pesewas(cells, 'listPricePesewas', fail),
      floorPricePesewas: pesewas(cells, 'floorPricePesewas', fail),
      ceilingPricePesewas: pesewas(cells, 'ceilingPricePesewas', fail),
      quoteOnly: yesNo(cells, 'quoteOnly', fail) ?? false,
    },
    errors,
  };
}

/**
 * The band rules of FR-MDM-015 and B4, for a row whose three prices were read: floor <= list <= ceiling, and a
 * priced entry's floor above zero. The same rules as `defineEntries`, stated per column for the preview.
 */
export function priceBandErrors(row: PriceEntryRow): RowError[] {
  const { listPricePesewas: list, floorPricePesewas: floor, ceilingPricePesewas: ceiling } = row;
  if (list === null || floor === null || ceiling === null) return [];
  if (floor > list) return [{ rowNo: row.rowNo, column: 'floorPricePesewas', message: 'The floor price is above the list price' }];
  if (ceiling < list) return [{ rowNo: row.rowNo, column: 'ceilingPricePesewas', message: 'The ceiling price is below the list price' }];
  if (!row.quoteOnly && floor === 0n) return [{ rowNo: row.rowNo, column: 'floorPricePesewas', message: 'A priced entry needs a floor price above zero; mark it quoteOnly to send buyers to a quote' }];
  return [];
}
