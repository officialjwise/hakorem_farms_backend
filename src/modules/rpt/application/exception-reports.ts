import { createUuidV7Generator, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import { INVESTOR_ITEM_PERMISSION, type ExceptionKind, type Severity } from '../domain/exception-kinds';
import { approvalPairs, countRates, plainCounts, valueRates, type Counted, type RateRow } from '../domain/rates';
import { addDays, daysBetween, type PeriodRule } from '../domain/dashboard';
import { AlreadyReviewedError, ReportPeriodInvalidError, ReviewerIsActorError } from './errors';
import type { ExceptionItemRecord, ExceptionStore, ItemFilter, ItemScope } from './exception-store';

export const EXCEPTIONS_READ = 'rpt.exceptions.read';
export const EXCEPTIONS_REVIEW = 'rpt.exceptions.review';
const DAY_MS = 86_400_000;
/** A list range spans at most 92 days, as the dashboard's series do. */
const MAX_LIST_DAYS = 91;

export interface ExceptionItemView {
  readonly id: string;
  readonly exceptionDate: string;
  readonly branchId: string | null;
  readonly kind: ExceptionKind;
  readonly sourceKind: string | null;
  readonly severity: Severity;
  readonly abuseCases: readonly number[];
  readonly actor: PrincipalRef | null;
  readonly subjectDocument: { readonly id: string; readonly docType: string; readonly number: string | null } | null;
  readonly amountPesewas: number | null;
  readonly currency: 'GHS';
  readonly summary: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly raisedAt: string;
  readonly review: { readonly reviewedBy: PrincipalRef; readonly reviewedAt: string; readonly note: string } | null;
}

export interface RateByUserView {
  readonly actor: PrincipalRef;
  readonly count: number;
  readonly amountPesewas: number;
  readonly ratePercent: string | null;
  readonly comparisonRatePercent: string | null;
}

/**
 * A control the report counts rather than lists (the owner, 2026-11-25, A-400): one line per branch and day. The only
 * one: till sales whose till sent no receipt token, so their receipt text went nowhere (abuse case 60).
 */
export interface CountLineView {
  readonly code: 'TILL_SALES_WITHOUT_RECEIPT_TOKEN';
  readonly branchId: string;
  readonly count: number;
  readonly abuseCases: readonly number[];
  readonly summary: string;
}

/** Abuse case 60: a customer link sent by message, here one never made because the till sent no token. */
const MESSAGE_LINK_ABUSE_CASE = 60;

export interface DailyExceptionReportView {
  readonly date: string;
  readonly branchId: string | null;
  readonly counts: readonly { readonly kind: ExceptionKind; readonly count: number; readonly amountPesewas: number }[];
  readonly countLines: readonly CountLineView[];
  readonly items: readonly ExceptionItemView[];
  readonly voidsByCashier: readonly RateByUserView[];
  readonly overridesByUser: readonly RateByUserView[];
  readonly refundsByUser: readonly RateByUserView[];
  readonly mortalityByHandler: readonly RateByUserView[];
  readonly adjustmentsByUser: readonly RateByUserView[];
  readonly driverVariances: readonly RateByUserView[];
  readonly exportsByUser: readonly RateByUserView[];
  readonly shiftOverShort: readonly RateByUserView[];
  readonly approvalPairs: readonly { readonly maker: PrincipalRef; readonly checker: PrincipalRef; readonly count: number; readonly amountPesewas: number; readonly frequencyPercent: string }[];
  readonly currency: 'GHS';
  readonly generatedAt: string;
}

export interface Page<T> {
  readonly data: T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

export interface ExceptionListQuery {
  readonly date?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly kind?: ExceptionKind | undefined;
  readonly severity?: Severity | undefined;
  readonly actorId?: string | undefined;
  readonly branchId?: string | undefined;
  readonly reviewed?: boolean | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

const json = (n: bigint): number => Number(n);

/**
 * The daily exception report and its items (FR-RPT-007, FR-RPT-008, CR-059, ADR-0103): what the projector and the
 * sweep raised, for the branches the caller holds `rpt.exceptions.read` at in full, urgent first, each with its abuse
 * cases, actor, amount and subject document; the detection rates; and an item marked reviewed with a note, once, by
 * someone it does not name. An item about the investor books is shown only to a reader who holds `cap.capital.read`
 * at its branch; to anyone else it answers as one that does not exist.
 */
export class ExceptionReports {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: ExceptionStore,
    private readonly authoriser: Authoriser,
    private readonly names: PrincipalNames,
    private readonly registry: DocumentRegistry,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** getDailyExceptionReport: one Africa/Accra day, one branch or every branch the caller reads. */
  getDailyReport(actor: Actor | undefined, query: { readonly date: string; readonly branchId?: string | undefined }): Promise<DailyExceptionReportView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const scope = await this.scopeIn(tx, actor, EXCEPTIONS_READ, query.branchId);
      const filter: ItemFilter = { from: query.date, to: query.date, branchId: query.branchId };
      const items = await this.store.itemsOn(tx, filter, scope);
      const sales = await this.store.completedSalesBySalesperson(tx, query.date, scope.branchIds);
      const approvals = await this.store.approvalsOn(tx, query.date, scope.branchIds);
      const unlinked = await this.store.unlinkedTillSalesOn(tx, query.date, query.branchId === undefined ? scope.branchIds : [query.branchId]);
      const counted = (pick: (i: ExceptionItemRecord) => boolean): Counted[] => items.filter((i) => pick(i) && i.actorId !== null).map((i) => ({ actorId: i.actorId!, amountPesewas: i.amountPesewas ?? 0n }));
      const based = (pick: (i: ExceptionItemRecord) => boolean, baseKey: string) =>
        items.filter((i) => pick(i) && i.actorId !== null).map((i) => ({ actorId: i.actorId!, amountPesewas: i.amountPesewas ?? 0n, basePesewas: BigInt(Number(i.details[baseKey] ?? 0)) }));
      const tables = {
        voidsByCashier: countRates(counted((i) => i.kind === 'SALE_VOID' && i.sourceKind === 'VOIDED'), sales),
        overridesByUser: plainCounts(counted((i) => i.kind === 'PRICE_OVERRIDE' && i.sourceKind !== 'OVERRIDE_APPROVED')),
        refundsByUser: plainCounts(counted((i) => i.kind === 'REFUND')),
        mortalityByHandler: plainCounts(counted((i) => i.kind === 'MORTALITY')),
        adjustmentsByUser: plainCounts(counted((i) => i.kind === 'STOCK_ADJUSTMENT')),
        driverVariances: valueRates(based((i) => i.kind === 'DRIVER_VARIANCE' && i.sourceKind !== 'COD_SHORT', 'expectedPesewas')),
        exportsByUser: plainCounts(counted((i) => i.kind === 'BULK_EXPORT')),
        shiftOverShort: valueRates(based((i) => i.kind === 'SHIFT_OVER_SHORT' && i.sourceKind !== 'SHIFT_FORCE_CLOSED', 'expectedCashPesewas')),
      };
      const pairs = approvalPairs(approvals);
      const people = await this.names.refs(tx, [
        ...Object.values(tables).flatMap((rows) => rows.map((r) => r.actorId)),
        ...pairs.flatMap((p) => [p.makerId, p.checkerId]),
      ]);
      const ref = (id: string): PrincipalRef => people.get(id) ?? { id, displayName: id };
      const rated = (rows: readonly RateRow[]): RateByUserView[] => rows.map((r) => ({ actor: ref(r.actorId), count: r.count, amountPesewas: json(r.amountPesewas), ratePercent: r.ratePercent, comparisonRatePercent: r.comparisonRatePercent }));
      const byKind = new Map<ExceptionKind, { count: number; amount: bigint }>();
      for (const i of items) {
        const row = byKind.get(i.kind) ?? { count: 0, amount: 0n };
        row.count += 1;
        row.amount += i.amountPesewas ?? 0n;
        byKind.set(i.kind, row);
      }
      return {
        date: query.date,
        branchId: query.branchId ?? null,
        counts: [...byKind.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([kind, r]) => ({ kind, count: r.count, amountPesewas: json(r.amount) })),
        countLines: unlinked.map((u) => ({
          code: 'TILL_SALES_WITHOUT_RECEIPT_TOKEN' as const,
          branchId: u.branchId,
          count: u.count,
          abuseCases: [MESSAGE_LINK_ABUSE_CASE],
          summary: `${u.count} till ${u.count === 1 ? 'sale' : 'sales'} sent no receipt token`,
        })),
        items: await this.viewsIn(tx, items),
        voidsByCashier: rated(tables.voidsByCashier),
        overridesByUser: rated(tables.overridesByUser),
        refundsByUser: rated(tables.refundsByUser),
        mortalityByHandler: rated(tables.mortalityByHandler),
        adjustmentsByUser: rated(tables.adjustmentsByUser),
        driverVariances: rated(tables.driverVariances),
        exportsByUser: rated(tables.exportsByUser),
        shiftOverShort: rated(tables.shiftOverShort),
        approvalPairs: pairs.map((p) => ({
          maker: ref(p.makerId),
          checker: ref(p.checkerId),
          count: p.count,
          amountPesewas: json(approvals.filter((a) => a.makerId === p.makerId && a.checkerId === p.checkerId).reduce((sum, a) => sum + (a.amountPesewas ?? 0n), 0n)),
          frequencyPercent: p.frequencyPercent,
        })),
        currency: 'GHS',
        generatedAt: this.clock.now().toISOString(),
      };
    });
  }

  /** listExceptions: newest first, by a day or a range (a range of at most 92 days), kind, severity, actor, branch, reviewed. */
  list(actor: Actor | undefined, q: ExceptionListQuery): Promise<Page<ExceptionItemView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const scope = await this.scopeIn(tx, actor, EXCEPTIONS_READ, q.branchId);
      const today = toBusinessDate(this.clock.now());
      const to = q.date ?? q.to ?? today;
      const from = q.date ?? q.from ?? addDays(to, -30);
      const broken: PeriodRule[] = [];
      if (from > to) broken.push({ field: '/from', rule: 'FROM_AFTER_TO' });
      else if (daysBetween(from, to) > MAX_LIST_DAYS) broken.push({ field: '/to', rule: 'PERIOD_TOO_LONG' });
      if (broken.length > 0) throw new ReportPeriodInvalidError(broken);
      const filter: ItemFilter = { from, to, branchId: q.branchId, kind: q.kind, severity: q.severity, actorId: q.actorId, reviewed: q.reviewed };
      const binding = { operationId: 'listExceptions', principalId: actor!.principalId, filters: { ...filter } };
      const after = q.cursor === undefined ? null : (this.cursors.decode(q.cursor, binding) as { raisedAt: string; id: string });
      const rows = await this.store.listItems(tx, filter, scope, after, q.limit + 1);
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      const hasMore = rows.length > q.limit && last !== undefined;
      return {
        data: await this.viewsIn(tx, page),
        page: { nextCursor: hasMore ? this.cursors.encode(binding, { raisedAt: last.raisedAt.toISOString(), id: last.id }) : null, limit: q.limit, hasMore },
      };
    });
  }

  /**
   * reviewException (CR-059): the item marked reviewed with a note by a holder of `rpt.exceptions.review` at its
   * branch who is not the person it names; once (409 ALREADY_REVIEWED); audited. An item the caller cannot read is 404.
   */
  review(actor: Actor | undefined, id: string, note: string, key: string): Promise<StoredResponse<ExceptionItemView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, EXCEPTIONS_REVIEW);
      const claim = await this.idempotency.claim(tx, { operationId: 'reviewException', principalId: actor!.principalId, key, request: { id, note } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ExceptionItemView>;
      const scope = await this.scopeIn(tx, actor, EXCEPTIONS_REVIEW, undefined);
      const item = await this.store.item(tx, id);
      if (item === null || !visible(item, scope)) throw new NotFoundError(`no exception item ${id}`);
      if (item.review !== null) throw new AlreadyReviewedError(`exception item ${id} is reviewed`);
      if (item.actorId === actor!.principalId) throw new ReviewerIsActorError(`exception item ${id} names its reviewer`);
      const at = this.clock.now();
      const written = await this.store.insertReview(tx, { id: this.nextId(), itemId: id, branchId: item.branchId, itemActorId: item.actorId, note: note.trim(), at, actorId: actor!.principalId });
      if (!written) throw new AlreadyReviewedError(`exception item ${id} is reviewed`);
      const after = (await this.store.item(tx, id))!;
      await this.audit.record(tx, {
        module: 'rpt',
        action: 'REVIEW',
        entityType: 'ExceptionItem',
        entityId: id,
        branchId: item.branchId,
        before: { reviewed: false },
        after: { reviewed: true, kind: item.kind, note: note.trim() },
      });
      const response: StoredResponse<ExceptionItemView> = { status: 200, body: (await this.viewsIn(tx, [after]))[0]! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * The caller's whole-branch grants of a permission, and the branches among them where they also read the investor
   * books. A branch asked for must be one of them: another branch, real or made up, is refused alike (403).
   */
  private async scopeIn(tx: Transaction, actor: Actor | undefined, permission: string, branchId: string | undefined): Promise<ItemScope> {
    await this.authoriser.authorise(tx, actor, permission, branchId === undefined ? {} : { branchId });
    const whole = (grants: readonly { readonly branchId: string; readonly locationId: string | null }[]) => [...new Set(grants.filter((g) => g.locationId === null).map((g) => g.branchId))];
    const branchIds = whole(await this.authoriser.scopes(tx, actor!, permission));
    const investorBranchIds = whole(await this.authoriser.scopes(tx, actor!, INVESTOR_ITEM_PERMISSION)).filter((b) => branchIds.includes(b));
    return { branchIds, investorBranchIds };
  }

  private async viewsIn(tx: Transaction, items: readonly ExceptionItemRecord[]): Promise<ExceptionItemView[]> {
    const people = await this.names.refs(tx, [...items.flatMap((i) => (i.actorId === null ? [] : [i.actorId])), ...items.flatMap((i) => (i.review === null ? [] : [i.review.reviewedBy]))]);
    const documents = await this.registry.numberedRefs(tx, [...new Set(items.flatMap((i) => (i.subjectId === null ? [] : [i.subjectId])))]);
    const breakIds = items.flatMap((i) => (i.details['breakId'] === undefined || typeof i.details['breakId'] !== 'string' ? [] : [i.details['breakId']]));
    const breaks = await this.store.breakStates(tx, breakIds);
    const now = this.clock.now();
    const ref = (id: string): PrincipalRef => people.get(id) ?? { id, displayName: id };
    return items.map((i) => {
      const found = i.subjectId === null ? undefined : documents.get(i.subjectId);
      const state = typeof i.details['breakId'] === 'string' ? breaks.get(i.details['breakId']) : undefined;
      return {
        id: i.id,
        exceptionDate: i.exceptionDate,
        branchId: i.branchId,
        kind: i.kind,
        sourceKind: i.sourceKind,
        severity: i.severity,
        abuseCases: i.abuseCases,
        actor: i.actorId === null ? null : ref(i.actorId),
        subjectDocument: i.subjectId === null ? null : { id: i.subjectId, docType: found?.docType ?? i.subjectDocType!, number: found?.number ?? null },
        amountPesewas: i.amountPesewas === null ? null : json(i.amountPesewas),
        currency: 'GHS',
        summary: i.summary,
        details:
          state === undefined
            ? i.details
            : { ...i.details, breakState: { status: state.status, ageDays: Math.floor(((state.resolvedAt ?? now).getTime() - state.raisedAt.getTime()) / DAY_MS) } },
        raisedAt: i.raisedAt.toISOString(),
        review: i.review === null ? null : { reviewedBy: ref(i.review.reviewedBy), reviewedAt: i.review.reviewedAt.toISOString(), note: i.review.note },
      };
    });
  }
}

function visible(item: ExceptionItemRecord, scope: ItemScope): boolean {
  if (item.branchId === null || !scope.branchIds.includes(item.branchId)) return false;
  return item.restrictedTo === null || scope.investorBranchIds.includes(item.branchId);
}
