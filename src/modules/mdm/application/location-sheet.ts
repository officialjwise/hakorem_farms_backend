import type { Actor } from '../../../platform/context/request-context';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { Authoriser } from '../../iam';
import type { CatalogueRule } from '../domain/catalogue';
import { LOCATION_COLUMNS, readLocationRow, type LocationRow } from '../domain/import-rows';
import { duplicateErrors, type RowError } from '../domain/imports';
import { planLocation, planLocationChange } from '../domain/locations';
import { cached, EXPORT_PAGE, readRows, type EntitySheet, type SheetCheck, type SheetRecords } from './import-sheets';
import type { SheetLookups } from './import-store';
import type { LocationsAdmin } from './locations-admin';
import type { LocationsStore } from './locations-store';

/** Where a row's parent is: a live location, or a row earlier in the same sheet that creates it. */
type ParentRef = { readonly kind: 'LIVE'; readonly id: string } | { readonly kind: 'SHEET'; readonly key: string } | null;

type LocationPlanRow =
  | { readonly kind: 'CREATE'; readonly key: string; readonly branchId: string; readonly row: LocationRow; readonly parent: ParentRef }
  | { readonly kind: 'UPDATE'; readonly key: string; readonly branchId: string; readonly id: string; readonly version: number; readonly row: LocationRow; readonly parent: ParentRef };

const keyOf = (branchCode: string, code: string) => `${branchCode}|${code}`;

const RULE_COLUMN: Readonly<Record<string, string>> = { '/parentId': 'parent', '/kind': 'kind', '/tempClass': 'tempClass', '/tempMinC': 'tempMinC', '/tempMaxC': 'tempMaxC' };
const RULE_MESSAGE: Readonly<Record<string, string>> = {
  PARENT_IN_OTHER_BRANCH: 'The parent is in another branch',
  PARENT_IS_VIRTUAL: 'The parent is a virtual location',
  PARENT_IS_SELF_OR_BELOW: 'The parent is this location or one below it',
  COLD_ROOM_NEEDS_TEMPERATURE: 'A cold room needs tempClass CHILLED or FROZEN, tempMinC and tempMaxC',
  NOT_ABOVE_MIN: 'tempMaxC must be above tempMinC',
  VIRTUAL_KIND_FIXED: 'A virtual location is created with its branch and cannot be imported',
  VIRTUAL_LOCATION_FIXED: 'A virtual location cannot change',
};

function ruleErrors(rowNo: number, rules: readonly CatalogueRule[]): RowError[] {
  return rules.map((rule) => ({ rowNo, column: rule.field === null ? null : (RULE_COLUMN[rule.field] ?? null), message: RULE_MESSAGE[rule.rule] ?? `The row breaks the rule ${rule.rule}` }));
}

const orUndefined = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

/**
 * Physical locations (FR-MDM-006) through a sheet, written by LocationsAdmin's own create and update (A-130). The
 * branch and code name the location: a code the branch does not hold creates one, a code it holds changes that
 * location, whose kind and temperature class never change. A parent is a live location of the same branch or a row
 * above that creates one. Virtual locations are never imported. Applying is scoped to each branch the sheet writes:
 * a manager granted at one branch cannot write another's locations by import (ADR-0017).
 */
export class LocationSheet implements EntitySheet<readonly LocationPlanRow[]> {
  readonly entity = 'LOCATION' as const;
  readonly sheetName = 'Locations';
  readonly fileStem = 'locations';
  readonly columns = LOCATION_COLUMNS;
  readonly permissions = { read: 'mdm.location.read', create: 'mdm.location.create', update: 'mdm.location.update' };

  constructor(
    private readonly admin: LocationsAdmin,
    private readonly store: LocationsStore,
    private readonly lookups: SheetLookups,
    private readonly authoriser: Authoriser,
  ) {}

  async check(tx: Transaction, records: SheetRecords): Promise<SheetCheck<readonly LocationPlanRow[]>> {
    const errors: RowError[] = [];
    const rows = readRows(records, readLocationRow, errors);
    errors.push(...duplicateErrors(rows, 'code', (row) => (row.branchCode === null || row.code === null ? null : keyOf(row.branchCode, row.code))));
    const branch = cached((code) => this.lookups.branchIdByCode(tx, code));
    /** Rows above that create a location, by key: a parent named by a later row may be one of them. */
    const createdAbove = new Set<string>();
    const plan: LocationPlanRow[] = [];
    let toUpdate = 0;
    for (const row of rows) {
      const rowErrors: RowError[] = [];
      const fail = (column: string | null, message: string) => rowErrors.push({ rowNo: row.rowNo, column, message });
      const branchId = row.branchCode === null ? null : await branch(row.branchCode);
      if (row.branchCode !== null && branchId === null) fail('branch', `Unknown branch "${row.branchCode}"`);
      const existing = branchId === null || row.code === null ? null : await this.lookups.locationByCode(tx, branchId, row.code);
      if (existing !== null) toUpdate += 1;
      if (branchId === null || row.code === null) {
        errors.push(...rowErrors);
        continue;
      }
      const key = keyOf(row.branchCode!, row.code);
      let parent: ParentRef = null;
      let parentFacts: { sameBranch: boolean; isVirtual: boolean; isSelfOrBelow: boolean } | null = null;
      if (row.parentCode !== null) {
        const live = await this.lookups.locationByCode(tx, branchId, row.parentCode);
        if (live !== null) {
          parent = { kind: 'LIVE', id: live.id };
          parentFacts = { sameBranch: true, isVirtual: live.isVirtual, isSelfOrBelow: existing === null ? false : await this.store.isSelfOrBelow(tx, existing.id, live.id) };
        } else if (createdAbove.has(keyOf(row.branchCode!, row.parentCode))) {
          parent = { kind: 'SHEET', key: keyOf(row.branchCode!, row.parentCode) };
          parentFacts = { sameBranch: true, isVirtual: false, isSelfOrBelow: false };
        } else fail('parent', `No location "${row.parentCode}" in branch ${row.branchCode!}, and no row above creates it`);
      }
      if (existing === null) {
        if (row.name === null) fail('name', 'name is empty: a new location needs it');
        if (row.kind === null) fail('kind', 'kind is empty: a new location needs it');
        else {
          const planned = planLocation({ kind: row.kind, parent: parentFacts, tempClass: orUndefined(row.tempClass), tempMinC: orUndefined(row.tempMinC), tempMaxC: orUndefined(row.tempMaxC) });
          if (!planned.ok) rowErrors.push(...ruleErrors(row.rowNo, planned.error));
        }
        createdAbove.add(key);
        plan.push({ kind: 'CREATE', key, branchId, row, parent });
      } else if (existing.isVirtual) {
        fail('code', 'A virtual location cannot change');
      } else {
        const before = (await this.store.location(tx, existing.id))!;
        if (row.kind !== null && row.kind !== before.kind) fail('kind', 'kind cannot change once a location exists');
        if (row.tempClass !== null && row.tempClass !== before.tempClass) fail('tempClass', 'tempClass cannot change once a location exists');
        const planned = planLocationChange(before, { parent: parentFacts ?? undefined, tempMinC: orUndefined(row.tempMinC), tempMaxC: orUndefined(row.tempMaxC) });
        if (!planned.ok) rowErrors.push(...ruleErrors(row.rowNo, planned.error));
        plan.push({ kind: 'UPDATE', key, branchId, id: existing.id, version: existing.version, row, parent });
      }
      errors.push(...rowErrors);
    }
    return { errors, toCreate: rows.length - toUpdate, toUpdate, plan };
  }

  async apply(tx: Transaction, actor: Actor, plan: readonly LocationPlanRow[]): Promise<number> {
    // Each branch the sheet writes, checked with the permission its rows need (ADR-0017).
    const scopes = new Set(plan.map((entry) => `${entry.kind}|${entry.branchId}`));
    for (const scope of scopes) {
      const [kind, branchId] = scope.split('|') as [LocationPlanRow['kind'], string];
      await this.authoriser.authorise(tx, actor, kind === 'CREATE' ? this.permissions.create : this.permissions.update, { branchId });
    }
    const created = new Map<string, string>();
    const parentId = (parent: ParentRef) => (parent === null ? undefined : parent.kind === 'LIVE' ? parent.id : created.get(parent.key)!);
    for (const entry of plan) {
      const { row } = entry;
      if (entry.kind === 'CREATE') {
        const view = await this.admin.createLocationIn(tx, actor, {
          branchId: entry.branchId,
          parentId: parentId(entry.parent),
          code: row.code!,
          name: row.name!,
          kind: row.kind!,
          isSellable: orUndefined(row.isSellable),
          tempClass: orUndefined(row.tempClass),
          tempMinC: orUndefined(row.tempMinC),
          tempMaxC: orUndefined(row.tempMaxC),
          capacityHead: orUndefined(row.capacityHead),
        });
        created.set(entry.key, view.id);
      } else {
        await this.admin.updateLocationIn(tx, actor, entry.id, {
          version: entry.version,
          name: orUndefined(row.name),
          parentId: parentId(entry.parent),
          isSellable: orUndefined(row.isSellable),
          tempMinC: orUndefined(row.tempMinC),
          tempMaxC: orUndefined(row.tempMaxC),
          capacityHead: orUndefined(row.capacityHead),
        });
      }
    }
    return plan.length;
  }

  /** Every live physical location, parents before children as they were created; virtual locations are left out. */
  async exportRows(tx: Transaction): Promise<string[][]> {
    const locations = [];
    let after: string | null = null;
    for (;;) {
      const page = await this.store.locations(tx, { includeVirtual: false }, after, EXPORT_PAGE);
      locations.push(...page);
      if (page.length < EXPORT_PAGE) break;
      after = page.at(-1)!.id;
    }
    const codes = new Map(locations.map((location) => [location.id, location.code]));
    return [
      [...this.columns.all],
      ...locations.map((location) => [
        location.branch.code,
        location.code,
        location.name,
        location.kind,
        location.parentId === null ? '' : (codes.get(location.parentId) ?? ''),
        location.isSellable ? 'TRUE' : 'FALSE',
        location.tempClass ?? '',
        location.tempMinC ?? '',
        location.tempMaxC ?? '',
        location.capacityHead === null ? '' : String(location.capacityHead),
      ]),
    ];
  }
}
