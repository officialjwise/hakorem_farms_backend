import type { Clock } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction } from '../../../platform/database/unit-of-work';
import { CUSTOMER_COLUMNS, duplicateErrors, readCustomerRow, type CustomerRow, type ImportEntity, type RowError, type SheetColumns } from '../domain/imports';
import type { PartiesAdmin } from './parties-admin';
import type { PartiesStore } from './parties-store';

/** What a dry run found: the row errors, how many rows would create and update a record, and the plan to apply. */
export interface SheetCheck<P> {
  readonly errors: readonly RowError[];
  readonly toCreate: number;
  readonly toUpdate: number;
  readonly plan: P;
}

/**
 * One entity's spreadsheet (FR-MDM-019, FR-MDM-020): its columns, how a dry run checks its rows against the
 * database, how a checked plan is applied through the entity's own service in the caller's transaction, and the
 * rows it exports. `permissions` are the entity's own: applying an import or exporting needs them as well as the
 * import permission, so an import is never a way round them.
 */
export interface EntitySheet<P = unknown> {
  readonly entity: ImportEntity;
  readonly sheetName: string;
  readonly fileStem: string;
  readonly columns: SheetColumns;
  readonly permissions: { readonly read: string; readonly create: string; readonly update: string };
  check(tx: Transaction, records: readonly { readonly rowNo: number; readonly cells: ReadonlyMap<string, string> }[]): Promise<SheetCheck<P>>;
  /** Applies a plan with no errors; any refusal throws and the caller's transaction writes nothing. Returns rows applied. */
  apply(tx: Transaction, actor: Actor, plan: P): Promise<number>;
  /** The header and every live record, as text cells in `columns` order. */
  exportRows(tx: Transaction): Promise<string[][]>;
}

interface CustomerPlanRow {
  readonly row: CustomerRow;
  /** The customer a row changes, with the version the dry run saw; null for a row that creates one. */
  readonly target: { readonly id: string; readonly version: number } | null;
  readonly tierId: string | undefined;
}

/** A sheet's records, each as the record type `R` its reader gives. */
export type SheetRecords = readonly { readonly rowNo: number; readonly cells: ReadonlyMap<string, string> }[];

/** Reads every record with the entity's row reader, collecting the form errors into `errors`. */
export function readRows<R>(records: SheetRecords, reader: (rowNo: number, cells: ReadonlyMap<string, string>) => { readonly row: R; readonly errors: readonly RowError[] }, errors: RowError[]): R[] {
  return records.map((record) => {
    const result = reader(record.rowNo, record.cells);
    errors.push(...result.errors);
    return result.row;
  });
}

/** A lookup by code asked once per distinct code within one check. */
export function cached<V>(lookup: (code: string) => Promise<V>): (code: string) => Promise<V> {
  const seen = new Map<string, Promise<V>>();
  return (code) => {
    let found = seen.get(code);
    if (found === undefined) {
      found = lookup(code);
      seen.set(code, found);
    }
    return found;
  };
}

/** The most records one export query reads at a time. */
export const EXPORT_PAGE = 1_000;

/** Customers (FR-MDM-008) through a sheet, written by PartiesAdmin's own create and update. */
export class CustomerSheet implements EntitySheet<readonly CustomerPlanRow[]> {
  readonly entity = 'CUSTOMER' as const;
  readonly sheetName = 'Customers';
  readonly fileStem = 'customers';
  readonly columns = CUSTOMER_COLUMNS;
  readonly permissions = { read: 'mdm.customer.read', create: 'mdm.customer.create', update: 'mdm.customer.update' };

  constructor(
    private readonly parties: PartiesAdmin,
    private readonly store: PartiesStore,
    private readonly clock: Clock,
  ) {}

  async check(tx: Transaction, records: readonly { readonly rowNo: number; readonly cells: ReadonlyMap<string, string> }[]): Promise<SheetCheck<readonly CustomerPlanRow[]>> {
    const errors: RowError[] = [];
    const read = records.map((record) => {
      const result = readCustomerRow(record.rowNo, record.cells);
      errors.push(...result.errors);
      return result.row;
    });
    errors.push(...duplicateErrors(read, 'phone', (row) => row.phone), ...duplicateErrors(read, 'customerNo', (row) => row.customerNo));
    const tiers = new Map<string, string | null>();
    const plan: CustomerPlanRow[] = [];
    for (const row of read) {
      let target: CustomerPlanRow['target'] = null;
      if (row.customerNo !== null) {
        const existing = await this.store.customerByNo(tx, row.customerNo);
        if (existing === null) errors.push({ rowNo: row.rowNo, column: 'customerNo', message: `No customer ${row.customerNo}` });
        else if (existing.status === 'ANONYMISED') errors.push({ rowNo: row.rowNo, column: 'customerNo', message: `Customer ${row.customerNo} is anonymised and cannot change` });
        else {
          target = { id: existing.id, version: existing.version };
          if (row.kind !== null && row.kind !== existing.kind) errors.push({ rowNo: row.rowNo, column: 'kind', message: "A customer's kind cannot change by import" });
        }
      }
      if (row.phone !== null) {
        const holder = await this.parties.phoneHolder(tx, row.phone);
        if (holder !== null && holder.id !== target?.id) errors.push({ rowNo: row.rowNo, column: 'phone', message: `Phone number already belongs to customer ${holder.customerNo}` });
      }
      let tierId: string | undefined;
      if (row.tierCode !== null) {
        if (!tiers.has(row.tierCode)) tiers.set(row.tierCode, (await this.store.tierByCode(tx, row.tierCode))?.id ?? null);
        const found = tiers.get(row.tierCode)!;
        if (found === null) errors.push({ rowNo: row.rowNo, column: 'tier', message: `Unknown tier "${row.tierCode}"` });
        else tierId = found;
      }
      plan.push({ row, target, tierId });
    }
    const toUpdate = plan.filter((entry) => entry.row.customerNo !== null).length;
    return { errors, toCreate: plan.length - toUpdate, toUpdate, plan };
  }

  async apply(tx: Transaction, actor: Actor, plan: readonly CustomerPlanRow[]): Promise<number> {
    for (const { row, target, tierId } of plan) {
      const common = { ...(row.phone === null ? {} : { phone: row.phone }), ...(row.email === null ? {} : { email: row.email }), ...(tierId === undefined ? {} : { tierId }) };
      if (target === null) await this.parties.createCustomerIn(tx, actor, { kind: row.kind!, name: row.name!, ...common });
      else await this.parties.updateCustomerIn(tx, actor, target.id, { version: target.version, ...(row.name === null ? {} : { name: row.name }), ...common });
    }
    return plan.length;
  }

  async exportRows(tx: Transaction): Promise<string[][]> {
    const rows: string[][] = [[...this.columns.all]];
    const now = this.clock.now();
    let after: string | null = null;
    for (;;) {
      const page = await this.store.customers(tx, {}, now, after, EXPORT_PAGE);
      for (const customer of page) {
        if (customer.status === 'ANONYMISED') continue;
        rows.push([customer.customerNo, customer.kind, customer.name, customer.phone ?? '', customer.email ?? '', customer.tier.code]);
      }
      if (page.length < EXPORT_PAGE) return rows;
      after = page.at(-1)!.id;
    }
  }
}
