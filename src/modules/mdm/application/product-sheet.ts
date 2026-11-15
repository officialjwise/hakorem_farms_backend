import type { Actor } from '../../../platform/context/request-context';
import type { Transaction } from '../../../platform/database/unit-of-work';
import { PRODUCT_COLUMNS, productCreateErrors, readProductRow, type ProductRow } from '../domain/import-rows';
import { duplicateErrors, type RowError } from '../domain/imports';
import type { FieldRule, ProductDraft } from '../domain/product';
import { cached, EXPORT_PAGE, readRows, type EntitySheet, type SheetCheck, type SheetRecords } from './import-sheets';
import type { SheetLookups } from './import-store';
import type { ProductCatalogue, ProductChange } from './product-catalogue';
import type { ProductStore, ProductView } from './product-store';

type ProductPlanRow = { readonly kind: 'CREATE'; readonly draft: ProductDraft } | { readonly kind: 'UPDATE'; readonly id: string; readonly change: ProductChange };

/** The sheet column a catalogue rule's field pointer names. */
const COLUMN_OF: Readonly<Record<string, string>> = {
  '/sku': 'sku',
  '/name': 'name',
  '/categoryId': 'category',
  '/speciesId': 'species',
  '/taxCategoryId': 'taxCategory',
  '/baseUom': 'baseUom',
  '/saleUom': 'saleUom',
  '/nominalPackKg': 'nominalPackKg',
  '/shelfLifeDays': 'shelfLifeDays',
  '/barcode': 'barcode',
  '/onlineMode': 'onlineMode',
};

/** A catalogue rule (FR-MDM-001, FR-MDM-003, FR-MDM-004) said as a row error of the sheet. */
export function productRuleError(rowNo: number, rule: FieldRule): RowError {
  const column = COLUMN_OF[rule.field] ?? null;
  const name = column ?? 'The row';
  const messages: Readonly<Record<string, string>> = {
    UNKNOWN: `Unknown ${name}`,
    DUPLICATE_VALUE: `${name} is already used by another product`,
    REQUIRED_FOR_SERIALISED: 'A SERIALISED product needs a species',
    LIVE_ANIMALS_ARE_REQUEST_TO_BUY: 'A live animal is sold on request: onlineMode must be REQUEST_TO_BUY or HIDDEN',
    CATCH_WEIGHT_IN_KG: 'A CATCH_WEIGHT product is held in KG',
    ONLY_FOR_CATCH_WEIGHT: 'Only a CATCH_WEIGHT product has a nominal pack weight',
    NOT_FOR_NON_STOCK: `A NON_STOCK product has no ${name}`,
    POSITIVE: `${name} must be more than zero`,
    TRACKING_FIXED: 'Adding or removing a shelf life would change how the product is held in stock, which an import cannot do',
  };
  return { rowNo, column, message: messages[rule.rule] ?? `${name} breaks the rule ${rule.rule}` };
}

/** A value of the row that a product's stock-keeping fixes for good: blank, or the same as the product's. */
function fixedErrors(row: ProductRow, before: ProductView): RowError[] {
  const errors: RowError[] = [];
  const fixed = (column: string, stated: string | null, current: string | null) => {
    if (stated !== null && stated !== current) errors.push({ rowNo: row.rowNo, column, message: `${column} cannot change once a product exists` });
  };
  fixed('stockPolicy', row.stockPolicy, before.stockPolicy);
  fixed('species', row.speciesCode, before.species?.code ?? null);
  fixed('baseUom', row.baseUom, before.baseUom);
  fixed('saleUom', row.saleUom, before.saleUom);
  return errors;
}

const orUndefined = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

/**
 * Products (FR-MDM-001) through a sheet, written by ProductCatalogue's own create and update (A-130). The SKU names
 * the product: one the catalogue does not hold creates a product, ACTIVE and HIDDEN online unless the row says
 * otherwise; one it holds changes that product, and the stock-keeping policy, species and units never change.
 */
export class ProductSheet implements EntitySheet<readonly ProductPlanRow[]> {
  readonly entity = 'PRODUCT' as const;
  readonly sheetName = 'Products';
  readonly fileStem = 'products';
  readonly columns = PRODUCT_COLUMNS;
  readonly permissions = { read: 'mdm.product.read', create: 'mdm.product.create', update: 'mdm.product.update' };

  constructor(
    private readonly catalogue: ProductCatalogue,
    private readonly products: ProductStore,
    private readonly lookups: SheetLookups,
  ) {}

  async check(tx: Transaction, records: SheetRecords): Promise<SheetCheck<readonly ProductPlanRow[]>> {
    const errors: RowError[] = [];
    const rows = readRows(records, readProductRow, errors);
    errors.push(...duplicateErrors(rows, 'sku', (row) => row.sku), ...duplicateErrors(rows, 'barcode', (row) => row.barcode));
    const category = cached((code) => this.lookups.categoryIdByCode(tx, code));
    const species = cached((code) => this.lookups.speciesIdByCode(tx, code));
    const taxCategory = cached((code) => this.lookups.taxCategoryIdByCode(tx, code));
    const plan: ProductPlanRow[] = [];
    let toUpdate = 0;
    for (const row of rows) {
      const rowErrors: RowError[] = [];
      const resolve = async (code: string | null, column: string, lookup: (code: string) => Promise<string | null>) => {
        if (code === null) return undefined;
        const id = await lookup(code);
        if (id === null) rowErrors.push({ rowNo: row.rowNo, column, message: `Unknown ${column} "${code}"` });
        return id ?? undefined;
      };
      const categoryId = await resolve(row.categoryCode, 'category', category);
      const speciesId = await resolve(row.speciesCode, 'species', species);
      const taxCategoryId = await resolve(row.taxCategoryCode, 'taxCategory', taxCategory);
      const existing = row.sku === null ? null : await this.lookups.productBySku(tx, row.sku);
      if (existing !== null) toUpdate += 1;
      const formed = !errors.some((error) => error.rowNo === row.rowNo) && rowErrors.length === 0;
      const change = {
        name: orUndefined(row.name),
        categoryId,
        taxCategoryId,
        nominalPackKg: orUndefined(row.nominalPackKg),
        shelfLifeDays: orUndefined(row.shelfLifeDays),
        barcode: orUndefined(row.barcode),
        description: orUndefined(row.description),
        onlineMode: orUndefined(row.onlineMode),
      };
      if (existing === null) {
        rowErrors.push(...productCreateErrors(row));
        if (formed && rowErrors.length === 0) {
          const draft: ProductDraft = { ...change, sku: row.sku!, name: row.name!, categoryId: categoryId!, stockPolicy: row.stockPolicy!, speciesId, baseUom: row.baseUom!, saleUom: row.saleUom!, onlineMode: row.onlineMode ?? 'HIDDEN' };
          rowErrors.push(...(await this.catalogue.createRules(tx, draft)).map((rule) => productRuleError(row.rowNo, rule)));
          plan.push({ kind: 'CREATE', draft });
        }
      } else {
        const before = (await this.products.view(tx, existing.id))!;
        rowErrors.push(...fixedErrors(row, before));
        if (formed && rowErrors.length === 0) {
          rowErrors.push(...(await this.catalogue.updateRules(tx, before, change)).map((rule) => productRuleError(row.rowNo, rule)));
          plan.push({ kind: 'UPDATE', id: existing.id, change: { ...change, version: before.version } });
        }
      }
      errors.push(...rowErrors);
    }
    return { errors, toCreate: rows.length - toUpdate, toUpdate, plan };
  }

  async apply(tx: Transaction, actor: Actor, plan: readonly ProductPlanRow[]): Promise<number> {
    for (const row of plan) {
      if (row.kind === 'CREATE') await this.catalogue.createIn(tx, actor, row.draft);
      else await this.catalogue.updateIn(tx, actor, row.id, row.change);
    }
    return plan.length;
  }

  async exportRows(tx: Transaction): Promise<string[][]> {
    const rows: string[][] = [[...this.columns.all]];
    let before: string | null = null;
    for (;;) {
      const page = await this.products.list(tx, {}, before, EXPORT_PAGE);
      for (const product of page) {
        rows.push([
          product.sku,
          product.name,
          product.category.code,
          product.stockPolicy,
          product.species?.code ?? '',
          product.baseUom,
          product.saleUom,
          product.taxCategory.code,
          product.nominalPackKg ?? '',
          product.shelfLifeDays === null ? '' : String(product.shelfLifeDays),
          product.barcode ?? '',
          product.description ?? '',
          product.onlineMode,
        ]);
      }
      if (page.length < EXPORT_PAGE) return rows;
      before = page.at(-1)!.id;
    }
  }
}
