import type { Actor } from '../../../platform/context/request-context';
import type { Transaction } from '../../../platform/database/unit-of-work';
import { readSupplierRow, SUPPLIER_COLUMNS, type SupplierRow } from '../domain/import-rows';
import { duplicateErrors, type RowError } from '../domain/imports';
import { cached, EXPORT_PAGE, readRows, type EntitySheet, type SheetCheck, type SheetRecords } from './import-sheets';
import type { SheetLookups } from './import-store';
import type { ReferenceDataAdmin } from './reference-data-admin';
import type { ReferenceDataStore } from './reference-data-store';

interface SupplierPlanRow {
  readonly row: SupplierRow;
  /** The supplier a row changes, with the version the check saw; null for a row that registers one. */
  readonly target: { readonly id: string; readonly version: number } | null;
  readonly categoryIds: readonly string[] | undefined;
}

/**
 * Suppliers (FR-MDM-007) through a sheet, written by ReferenceDataAdmin's own create and update (A-130). A blank
 * number registers a supplier; a number changes that supplier, and a blank cell changes nothing. The categories
 * cell, when stated, replaces the categories supplied. There is no TIN column: a tax number is typed in the form,
 * sealed with the supplier's key, never carried in a spreadsheet.
 */
export class SupplierSheet implements EntitySheet<readonly SupplierPlanRow[]> {
  readonly entity = 'SUPPLIER' as const;
  readonly sheetName = 'Suppliers';
  readonly fileStem = 'suppliers';
  readonly columns = SUPPLIER_COLUMNS;
  readonly permissions = { read: 'mdm.supplier.read', create: 'mdm.supplier.create', update: 'mdm.supplier.update' };

  constructor(
    private readonly admin: ReferenceDataAdmin,
    private readonly store: ReferenceDataStore,
    private readonly lookups: SheetLookups,
  ) {}

  async check(tx: Transaction, records: SheetRecords): Promise<SheetCheck<readonly SupplierPlanRow[]>> {
    const errors: RowError[] = [];
    const rows = readRows(records, readSupplierRow, errors);
    errors.push(...duplicateErrors(rows, 'phone', (row) => row.phone), ...duplicateErrors(rows, 'publicId', (row) => row.publicId));
    const category = cached((code) => this.lookups.categoryIdByCode(tx, code));
    const plan: SupplierPlanRow[] = [];
    for (const row of rows) {
      let target: SupplierPlanRow['target'] = null;
      if (row.publicId !== null) {
        target = await this.lookups.supplierByPublicId(tx, row.publicId);
        if (target === null) errors.push({ rowNo: row.rowNo, column: 'publicId', message: `No supplier ${row.publicId}` });
      }
      if (row.phone !== null && (await this.admin.supplierPhoneTaken(tx, row.phone, target?.id ?? null))) {
        errors.push({ rowNo: row.rowNo, column: 'phone', message: 'Phone number already belongs to another supplier' });
      }
      let categoryIds: string[] | undefined;
      if (row.categoryCodes !== null) {
        categoryIds = [];
        for (const code of row.categoryCodes) {
          const id = await category(code);
          if (id === null) errors.push({ rowNo: row.rowNo, column: 'categories', message: `Unknown category "${code}"` });
          else categoryIds.push(id);
        }
      }
      plan.push({ row, target, categoryIds });
    }
    const toUpdate = rows.filter((row) => row.publicId !== null).length;
    return { errors, toCreate: rows.length - toUpdate, toUpdate, plan };
  }

  async apply(tx: Transaction, actor: Actor, plan: readonly SupplierPlanRow[]): Promise<number> {
    for (const { row, target, categoryIds } of plan) {
      const fields = {
        ...(row.contactName === null ? {} : { contactName: row.contactName }),
        ...(row.phone === null ? {} : { phone: row.phone }),
        ...(row.email === null ? {} : { email: row.email }),
        ...(row.address === null ? {} : { address: row.address }),
        ...(categoryIds === undefined ? {} : { categoryIds }),
      };
      if (target === null) await this.admin.createSupplierIn(tx, actor, { name: row.name!, ...fields });
      else await this.admin.updateSupplierIn(tx, actor, target.id, { version: target.version, ...(row.name === null ? {} : { name: row.name }), ...fields });
    }
    return plan.length;
  }

  async exportRows(tx: Transaction): Promise<string[][]> {
    const rows: string[][] = [[...this.columns.all]];
    let after: string | null = null;
    for (;;) {
      const page = await this.store.suppliers(tx, {}, after, EXPORT_PAGE);
      for (const supplier of page) {
        rows.push([
          supplier.publicId,
          supplier.name,
          supplier.contactName ?? '',
          supplier.phone ?? '',
          supplier.email ?? '',
          supplier.address ?? '',
          supplier.categories.map((category) => category.code).join(';'),
        ]);
      }
      if (page.length < EXPORT_PAGE) return rows;
      after = page.at(-1)!.id;
    }
  }
}
