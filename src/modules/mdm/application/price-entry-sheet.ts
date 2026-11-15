import { Quantity, type Clock } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { Authoriser } from '../../iam';
import { priceBandErrors, PRICE_ENTRY_COLUMNS, readPriceEntryRow } from '../domain/import-rows';
import { duplicateErrors, type RowError } from '../domain/imports';
import type { EntryInput } from '../domain/pricing/price-list';
import { cached, EXPORT_PAGE, readRows, type EntitySheet, type SheetCheck, type SheetRecords } from './import-sheets';
import type { SheetLookups } from './import-store';
import type { PriceListAdmin } from './price-lists';
import type { EntrySnapshot, PriceListStore } from './price-list-store';

/** One draft version and every entry it will hold once the sheet's rows are merged in. */
interface VersionPlan {
  readonly versionId: string;
  readonly version: number;
  readonly branchId: string;
  readonly entries: readonly EntryInput[];
}

/** The sheet's rows as each draft version's whole new set of entries. */
interface PriceEntryPlan {
  readonly rows: number;
  readonly versions: readonly VersionPlan[];
}

/** Product, grade, band and minimum quantity: the match the database keeps unique within a version. */
const matchKey = (entry: { readonly productId: string; readonly gradeId?: string | null | undefined; readonly weightBandId?: string | null | undefined; readonly minQty?: string | undefined }) =>
  [entry.productId, entry.gradeId ?? '-', entry.weightBandId ?? '-', Quantity.parse(entry.minQty ?? '0').toDecimalString()].join('|');

function inputOf(entry: EntrySnapshot): EntryInput {
  return {
    productId: entry.productId,
    ...(entry.gradeId === null ? {} : { gradeId: entry.gradeId }),
    ...(entry.weightBandId === null ? {} : { weightBandId: entry.weightBandId }),
    basis: entry.basis as EntryInput['basis'],
    listPricePesewas: entry.listPricePesewas,
    floorPricePesewas: entry.floorPricePesewas,
    ceilingPricePesewas: entry.ceilingPricePesewas,
    quoteOnly: entry.quoteOnly,
    minQty: Quantity.parse(entry.minQty).toDecimalString(),
  };
}

/**
 * Price list entries (FR-MDM-015, FR-MDM-017) through a sheet, written by PriceListAdmin's own entry replacement into
 * each named list's DRAFT version, never an active one (A-130). Prices are integer pesewas. A row matching an entry
 * of the draft on product, grade, band and minimum quantity replaces it; any other row adds one; entries the sheet
 * does not name stay. A list with no draft, or whose draft awaits approval, is refused: the import never creates a
 * version and never touches one that has been submitted, so maker-checker activation (FR-MDM-015) still decides
 * when an imported price goes live. Applying is scoped to each version's branch (ADR-0017).
 */
export class PriceEntrySheet implements EntitySheet<PriceEntryPlan> {
  readonly entity = 'PRICE_LIST_ENTRY' as const;
  readonly sheetName = 'Price list entries';
  readonly fileStem = 'price-list-entries';
  readonly columns = PRICE_ENTRY_COLUMNS;
  readonly permissions = { read: 'mdm.price_list.read', create: 'mdm.price_list.update', update: 'mdm.price_list.update' };

  constructor(
    private readonly admin: PriceListAdmin,
    private readonly store: PriceListStore,
    private readonly lookups: SheetLookups,
    private readonly authoriser: Authoriser,
    private readonly clock: Clock,
  ) {}

  async check(tx: Transaction, records: SheetRecords): Promise<SheetCheck<PriceEntryPlan>> {
    const errors: RowError[] = [];
    const rows = readRows(records, readPriceEntryRow, errors);
    const list = cached(async (code) => {
      const found = await this.lookups.priceListByCode(tx, code);
      return found === null ? null : { id: found.id, open: await this.lookups.openVersion(tx, found.id) };
    });
    const product = cached((sku) => this.lookups.productBySku(tx, sku));
    const versions = new Map<string, { readonly version: number; readonly branchId: string; readonly original: ReadonlySet<string>; readonly entries: Map<string, EntryInput> }>();
    const rowKeys: { readonly rowNo: number; readonly key: string | null }[] = [];
    let toUpdate = 0;
    for (const row of rows) {
      const fail = (column: string, message: string) => errors.push({ rowNo: row.rowNo, column, message });
      errors.push(...priceBandErrors(row));
      let versionId: string | null = null;
      if (row.priceListCode !== null) {
        const found = await list(row.priceListCode);
        if (found === null) fail('priceList', `Unknown price list "${row.priceListCode}"`);
        else if (found.open === null) fail('priceList', `Price list ${row.priceListCode} has no draft version: draft one before importing its prices`);
        else if (found.open.status !== 'DRAFT') fail('priceList', `Price list ${row.priceListCode} has a version waiting for approval, which cannot change`);
        else {
          versionId = found.open.id;
          if (!versions.has(versionId)) {
            const current = await this.store.entries(tx, versionId);
            const entries = new Map(current.map((entry) => [matchKey(entry), inputOf(entry)]));
            versions.set(versionId, { version: found.open.version, branchId: found.open.branchId, original: new Set(entries.keys()), entries });
          }
        }
      }
      const found = row.sku === null ? null : await product(row.sku);
      if (row.sku !== null && found === null) fail('sku', `Unknown product "${row.sku}"`);
      const speciesRef = async (code: string | null, column: string, lookup: (speciesId: string, code: string) => Promise<string | null>) => {
        if (code === null || found === null) return undefined;
        if (found.speciesId === null) {
          fail(column, `Product ${row.sku!} has no species, so it has no ${column}`);
          return undefined;
        }
        const id = await lookup(found.speciesId, code);
        if (id === null) fail(column, `Unknown ${column} "${code}" for this product's species`);
        return id ?? undefined;
      };
      const gradeId = await speciesRef(row.gradeCode, 'grade', (speciesId, code) => this.lookups.gradeIdByCode(tx, speciesId, code));
      const weightBandId = await speciesRef(row.weightBandCode, 'weightBand', (speciesId, code) => this.lookups.weightBandIdByCode(tx, speciesId, code));
      const formed = !errors.some((error) => error.rowNo === row.rowNo);
      if (!formed || versionId === null || found === null) {
        rowKeys.push({ rowNo: row.rowNo, key: null });
        continue;
      }
      const input: EntryInput = {
        productId: found.id,
        ...(gradeId === undefined ? {} : { gradeId }),
        ...(weightBandId === undefined ? {} : { weightBandId }),
        basis: row.basis!,
        listPricePesewas: row.listPricePesewas!,
        floorPricePesewas: row.floorPricePesewas!,
        ceilingPricePesewas: row.ceilingPricePesewas!,
        quoteOnly: row.quoteOnly,
        minQty: row.minQty,
      };
      const key = matchKey(input);
      const draft = versions.get(versionId)!;
      if (draft.original.has(key)) toUpdate += 1;
      draft.entries.set(key, input);
      rowKeys.push({ rowNo: row.rowNo, key: `${versionId}|${key}` });
    }
    // Two rows of the file that name the same entry: the second would silently replace the first.
    errors.push(...duplicateErrors(rowKeys, 'sku', (row) => row.key));
    const plan = { rows: rows.length, versions: [...versions].map(([versionId, found]) => ({ versionId, version: found.version, branchId: found.branchId, entries: [...found.entries.values()] })) };
    return { errors, toCreate: rows.length - toUpdate, toUpdate, plan };
  }

  async apply(tx: Transaction, actor: Actor, plan: PriceEntryPlan): Promise<number> {
    for (const branchId of new Set(plan.versions.map((version) => version.branchId))) {
      await this.authoriser.authorise(tx, actor, this.permissions.update, { branchId });
    }
    for (const version of plan.versions) {
      await this.admin.replaceEntriesIn(tx, actor, version.versionId, { version: version.version, entries: version.entries });
    }
    return plan.rows;
  }

  /** The entries in force now: each live list's active version, with the list's code; drafts are not exported. */
  async exportRows(tx: Transaction): Promise<string[][]> {
    const rows: string[][] = [[...this.columns.all]];
    const now = this.clock.now();
    let afterList: string | null = null;
    for (;;) {
      const lists = await this.store.lists(tx, {}, afterList, EXPORT_PAGE);
      for (const list of lists) {
        const active = (await this.store.versionsOfInterest(tx, list.id, now)).active;
        if (active === null) continue;
        let after: string | null = null;
        for (;;) {
          const page = await this.store.entryRows(tx, active.id, null, after, EXPORT_PAGE);
          for (const entry of page) {
            rows.push([
              list.code,
              entry.product.sku,
              entry.grade?.code ?? '',
              entry.weightBand?.code ?? '',
              entry.minQty,
              entry.basis,
              entry.listPricePesewas.toString(),
              entry.floorPricePesewas.toString(),
              entry.ceilingPricePesewas.toString(),
              entry.quoteOnly ? 'TRUE' : 'FALSE',
            ]);
          }
          if (page.length < EXPORT_PAGE) break;
          after = page.at(-1)!.id;
        }
      }
      if (lists.length < EXPORT_PAGE) return rows;
      afterList = lists.at(-1)!.id;
    }
  }
}
