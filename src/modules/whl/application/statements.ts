import { createUuidV7Generator, Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { NumberSeries } from '../../../platform/documents/number-series';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { AsyncConsumer } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import { DOCUMENT_ARCHIVED, type DocumentArchived, type Documents } from '../../doc';
import type { Journals } from '../../fin';
import type { Authoriser } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { pageProbe } from '../domain/paging';
import { judgePeriod, numberedLines, statementOf, statementRenderData, type Side, type StatementFigures, type StatementLineKind } from '../domain/statement';
import { StatementInvalidError, type StatementRule } from './errors';
import type { StatementAgeingRecord, StatementLineRecord, StatementRecord, StatementStatus, StatementStore } from './statement-store';
import type { Ageing } from './ageing';

const READ = 'whl.statement.read';
const CREATE = 'whl.statement.create';
export const STATEMENT = 'STATEMENT';

/** The contract's `StatementLine`. */
export interface StatementLineView {
  readonly date: string;
  readonly kind: StatementLineKind;
  readonly reference: string;
  readonly debitPesewas: number;
  readonly creditPesewas: number;
  readonly balancePesewas: number;
  readonly balanceSide: Side;
}

/** The contract's `CustomerStatement`. */
export interface StatementView {
  readonly id: string;
  readonly statementNo: string | null;
  readonly status: StatementStatus;
  readonly customer: { readonly id: string; readonly publicId: string; readonly name: string };
  readonly branchId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly issueDate: string | null;
  readonly openingPesewas: number;
  readonly openingCreditPesewas: number;
  readonly invoicedPesewas: number;
  readonly paidPesewas: number;
  readonly creditedPesewas: number;
  readonly otherChargesPesewas: number;
  readonly otherCreditsPesewas: number;
  readonly closingPesewas: number;
  readonly closingCreditPesewas: number;
  readonly lines: readonly StatementLineView[];
  readonly documentId: string | null;
  /** FR-WHL-009's ageing summary as at the period end, at the statement's branch (B10 continued 2); null on a statement issued before it. */
  readonly ageing: StatementAgeingView | null;
  readonly currency: 'GHS';
}

/** The contract's `StatementAgeing`: the buckets of what was owed at the period end and what 1200 held beyond them. */
export interface StatementAgeingView {
  readonly asOf: string;
  readonly currentPesewas: number;
  readonly days1To30Pesewas: number;
  readonly days31To60Pesewas: number;
  readonly days61To90Pesewas: number;
  readonly daysOver90Pesewas: number;
  readonly totalPesewas: number;
  readonly notAgedPesewas: number;
  readonly notAgedCreditPesewas: number;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

export interface StatementCreateRequest {
  readonly customerId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly issue: boolean;
  readonly branchId?: string | undefined;
}

export interface StatementQuery {
  readonly customerId: string | null;
  readonly periodEnd: string | null;
}

const json = (pesewas: bigint) => Money.ofPesewas(pesewas).toJsonInteger();

/**
 * Customer statements (FR-WHL-009, ADR-0085). A statement is the customer's trade receivables at one branch for a
 * period, read from the ledger through FIN's door (`Journals.customerReceivablesIn`) in the producing transaction, so
 * it ties to 1200 for the customer's subledger party exactly, whatever posted to it: billing documents, B9a's payments
 * (a till's included), refunds, reversals and journals. An issued statement takes the next number of its branch's
 * STATEMENT series and asks DOC to render and archive it after commit (ADR-0010, ADR-0061); one issued statement
 * exists per customer, branch and period, so asking again answers the first, rendered and archived once. A draft is a
 * stored preview with no number and no rendering. Each handler authorises first, deny by default, at the statement's
 * branch. Sending is B11's (ADR-0062).
 */
export class Statements {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: StatementStore,
    private readonly refs: MasterDataRefs,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly registry: DocumentRegistry,
    private readonly numbers: NumberSeries,
    private readonly journals: Journals,
    private readonly archive: Documents,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
    private readonly ageing: Ageing,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, query: StatementQuery, cursor: string | undefined, limit: number): Promise<Page<StatementView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const branchIds = await this.wholeBranches(tx, actor!, READ);
      const binding = { operationId: 'listStatements', principalId: actor!.principalId, filters: query };
      const beforeId = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.list(tx, { ...query, branchIds }, beforeId, pageProbe(limit));
      const rows = found.slice(0, limit);
      const hasMore = found.length > limit;
      // A page carries no lines: a statement's lines are read with getStatement (A-300 (g), low-bandwidth discipline).
      return { data: await this.views(tx, rows, new Map()), page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: rows.at(-1)!.id }) : null, limit, hasMore } };
    });
  }

  get(actor: Actor | undefined, id: string): Promise<StatementView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const statement = await this.store.statement(tx, id);
      if (statement === null) throw new NotFoundError(`no statement ${id}`);
      await this.authoriser.authorise(tx, actor, READ, { branchId: statement.branchId });
      return (await this.views(tx, [statement], new Map([[id, await this.store.lines(tx, id)]])))[0]!;
    });
  }

  /**
   * createStatement: the statement of a customer's account at a branch for a period, issued (numbered, then rendered
   * and archived after commit) or as a draft. An issued statement of the same customer, branch and period already
   * there is answered as it stands, so it is numbered, rendered and archived once (FR-WHL-009: the same period gives
   * the same document). Replayed by its Idempotency-Key.
   */
  async create(actor: Actor | undefined, request: StatementCreateRequest, key: string): Promise<StoredResponse<StatementView>> {
    const branchId = await this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, CREATE);
      if (request.branchId !== undefined) return request.branchId;
      const branches = await this.wholeBranches(tx, actor!, CREATE);
      if (branches.length !== 1) throw new StatementInvalidError([{ field: '/branchId', rule: 'BRANCH_REQUIRED' }]);
      return branches[0]!;
    });
    const year = toBusinessDate(this.clock.now()).slice(0, 4);
    return this.uow.run({ isolation: 'serializable', seriesLocks: [`${STATEMENT}:${year}:${branchId}`] }, async (tx) => {
      await this.authoriser.authorise(tx, actor, CREATE, { branchId });
      const claim = await this.idempotency.claim(tx, { operationId: 'createStatement', principalId: actor!.principalId, key, request: { ...request, branchId: request.branchId ?? null } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<StatementView>;
      const now = this.clock.now();
      const today = toBusinessDate(now);
      const broken: StatementRule[] = [...judgePeriod(request.periodStart, request.periodEnd, today)];
      const customer = (await this.refs.customersIn(tx, [request.customerId])).get(request.customerId);
      const branch = (await this.refs.branchesIn(tx, [branchId])).get(branchId);
      if (customer === undefined) broken.push({ field: '/customerId', rule: 'CUSTOMER_UNKNOWN' });
      if (branch === undefined) throw new NotFoundError(`no branch ${branchId}`);
      if (broken.length > 0) throw new StatementInvalidError(broken);
      const period = { customerId: customer!.id, branchId, periodStart: request.periodStart, periodEnd: request.periodEnd };

      const existing = request.issue ? await this.store.issuedFor(tx, period) : null;
      if (existing !== null) {
        const response: StoredResponse<StatementView> = { status: 201, body: (await this.views(tx, [existing], new Map([[existing.id, await this.store.lines(tx, existing.id)]])))[0]! };
        await this.idempotency.complete(tx, claim.id, response);
        return response;
      }

      const receivables = await this.journals.customerReceivablesIn(tx, { customerId: customer!.id, branchId, from: request.periodStart, to: request.periodEnd });
      const figures = statementOf(receivables.openingPesewas, receivables.lines, request.periodStart);
      // FR-WHL-009's ageing summary as at the period end, read in the same snapshot; the database ties it to the closing.
      const aged = await this.ageing.customerIn(tx, customer!.id, branchId, request.periodEnd);
      const ageing: StatementAgeingRecord = {
        asOf: request.periodEnd,
        currentPesewas: aged.currentPesewas,
        days1To30Pesewas: aged.days1To30Pesewas,
        days31To60Pesewas: aged.days31To60Pesewas,
        days61To90Pesewas: aged.days61To90Pesewas,
        daysOver90Pesewas: aged.daysOver90Pesewas,
        notAgedPesewas: aged.notAgedPesewas,
        notAgedCreditPesewas: aged.notAgedCreditPesewas,
      };
      const id = this.nextId();
      await this.registry.register(tx, { id, docType: STATEMENT, ownerModule: 'whl', branchId, actorId: actor!.principalId });
      const statementNo = request.issue
        ? await this.numbers.allocateIn(tx, { docType: STATEMENT, fiscalYear: Number(year), branchId, branchCode: branch.code, documentId: id })
        : null;
      const record = recordOf(id, statementNo, period, figures, request.issue ? today : null, ageing);
      await this.store.insert(tx, record, linesOf(figures), actor!.principalId, now);
      if (statementNo !== null) {
        await this.archive.requestRenderIn(tx, {
          businessDocumentId: id,
          docType: STATEMENT,
          documentNo: statementNo,
          branchId,
          renderData: statementRenderData({
            statementNo,
            issuedOn: today,
            customer: { name: customer!.name, publicId: customer!.publicId },
            branch: { code: branch.code, name: branch.name },
            periodStart: request.periodStart,
            periodEnd: request.periodEnd,
            figures,
            ageing: { ...aged, asOf: request.periodEnd },
          }),
        });
      }
      const view = (await this.views(tx, [record], new Map([[id, linesOf(figures)]])))[0]!;
      await this.audit.record(tx, { module: 'whl', action: request.issue ? 'ISSUE' : 'CREATE', entityType: 'Statement', entityId: id, branchId, before: null, after: { ...view } });
      const response: StoredResponse<StatementView> = { status: 201, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * WHL's consumer of `doc.DocumentArchived` (ADR-0061): an issued statement learns its archived rendering, once
   * (`ck_statement_frozen`). A redelivery finds it already named and changes nothing.
   */
  readonly archiveLinks: AsyncConsumer = {
    name: 'whl.statement-archive-link',
    eventTypes: [DOCUMENT_ARCHIVED],
    isolation: 'read committed',
    handle: async (tx, event) => {
      const archived = event.payload as unknown as DocumentArchived;
      if (archived.docType !== STATEMENT) return;
      await this.store.linkArchive(tx, archived.businessDocumentId, archived.archivedDocumentId, event.actorId, this.clock.now());
    },
  };

  /** The branches the actor holds the permission at as a whole, not only at one of its locations. */
  private async wholeBranches(tx: Transaction, actor: Actor, permission: string): Promise<string[]> {
    return [...new Set((await this.authoriser.scopes(tx, actor, permission)).filter((s) => s.locationId === null).map((s) => s.branchId))].sort();
  }

  private async views(tx: Transaction, rows: readonly StatementRecord[], lines: ReadonlyMap<string, readonly StatementLineRecord[]>): Promise<StatementView[]> {
    const customers = await this.refs.customersIn(tx, [...new Set(rows.map((r) => r.customerId))]);
    return rows.map((r) => {
      const customer = customers.get(r.customerId)!;
      return {
        id: r.id,
        statementNo: r.statementNo,
        status: r.status,
        customer: { id: customer.id, publicId: customer.publicId, name: customer.name },
        branchId: r.branchId,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        issueDate: r.issueDate,
        openingPesewas: json(r.openingPesewas),
        openingCreditPesewas: json(r.openingCreditPesewas),
        invoicedPesewas: json(r.invoicedPesewas),
        paidPesewas: json(r.paidPesewas),
        creditedPesewas: json(r.creditedPesewas),
        otherChargesPesewas: json(r.otherChargesPesewas),
        otherCreditsPesewas: json(r.otherCreditsPesewas),
        closingPesewas: json(r.closingPesewas),
        closingCreditPesewas: json(r.closingCreditPesewas),
        lines: (lines.get(r.id) ?? []).map((l) => ({
          date: l.date,
          kind: l.kind,
          reference: l.reference,
          debitPesewas: json(l.debitPesewas),
          creditPesewas: json(l.creditPesewas),
          balancePesewas: json(l.balancePesewas),
          balanceSide: l.balanceSide,
        })),
        documentId: r.archivedDocumentId,
        ageing: r.ageing === null ? null : ageingView(r.ageing),
        currency: 'GHS',
      };
    });
  }
}

function recordOf(
  id: string,
  statementNo: string | null,
  period: { readonly customerId: string; readonly branchId: string; readonly periodStart: string; readonly periodEnd: string },
  f: StatementFigures,
  issueDate: string | null,
  ageing: StatementAgeingRecord,
): StatementRecord {
  return {
    id,
    statementNo,
    status: statementNo === null ? 'DRAFT' : 'ISSUED',
    ...period,
    openingPesewas: f.openingPesewas,
    openingCreditPesewas: f.openingCreditPesewas,
    invoicedPesewas: f.invoicedPesewas,
    creditedPesewas: f.creditedPesewas,
    paidPesewas: f.paidPesewas,
    otherChargesPesewas: f.otherChargesPesewas,
    otherCreditsPesewas: f.otherCreditsPesewas,
    closingPesewas: f.closingPesewas,
    closingCreditPesewas: f.closingCreditPesewas,
    issueDate,
    archivedDocumentId: null,
    ageing,
  };
}

function ageingView(a: StatementAgeingRecord): StatementAgeingView {
  const total = a.currentPesewas + a.days1To30Pesewas + a.days31To60Pesewas + a.days61To90Pesewas + a.daysOver90Pesewas;
  return {
    asOf: a.asOf,
    currentPesewas: json(a.currentPesewas),
    days1To30Pesewas: json(a.days1To30Pesewas),
    days31To60Pesewas: json(a.days31To60Pesewas),
    days61To90Pesewas: json(a.days61To90Pesewas),
    daysOver90Pesewas: json(a.daysOver90Pesewas),
    totalPesewas: json(total),
    notAgedPesewas: json(a.notAgedPesewas),
    notAgedCreditPesewas: json(a.notAgedCreditPesewas),
  };
}

function linesOf(f: StatementFigures): StatementLineRecord[] {
  return numberedLines(f);
}
