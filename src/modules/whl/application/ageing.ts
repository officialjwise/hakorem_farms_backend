import { Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { Cursors } from '../../../platform/http/cursor';
import type { Billing, ReceivableAsAtRecord } from '../../bil';
import type { Journals } from '../../fin';
import type { Authoriser } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import type { AllocationsAsAt } from '../../pay';
import { ageCustomer, sumAgeing, type AgeingFigures } from '../domain/ageing';
import { pageFrom } from '../domain/paging';
import type { DunningStore } from './dunning-store';

const READ = 'whl.ageing.read';

/** The contract's ageing figures: the five buckets and their total, with 1200 and what it holds beyond the open items. */
export interface AgeingFiguresView {
  readonly currentPesewas: number;
  readonly days1To30Pesewas: number;
  readonly days31To60Pesewas: number;
  readonly days61To90Pesewas: number;
  readonly daysOver90Pesewas: number;
  readonly totalPesewas: number;
  readonly ledgerPesewas: number;
  readonly ledgerCreditPesewas: number;
  readonly notAgedPesewas: number;
  readonly notAgedCreditPesewas: number;
}

/** The contract's `AgeingRow`. */
export interface AgeingRowView extends AgeingFiguresView {
  readonly customer: { readonly id: string; readonly publicId: string; readonly name: string };
  readonly creditLimitPesewas: number | null;
  readonly onHold: boolean;
}

/** The contract's `AgeingReport`. */
export interface AgeingReportView {
  readonly data: readonly AgeingRowView[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
  readonly asOf: string;
  readonly totals: AgeingFiguresView;
  /** 1200 held against a party that is no customer (the till's walk-in customer): in `totals`, on no row. */
  readonly otherPartiesPesewas: number;
  readonly otherPartiesCreditPesewas: number;
  readonly currency: 'GHS';
}

export interface AgeingQuery {
  readonly asOf: string | null;
  readonly customerId: string | null;
  readonly accountManagerId: string | null;
}

const json = (pesewas: bigint) => Money.ofPesewas(pesewas).toJsonInteger();

export function figuresView(f: AgeingFigures): AgeingFiguresView {
  return {
    currentPesewas: json(f.currentPesewas),
    days1To30Pesewas: json(f.days1To30Pesewas),
    days31To60Pesewas: json(f.days31To60Pesewas),
    days61To90Pesewas: json(f.days61To90Pesewas),
    daysOver90Pesewas: json(f.daysOver90Pesewas),
    totalPesewas: json(f.totalPesewas),
    ledgerPesewas: json(f.ledgerPesewas),
    ledgerCreditPesewas: json(f.ledgerCreditPesewas),
    notAgedPesewas: json(f.notAgedPesewas),
    notAgedCreditPesewas: json(f.notAgedCreditPesewas),
  };
}

/**
 * Receivables ageing as at a date (FR-WHL-010, SA-21, ADR-0089). Each invoice, receipt and debit note issued to a
 * customer by the date (BIL's, with its credit notes issued by then) less what payments had applied to it by then
 * (PAY's allocations, each dated by its business day, migration 0264) goes whole into the band of its days past due,
 * counted from its due date (or its issue date when it has none). Beside the buckets, each customer's 1200 balance as at
 * the same date (FIN's), and what 1200 holds that no open item explains, so the report ties to the receivables control
 * account exactly and a difference is never hidden in a bucket. Read only, at the branches the reader holds
 * `whl.ageing.read` for as a whole; the totals cover every customer the filter matches, not only the page.
 */
export class Ageing {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: DunningStore,
    private readonly billing: Billing,
    private readonly allocations: AllocationsAsAt,
    private readonly journals: Journals,
    private readonly refs: MasterDataRefs,
    private readonly authoriser: Authoriser,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {}

  report(actor: Actor | undefined, query: AgeingQuery, cursor: string | undefined, limit: number): Promise<AgeingReportView> {
    // One snapshot across BIL, PAY and FIN, so the buckets and 1200 are read at the same instant.
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const branchIds = [...new Set((await this.authoriser.scopes(tx, actor!, READ)).filter((s) => s.locationId === null).map((s) => s.branchId))].sort();
      const asOf = query.asOf ?? toBusinessDate(this.clock.now());
      const binding = { operationId: 'getAgeingReport', principalId: actor!.principalId, filters: { ...query, asOf } };
      const after = cursor === undefined ? null : this.cursors.decode(cursor, binding);

      const managed = query.accountManagerId === null ? null : new Set(await this.store.customersManagedBy(tx, query.accountManagerId));
      const byCustomer = await this.figuresIn(tx, { branchIds, customerId: query.customerId, asOf });
      const matching = [...byCustomer.keys()].filter((id) => managed === null || managed.has(id));
      const customers = await this.refs.customersIn(tx, matching);
      // 1200 held against a party MDM holds no customer for (the till's walk-in customer) has no row; it is in the totals.
      const customerIds = matching.filter((id) => customers.has(id));
      const others = sumAgeing(matching.filter((id) => !customers.has(id)).map((id) => byCustomer.get(id)!));
      const ordered = customerIds
        .map((id) => ({ id, name: customers.get(id)?.name ?? '' }))
        .sort((a, b) => (a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1));
      const { page, hasMore } = pageFrom(ordered, after === null ? null : (c) => c.name > after['name']! || (c.name === after['name'] && c.id > after['id']!), limit);
      const accounts = await this.store.accountsOf(tx, page.map((c) => c.id));
      const data = page.map(({ id }) => {
        const customer = customers.get(id)!;
        const account = accounts.get(id);
        return {
          customer: { id: customer.id, publicId: customer.publicId, name: customer.name },
          ...figuresView(byCustomer.get(id)!),
          creditLimitPesewas: account === undefined ? null : json(account.creditLimitPesewas),
          onHold: account?.status === 'ON_HOLD',
        };
      });
      const last = page.at(-1);
      return {
        data,
        page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { name: last.name, id: last.id }) : null, limit, hasMore },
        asOf,
        totals: figuresView(sumAgeing([...customerIds.map((id) => byCustomer.get(id)!), others])),
        otherPartiesPesewas: json(others.ledgerPesewas),
        otherPartiesCreditPesewas: json(others.ledgerCreditPesewas),
        currency: 'GHS',
      };
    });
  }

  /** One customer's ageing at one branch as at a date, in the caller's transaction (the statement's summary, FR-WHL-009). It authorises nothing. */
  async customerIn(tx: Transaction, customerId: string, branchId: string, asOf: string): Promise<AgeingFigures> {
    return (await this.figuresIn(tx, { branchIds: [branchId], customerId, asOf })).get(customerId) ?? ageCustomer([], 0n, asOf);
  }

  /** Every customer with an open item or a 1200 balance at the branches as at the date, with its figures. */
  private async figuresIn(tx: Transaction, filter: { readonly branchIds: readonly string[]; readonly customerId: string | null; readonly asOf: string }): Promise<Map<string, AgeingFigures>> {
    const documents = await this.billing.receivablesAsAtIn(tx, filter);
    const applied = await this.allocations.netAppliedIn(tx, documents.map((d) => d.id), filter.asOf);
    const ledger = await this.journals.customerReceivableBalancesIn(tx, filter);
    const items = new Map<string, ReceivableAsAtRecord[]>();
    for (const d of documents) items.set(d.customerId, [...(items.get(d.customerId) ?? []), d]);
    const result = new Map<string, AgeingFigures>();
    for (const customerId of new Set([...items.keys(), ...ledger.keys()])) {
      const figures = ageCustomer(
        (items.get(customerId) ?? []).map((d) => ({ issueDate: d.issueDate, dueDate: d.dueDate, grossPesewas: d.grossPesewas, creditedPesewas: d.creditedPesewas, appliedPesewas: applied.get(d.id) ?? 0n })),
        ledger.get(customerId) ?? 0n,
        filter.asOf,
      );
      const nothing = figures.totalPesewas === 0n && figures.ledgerPesewas === 0n && figures.ledgerCreditPesewas === 0n && figures.notAgedCreditPesewas === 0n;
      if (!nothing) result.set(customerId, figures);
    }
    return result;
  }
}
