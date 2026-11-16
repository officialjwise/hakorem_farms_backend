import { Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { UnitOfWork } from '../../../platform/database/unit-of-work';
import type { Cursors } from '../../../platform/http/cursor';
import type { Billing } from '../../bil';
import type { Authoriser } from '../../iam';
import { daysOverdue, pageProbe } from '../domain/time';
import type { MasterDataRefs } from '../../mdm';

const READ = 'pay.receivable.read';

export interface OpenItemView {
  readonly billingDocument: { readonly id: string; readonly docType: string; readonly number: string | null };
  readonly customer: { readonly id: string; readonly customerNo: string; readonly name: string } | null;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly grossPesewas: number;
  readonly creditedPesewas: number;
  readonly allocatedPesewas: number;
  readonly outstandingPesewas: number;
  readonly daysOverdue: number;
  readonly currency: 'GHS';
}

export interface OpenItemPageView {
  readonly data: readonly OpenItemView[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
  readonly totalOutstandingPesewas: number;
  readonly currency: 'GHS';
  readonly asOf: string;
}

/**
 * `listOpenItems` (FR-PAY-009): what customers still owe, from BIL's settlement summary through `Billing.openItemsIn`
 * at the branches the reader holds `pay.receivable.read` for. The amounts are what is outstanding now; `asOf` sets the
 * business date the days overdue (and `overdueOnly`) are counted from. The total covers everything the filter matches.
 */
export class Receivables {
  constructor(
    private readonly billing: Billing,
    private readonly uow: UnitOfWork,
    private readonly authoriser: Authoriser,
    private readonly cursors: Cursors,
    private readonly refs: MasterDataRefs,
    private readonly clock: Clock,
  ) {}

  list(actor: Actor | undefined, query: { readonly customerId: string | null; readonly overdueOnly: boolean; readonly asOf: string | null }, cursor: string | undefined, limit: number): Promise<OpenItemPageView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const branchIds = [...new Set((await this.authoriser.scopes(tx, actor!, READ)).filter((s) => s.locationId === null).map((s) => s.branchId))].sort();
      const now = this.clock.now();
      const asOf = query.asOf ?? toBusinessDate(now);
      const binding = { operationId: 'listOpenItems', principalId: actor!.principalId, filters: { ...query, asOf } };
      const beforeId = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.billing.openItemsIn(tx, { branchIds, customerId: query.customerId, overdueBefore: query.overdueOnly ? asOf : null }, beforeId, pageProbe(limit));
      const rows = found.rows.slice(0, limit);
      const customers = await this.refs.customersIn(tx, [...new Set(rows.flatMap((r) => (r.customerId === null ? [] : [r.customerId])))]);
      const data = rows.map((r) => {
        const customer = r.customerId === null ? undefined : customers.get(r.customerId);
        return {
          billingDocument: { id: r.id, docType: r.kind, number: r.documentNo },
          customer: customer === undefined ? null : { id: customer.id, customerNo: customer.customerNo, name: customer.name },
          issueDate: r.issueDate,
          dueDate: r.dueDate,
          grossPesewas: Money.ofPesewas(r.grossPesewas).toJsonInteger(),
          creditedPesewas: Money.ofPesewas(r.creditedPesewas).toJsonInteger(),
          allocatedPesewas: Money.ofPesewas(r.allocatedPesewas).toJsonInteger(),
          outstandingPesewas: Money.ofPesewas(r.outstandingPesewas).toJsonInteger(),
          daysOverdue: daysOverdue(r.dueDate, asOf),
          currency: 'GHS' as const,
        };
      });
      const hasMore = found.rows.length > limit;
      const last = rows.at(-1);
      return {
        data,
        page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore },
        totalOutstandingPesewas: Money.ofPesewas(found.totalOutstandingPesewas).toJsonInteger(),
        currency: 'GHS',
        asOf: now.toISOString(),
      };
    });
  }
}
