import { Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { Authoriser } from '../../iam';
import { duplicateErrors, readRows, type EntitySheet, type MasterDataRefs, type ProductFacts, type RowError, type SheetCheck, type SheetRecords } from '../../mdm';
import { checkReceiptLines } from '../domain/goods-receipt';
import { OPENING_RULE_MESSAGES, OPENING_STOCK_COLUMNS, readOpeningRow, type OpeningRow } from '../domain/opening-stock';
import type { GoodsReceiptStore } from './goods-receipt-store';
import type { GoodsReceipts, ReceiptLineInput } from './goods-receipts';

/** Where opening stock is never received: in transit and a site hold none of their own (A-136 (g)). */
const NOT_RECEIVING: ReadonlySet<string> = new Set(['IN_TRANSIT', 'SITE']);
export const OPENING_STOCK_LOAD = 'inv.opening_stock.load';
/** The sheet column of each field a receipt rule names. */
const COLUMN_OF: Readonly<Record<string, string>> = { productId: 'sku', valuePesewas: 'valuePesewas', qtyReceived: 'qty', animals: 'tag', batchNo: 'batch', expiresOn: 'expiresOn' };

interface PlannedLine {
  readonly rowNo: number;
  readonly branchId: string;
  readonly locationId: string;
  readonly line: ReceiptLineInput;
}

/**
 * The `OPENING_STOCK` import sheet (A-128, A-147, ADR-0050): INV's implementation of MDM's `EntitySheet` port,
 * registered with `MdmImports` when INV starts. The dry run checks every row against master data and the stock
 * ledger: a live branch, a physical stock location of it, a live stock product with no stock history in the branch
 * (opening stock is loaded once, before trading), the receipt rules of an opening balance (a lot's batch and expiry,
 * an animal's tag, one per row), a value at cost above zero, and no batch or tag already in use. Apply, inside the
 * import's one serializable transaction, authorises `inv.opening_stock.load` at each location the file writes, then
 * drafts and posts one goods receipt of kind OPENING per location through `GoodsReceipts`, so every unit, movement
 * (`OPENING_BALANCE` from the branch's virtual OPENING location, through `Stock.postIn`), cost pool, audit event and
 * `inv.OpeningStockLoaded` posting event is the one a receipt writes. Its export is the empty template.
 */
export class OpeningStockSheet implements EntitySheet<readonly PlannedLine[]> {
  readonly entity = 'OPENING_STOCK' as const;
  readonly sheetName = 'Opening stock';
  readonly fileStem = 'opening-stock';
  readonly columns = OPENING_STOCK_COLUMNS;
  readonly permissions = { read: 'inv.stock.read', create: OPENING_STOCK_LOAD, update: OPENING_STOCK_LOAD };

  constructor(
    private readonly refs: MasterDataRefs,
    private readonly store: GoodsReceiptStore,
    private readonly receipts: GoodsReceipts,
    private readonly authoriser: Authoriser,
    private readonly clock: Clock,
  ) {}

  async check(tx: Transaction, records: SheetRecords): Promise<SheetCheck<readonly PlannedLine[]>> {
    const errors: RowError[] = [];
    const rows = readRows(records, readOpeningRow, errors);
    errors.push(
      ...duplicateErrors(rows, 'batch', (r) => (r.batch === null ? null : `${r.sku.toUpperCase()}:${r.batch.toUpperCase()}`)),
      ...duplicateErrors(rows, 'tag', (r) => (r.tag === null ? null : `${r.sku.toUpperCase()}:${r.tag.toUpperCase()}`)),
      ...duplicateErrors(rows, 'sku', (r) => (r.batch === null && r.tag === null ? `${r.branch}:${r.location}:${r.sku}`.toUpperCase() : null)),
    );
    const today = toBusinessDate(this.clock.now());
    const plan: PlannedLine[] = [];
    const history = new Map<string, boolean>();
    for (const row of rows) {
      const fail = (column: string, message: string) => errors.push({ rowNo: row.rowNo, column, message });
      if (row.branch === '' || row.location === '' || row.sku === '' || row.qty === null || row.valuePesewas === null) continue;
      const branch = await this.refs.branchByCodeIn(tx, row.branch);
      if (branch === null) {
        fail('branch', `No branch ${row.branch}`);
        continue;
      }
      const location = await this.refs.locationByCodeIn(tx, branch.id, row.location);
      if (location === null) fail('location', `No location ${row.location} at ${branch.code}`);
      else if (location.isVirtual || NOT_RECEIVING.has(location.kind)) fail('location', `${location.code} does not hold stock of its own`);
      const product = await this.refs.productBySkuIn(tx, row.sku);
      if (product === null) {
        fail('sku', `No product ${row.sku}`);
        continue;
      }
      const historyKey = `${product.id}:${branch.id}`;
      if (!history.has(historyKey)) history.set(historyKey, await this.store.hasStockHistory(tx, product.id, branch.id));
      if (history.get(historyKey)!) fail('sku', `${product.sku} already has stock history at ${branch.code}: opening stock is loaded once, before trading`);
      for (const broken of checkReceiptLines({ kind: 'OPENING', receivedOn: today, lines: [{ productId: product.id, product, draft: this.draftOf(row) }] })) {
        fail(COLUMN_OF[broken.field.split('/').at(-1)!] ?? 'sku', OPENING_RULE_MESSAGES[broken.rule] ?? broken.rule);
      }
      if (product.tracking === 'SERIAL' && row.sex === null) fail('sex', 'An animal needs its sex: MALE, FEMALE or UNKNOWN');
      const identifier = product.tracking === 'SERIAL' ? row.tag : product.tracking === 'LOT' ? row.batch : null;
      if (identifier !== null && (await this.store.activeIdentifiers(tx, product.id, [identifier])).length > 0) {
        fail(product.tracking === 'SERIAL' ? 'tag' : 'batch', `${identifier} is already in use for ${product.sku}`);
      }
      if (location !== null) plan.push({ rowNo: row.rowNo, branchId: branch.id, locationId: location.id, line: this.lineOf(row, product) });
    }
    return { errors, toCreate: rows.length, toUpdate: 0, plan };
  }

  async apply(tx: Transaction, actor: Actor, plan: readonly PlannedLine[]): Promise<number> {
    const byLocation = new Map<string, PlannedLine[]>();
    for (const planned of plan) byLocation.set(planned.locationId, [...(byLocation.get(planned.locationId) ?? []), planned]);
    const receivedAt = this.clock.now();
    for (const [locationId, lines] of byLocation) {
      // A grant at one location never loads another's stock.
      await this.authoriser.authorise(tx, actor, OPENING_STOCK_LOAD, { branchId: lines[0]!.branchId, locationId });
      const draft = await this.receipts.createIn(
        tx,
        actor,
        { kind: 'OPENING', locationId, receivedAt, notes: `Opening stock import, spreadsheet rows ${lines.map((l) => l.rowNo).join(', ')}`.slice(0, 2000), lines: lines.map((l) => l.line) },
        { openingStock: true },
      );
      await this.receipts.postIn(tx, actor, draft.id, { openingStock: true });
    }
    return plan.length;
  }

  /** The template: the columns `check` reads, and no rows, since stock is reported, not re-imported. */
  exportRows(): Promise<string[][]> {
    return Promise.resolve([[...OPENING_STOCK_COLUMNS.all]]);
  }

  private draftOf(row: OpeningRow) {
    return {
      qtyReceived: row.qty!,
      value: Money.ofPesewas(row.valuePesewas!),
      batchNo: row.batch,
      expiresOn: row.expiresOn,
      animalTags: row.tag === null ? [] : [row.tag],
    };
  }

  private lineOf(row: OpeningRow, product: ProductFacts): ReceiptLineInput {
    const weight = row.weightKg === null ? {} : { weightKg: row.weightKg, weightSource: 'MANUAL' as const };
    if (product.tracking === 'SERIAL') {
      return {
        productId: product.id,
        qtyReceived: row.qty!.toDecimalString(),
        valuePesewas: row.valuePesewas!,
        animals: [{ tagNo: row.tag ?? '', sex: row.sex ?? 'UNKNOWN', ...weight }],
      };
    }
    return {
      productId: product.id,
      qtyReceived: row.qty!.toDecimalString(),
      valuePesewas: row.valuePesewas!,
      ...weight,
      ...(row.batch === null ? {} : { batchNo: row.batch }),
      ...(row.expiresOn === null ? {} : { expiresOn: row.expiresOn }),
    };
  }
}
