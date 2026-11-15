import { createHash } from 'node:crypto';
import { createUuidV7Generator, Money, Quantity, Weight, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { databaseErrorOf, type DatabaseErrorFields, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { InvalidStateTransitionError, NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { ApprovalHandler, ApprovalRecord, Approvals, Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import type { LocationFacts, MasterDataRefs } from '../../mdm';
import {
  CANCELLABLE,
  checkCounts,
  checkTakeScope,
  lineVariance,
  needsRecount,
  SCOPE_HOLDING,
  scopesOverlap,
  unfinishedLines,
  varianceTotals,
  varianceValue,
  type CountedLine,
  type StockTakeScope,
  type StockTakeStatus,
  type VarianceDirection,
} from '../domain/stock-take';
import type { CostPool } from '../domain/valuation/cost-pool';
import { pageProbe } from './counting';
import { InvReferenceNotFoundError, StockTakeInvalidError, StockTakeNotCountedError } from './errors';
import type { Stock } from './stock';
import { locationRef, principalRef, productRef, readScopes, runStockCommand, unitRef, type ApprovalPendingView, type LocationRefView, type Page, type StockUnitRefView } from './stock-command';
import type { StockDocumentsStore } from './stock-documents-store';
import type { StockTakeFilters, StockTakeLineRecord, StockTakeRecord, StockTakeStore, VarianceTotalsRecord } from './stock-take-store';
import type { WeightSource } from './stock-store';

export const STOCK_TAKE_WRITE_OFF = 'STOCK_WRITE_OFF';
/** A weight typed on a count was entered by a person (A-141): the contract's count carries no source. */
const COUNT_WEIGHT_SOURCE: WeightSource = 'MANUAL';
/** The reasons a stock-take variance is posted with (A-141): the count found the book figure wrong either way. */
const LOSS_REASON = 'COUNT_ERROR';
const GAIN_REASON = 'FOUND_STOCK';
/** The statuses in which another take of the location is counting the same stock (the database's rule, migration 0054). */
const COUNTING_NOW: readonly StockTakeStatus[] = ['COUNTING', 'REVIEW', 'PENDING_APPROVAL'];
/** The reason a take whose variances were refused is closed with. */
const REJECTED_REASON = 'The variances were not approved';

export interface StockTakeCreateRequest {
  readonly locationId: string;
  readonly scope: StockTakeScope;
  readonly productIds?: readonly string[] | undefined;
}

export interface StockTakeCountsRequest {
  readonly counts: ReadonlyArray<{ readonly lineId: string; readonly countedQty: string; readonly countedWeightKg?: string | undefined; readonly isRecount?: boolean | undefined }>;
}

/** The contract's `StockTake`. */
export interface StockTakeView {
  readonly id: string;
  readonly stockTakeNo: string | null;
  readonly status: StockTakeStatus;
  readonly location: LocationRefView;
  readonly scope: StockTakeScope;
  readonly snapshotAt: string | null;
  readonly countedBy: PrincipalRef | null;
  readonly lineCount: number;
  readonly countedLineCount: number;
  readonly gainValuePesewas: number | null;
  readonly lossValuePesewas: number | null;
  readonly currency: 'GHS';
  readonly approvalRequestId: string | null;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: PrincipalRef;
  readonly postedAt: string | null;
  readonly postedBy: PrincipalRef | null;
}

/** The contract's `StockTakeLine`: the expected figure and the variance are hidden until counting closes. */
export interface StockTakeLineView {
  readonly id: string;
  readonly product: { readonly id: string; readonly sku: string; readonly name: string };
  readonly stockUnit: StockUnitRefView | null;
  readonly uom: string;
  readonly expectedQty: string | null;
  readonly countedQty: string | null;
  readonly recountQty: string | null;
  readonly countedWeightKg: string | null;
  readonly varianceQty: string | null;
  readonly varianceValuePesewas: number | null;
  readonly varianceDirection: VarianceDirection | null;
  readonly needsRecount: boolean;
}

/** While the count is blind (FR-INV-013): nobody reads the expected figure before counting is closed (A-141). */
const BLIND: ReadonlySet<StockTakeStatus> = new Set(['DRAFT', 'COUNTING']);

const countedLine = (l: StockTakeLineRecord): CountedLine => ({
  expected: Quantity.parse(l.expectedQty),
  counted: l.countedQty === null ? null : Quantity.parse(l.countedQty),
  recount: l.recountQty === null ? null : Quantity.parse(l.recountQty),
});

/**
 * Stock takes and cycle counts (FR-INV-013, FR-INV-014, threat model "a count used to hide a shortage"). A take is
 * planned for one location, of everything there or of listed products; no other take of that location may share a
 * product while it is open. Starting it freezes every balance in scope as a line's expected figure, which nobody
 * reads until counting closes, so the count is blind. Closing counting values each variance from its cost pool and
 * asks for a recount of every line that differs; submitting values them again and posts a `STOCKTAKE_GAIN` or
 * `STOCKTAKE_LOSS` per variance through `Stock.postIn`, or, at or above the `STOCK_WRITE_OFF` threshold, waits for a
 * different person, and stock is unchanged until they approve. Every write is scoped to the take's location,
 * serializable, idempotent and audited.
 */
export class StockTakes implements ApprovalHandler {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: StockTakeStore,
    private readonly documentsStore: StockDocumentsStore,
    private readonly refs: MasterDataRefs,
    private readonly stock: Stock,
    private readonly authoriser: Authoriser,
    private readonly approvals: Approvals,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly documents: DocumentRegistry,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, filters: StockTakeFilters, cursor: string | undefined, limit: number): Promise<Page<StockTakeView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'inv.stock_take.read');
      const scopes = readScopes(await this.authoriser.scopes(tx, actor!, 'inv.stock_take.read'));
      const binding = { operationId: 'listStockTakes', principalId: actor!.principalId, filters: { ...filters } };
      const after = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.takes(tx, filters, scopes, after, pageProbe(limit));
      const data = found.slice(0, limit);
      const last = data.at(-1);
      const hasMore = found.length > limit;
      return { data: await this.views(tx, data), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  get(actor: Actor | undefined, id: string): Promise<StockTakeView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const record = await this.readable(tx, actor, id);
      return (await this.views(tx, [record]))[0]!;
    });
  }

  /** The lines and, once counting is closed, the variance report: expected, counted, variance quantity and value. */
  listLines(actor: Actor | undefined, id: string, cursor: string | undefined, limit: number): Promise<Page<StockTakeLineView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const record = await this.readable(tx, actor, id);
      const binding = { operationId: 'listStockTakeLines', principalId: actor!.principalId, filters: { id } };
      const after = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.linesPage(tx, id, after, pageProbe(limit));
      const data = found.slice(0, limit);
      const last = data.at(-1);
      const hasMore = found.length > limit;
      return { data: await this.lineViews(tx, record.status, data), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  create(actor: Actor | undefined, body: StockTakeCreateRequest, idempotencyKey: string): Promise<StoredResponse<StockTakeView>> {
    return this.command(actor, 'inv.stock_take.create', 'createStockTake', body, idempotencyKey, body.locationId, async (tx) => ({ status: 201, body: await this.createIn(tx, actor!, body) }));
  }

  /** Plans a take in the caller's transaction, every rule of createStockTake applied and audited. */
  async createIn(tx: Transaction, actor: Actor, body: StockTakeCreateRequest): Promise<StockTakeView> {
    const location = (await this.refs.locationsIn(tx, [body.locationId])).get(body.locationId);
    if (location === undefined) throw new InvReferenceNotFoundError(['/locationId']);
    const productIds = body.productIds ?? [];
    const products = await this.refs.productsIn(tx, productIds);
    const missing = productIds.flatMap((p, index) => (products.has(p) ? [] : [`/productIds/${index}`]));
    if (missing.length > 0) throw new InvReferenceNotFoundError(missing);
    const broken = checkTakeScope({ location, scope: body.scope, products: productIds.map((p) => ({ id: p, product: products.get(p)! })) });
    if (broken.length > 0) throw new StockTakeInvalidError(broken);
    await this.refuseOverlap(tx, { locationId: location.id, scope: body.scope, productIds }, [...SCOPE_HOLDING], null);

    const id = this.nextId();
    await this.documents.register(tx, { id, docType: 'STOCK_TAKE', ownerModule: 'inv', branchId: location.branchId, actorId: actor.principalId });
    await this.store.insertTake(tx, { id, locationId: location.id, scope: body.scope, branchId: location.branchId }, actor.principalId);
    await this.store.insertTakeProducts(tx, id, [...new Set(productIds)]);
    const view = await this.view(tx, id);
    await this.audit.record(tx, { module: 'inv', action: 'CREATE', entityType: 'StockTake', entityId: id, branchId: location.branchId, before: null, after: { ...view, productIds } });
    return view;
  }

  start(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<StockTakeView>> {
    return this.command(actor, 'inv.stock_take.create', 'startStockTake', { id }, idempotencyKey, id, async (tx) => ({ status: 200, body: await this.startIn(tx, actor!, id) }));
  }

  /** Freezes every balance in scope as its line's expected figure, then opens counting (FR-INV-013). */
  async startIn(tx: Transaction, actor: Actor, id: string): Promise<StockTakeView> {
    const before = await this.locked(tx, id, ['DRAFT']);
    await this.refuseOverlap(tx, { locationId: before.locationId, scope: before.scope, productIds: before.productIds }, COUNTING_NOW, id);
    const balances = await this.store.balancesInScope(tx, before.locationId, before.scope === 'FULL' ? null : before.productIds);
    const covered = new Set(balances.map((b) => b.productId));
    const products = await this.refs.productsIn(tx, before.productIds);
    for (const balance of balances) {
      await this.store.insertLine(tx, id, { id: this.nextId(), productId: balance.productId, stockUnitId: balance.stockUnitId, expectedQty: balance.onHandQty });
    }
    // A listed loose product with nothing on hand is still counted, from zero: the count may find some (A-141).
    for (const productId of before.productIds) {
      if (!covered.has(productId) && products.get(productId)?.tracking === 'NONE') {
        await this.store.insertLine(tx, id, { id: this.nextId(), productId, stockUnitId: null, expectedQty: '0.000' });
      }
    }
    try {
      await this.store.markStarted(tx, id, this.clock.now(), actor.principalId);
    } catch (error) {
      const failure: Partial<DatabaseErrorFields> = databaseErrorOf(error) ?? {};
      if (failure.code === 'HK010' && failure.constraint === 'ck_stock_take_overlap') {
        throw new StockTakeInvalidError([{ field: '/id', rule: 'SCOPE_OVERLAP' }]);
      }
      throw error;
    }
    return this.audited(tx, 'START', before);
  }

  recordCounts(actor: Actor | undefined, id: string, body: StockTakeCountsRequest, idempotencyKey: string): Promise<StoredResponse<StockTakeView>> {
    return this.command(actor, 'inv.stock_take.count', 'recordStockTakeCounts', { id, ...body }, idempotencyKey, id, async (tx) => ({ status: 200, body: await this.recordCountsIn(tx, actor!, id, body) }));
  }

  /** First counts while counting, as often as the counter corrects them; in review, the recount of a line that differs. */
  async recordCountsIn(tx: Transaction, actor: Actor, id: string, body: StockTakeCountsRequest): Promise<StockTakeView> {
    const before = await this.locked(tx, id, ['COUNTING', 'REVIEW']);
    const lines = new Map((await this.store.lines(tx, id)).map((l) => [l.id, l] as const));
    const broken = checkCounts(
      before.status,
      body.counts.map((c) => ({ lineId: c.lineId, isRecount: c.isRecount ?? false })),
      new Map([...lines].map(([lineId, l]) => [lineId, countedLine(l)] as const)),
    );
    if (broken.length > 0) throw new StockTakeInvalidError(broken);
    if (before.status === 'COUNTING') {
      for (const count of body.counts) {
        await this.store.setCount(tx, count.lineId, {
          qty: Quantity.parse(count.countedQty).toDecimalString(),
          weightKg: count.countedWeightKg === undefined ? null : Weight.parseKg(count.countedWeightKg).toKgString(),
          weightSource: count.countedWeightKg === undefined ? null : COUNT_WEIGHT_SOURCE,
        });
      }
      await this.store.touchCounting(tx, id, actor.principalId);
    } else {
      for (const count of body.counts) {
        const line = lines.get(count.lineId)!;
        const recount = Quantity.parse(count.countedQty);
        const variance = lineVariance({ ...countedLine(line), recount })!;
        await this.store.setRecount(tx, line.id, recount.toDecimalString(), { qty: variance.qty.toDecimalString(), valuePesewas: (await this.valueOf(tx, before.branchId, line, variance.qty)).pesewas });
      }
      await this.store.setTotals(tx, id, this.totalsOf(await this.store.lines(tx, id)), actor.principalId);
    }
    return this.audited(tx, before.status === 'COUNTING' ? 'COUNT' : 'RECOUNT', before, { counts: body.counts.map((c) => ({ ...c })) });
  }

  close(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<StockTakeView>> {
    return this.command(actor, 'inv.stock_take.count', 'closeStockTakeCounting', { id }, idempotencyKey, id, async (tx) => ({ status: 200, body: await this.closeIn(tx, actor!, id) }));
  }

  /** Closes counting once every line is counted, and values each variance: the variance report. */
  async closeIn(tx: Transaction, actor: Actor, id: string): Promise<StockTakeView> {
    const before = await this.locked(tx, id, ['COUNTING']);
    const lines = await this.store.lines(tx, id);
    const uncounted = unfinishedLines('COUNTING', lines.map((l) => ({ id: l.id, ...countedLine(l) })));
    if (uncounted.length > 0) throw new StockTakeNotCountedError(uncounted);
    const valued = await this.valueLines(tx, before.branchId, lines);
    await this.store.markReview(tx, id, this.totalsOf(valued), actor.principalId);
    for (const line of valued) {
      await this.store.setVariance(tx, line.id, { qty: line.varianceQty!, valuePesewas: line.varianceValuePesewas! });
    }
    return this.audited(tx, 'CLOSE_COUNTING', before);
  }

  submit(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<StockTakeView | ApprovalPendingView>> {
    return this.command(actor, 'inv.stock_take.post', 'submitStockTake', { id }, idempotencyKey, id, (tx) => this.submitIn(tx, actor!, id));
  }

  /** Values the variances again, against the pools as they are now, and posts them or asks for approval. */
  async submitIn(tx: Transaction, actor: Actor, id: string): Promise<StoredResponse<StockTakeView | ApprovalPendingView>> {
    const before = await this.locked(tx, id, ['REVIEW']);
    const unfinished = unfinishedLines('REVIEW', (await this.store.lines(tx, id)).map((l) => ({ id: l.id, ...countedLine(l) })));
    if (unfinished.length > 0) throw new StockTakeNotCountedError(unfinished);
    for (const line of await this.valueLines(tx, before.branchId, await this.store.lines(tx, id))) {
      await this.store.setVariance(tx, line.id, { qty: line.varianceQty!, valuePesewas: line.varianceValuePesewas! });
    }
    const lines = await this.store.lines(tx, id);
    const totals = this.totalsOf(lines);
    const judgement = await this.approvals.judgeIn(tx, STOCK_TAKE_WRITE_OFF, before.branchId, totals.totalPesewas);
    const location = (await this.refs.locationsIn(tx, [before.locationId])).get(before.locationId)!;
    const now = this.clock.now();
    if (judgement.required) {
      const summary = `Post the stock take of ${location.code}: gains ${totals.gainPesewas} and losses ${totals.lossPesewas} pesewas`;
      const request = await this.approvals.request(tx, actor, {
        kind: STOCK_TAKE_WRITE_OFF,
        branchId: before.branchId,
        subjectDocumentId: id,
        payloadHash: takeHash(before, lines),
        amountPesewas: totals.totalPesewas,
        summary,
      });
      await this.store.markJudged(tx, id, { status: 'PENDING_APPROVAL', totals, thresholdPesewas: judgement.thresholdPesewas, approvalRequestId: request.id, at: now }, actor.principalId);
      await this.audit.record(tx, {
        module: 'inv',
        action: 'SUBMIT',
        entityType: 'StockTake',
        entityId: id,
        branchId: before.branchId,
        before: { status: 'REVIEW' },
        after: { status: 'PENDING_APPROVAL', approvalRequestId: request.id, varianceValuePesewas: totals.totalPesewas, thresholdPesewas: judgement.thresholdPesewas },
      });
      return {
        status: 202,
        body: { status: 'PENDING_APPROVAL', approvalRequestId: request.id, kind: STOCK_TAKE_WRITE_OFF, subject: { id, docType: 'STOCK_TAKE', number: null }, summary, requestedAt: request.requestedAt.toISOString() },
      };
    }
    await this.postLines(tx, actor.principalId, before, lines, location);
    await this.store.markJudged(tx, id, { status: 'POSTED', totals, thresholdPesewas: judgement.thresholdPesewas, approvalRequestId: null, at: now }, actor.principalId);
    return { status: 200, body: await this.audited(tx, 'POST', before) };
  }

  cancel(actor: Actor | undefined, id: string, body: { readonly reason: string }, idempotencyKey: string): Promise<StoredResponse<StockTakeView>> {
    return this.command(actor, 'inv.stock_take.create', 'cancelStockTake', { id, ...body }, idempotencyKey, id, async (tx) => {
      const before = await this.locked(tx, id, [...CANCELLABLE]);
      await this.store.markCancelled(tx, id, body.reason, actor!.principalId);
      return { status: 200, body: await this.audited(tx, 'CANCEL', before, { reason: body.reason }) };
    });
  }

  /** ApprovalHandler: the take's variances valued against the pools as they are now; a pool that moved voids it. */
  async currentPayloadHash(tx: Transaction, subjectDocumentId: string): Promise<string> {
    const record = await this.store.take(tx, subjectDocumentId);
    if (record === null) throw new NotFoundError(`no stock take ${subjectDocumentId}`);
    return takeHash(record, await this.valueLines(tx, record.branchId, await this.store.lines(tx, subjectDocumentId)));
  }

  /** ApprovalHandler: posts the variances in the approval's transaction, as the checker who let it happen. */
  async onApproved(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const before = await this.locked(tx, request.subjectDocumentId, ['PENDING_APPROVAL']);
    const location = (await this.refs.locationsIn(tx, [before.locationId])).get(before.locationId)!;
    await this.postLines(tx, request.decidedBy!, before, await this.store.lines(tx, before.id), location);
    await this.store.markPosted(tx, before.id, this.clock.now(), request.decidedBy!);
    await this.audited(tx, 'POST', before, { approvalRequestId: request.id });
  }

  /** ApprovalHandler: refused or withdrawn variances close the take; nothing moved, and a new take counts again. */
  async onRejected(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const before = await this.locked(tx, request.subjectDocumentId, ['PENDING_APPROVAL']);
    await this.store.markCancelled(tx, before.id, REJECTED_REASON, request.decidedBy ?? request.requestedBy);
    await this.audited(tx, 'REJECT', before, { approvalRequestId: request.id, decision: request.status });
  }

  /** One movement per variance through `Stock.postIn`: a loss to the branch's LOSS, a gain from its ADJUSTMENT. */
  private async postLines(tx: Transaction, actorId: string, take: StockTakeRecord, lines: readonly StockTakeLineRecord[], location: LocationFacts): Promise<void> {
    const loss = await this.refs.virtualLocationIn(tx, location.branchId, 'LOSS');
    const gain = await this.refs.virtualLocationIn(tx, location.branchId, 'ADJUSTMENT');
    if (loss === null || gain === null) throw new Error(`branch ${location.branchId} lacks its virtual LOSS or ADJUSTMENT location; every branch is created with them (ADR-0042)`);
    const now = this.clock.now();
    for (const line of lines) {
      const variance = Quantity.parse(line.varianceQty!);
      if (variance.isZero()) continue;
      const isLoss = variance.isNegative();
      const value = Money.ofPesewas(line.varianceValuePesewas!);
      const posted = await this.stock.postIn(tx, actorId, {
        movementType: isLoss ? 'STOCKTAKE_LOSS' : 'STOCKTAKE_GAIN',
        productId: line.productId,
        stockUnitId: line.stockUnitId,
        branchId: location.branchId,
        fromLocationId: isLoss ? location.id : gain,
        toLocationId: isLoss ? loss : location.id,
        qty: isLoss ? variance.negated() : variance,
        value,
        costElement: !isLoss && value.pesewas > 0n ? 'PURCHASE' : null,
        reasonCode: isLoss ? LOSS_REASON : GAIN_REASON,
        sourceDocumentId: take.id,
        sourceLineRef: line.id,
        occurredAt: now,
      });
      await this.store.setLineMovement(tx, line.id, posted.id);
    }
  }

  /** Each line's variance from its final count, valued from its pool now. */
  private async valueLines(tx: Transaction, branchId: string, lines: readonly StockTakeLineRecord[]): Promise<StockTakeLineRecord[]> {
    const valued: StockTakeLineRecord[] = [];
    for (const line of lines) {
      const variance = lineVariance(countedLine(line))!;
      valued.push({ ...line, varianceQty: variance.qty.toDecimalString(), varianceValuePesewas: (await this.valueOf(tx, branchId, line, variance.qty)).pesewas });
    }
    return valued;
  }

  private async valueOf(tx: Transaction, branchId: string, line: StockTakeLineRecord, variance: Quantity): Promise<Money> {
    const unit = line.stockUnitId === null ? undefined : (await this.documentsStore.units(tx, [line.stockUnitId])).get(line.stockUnitId);
    const row = await this.documentsStore.pool(tx, line.productId, line.stockUnitId, unit?.branchId ?? branchId);
    const pool: CostPool = row === null ? { qty: Quantity.zero(), value: Money.zero() } : { qty: Quantity.parse(row.qty), value: Money.ofPesewas(row.valuePesewas) };
    return varianceValue(pool, variance);
  }

  private totalsOf(lines: readonly StockTakeLineRecord[]): VarianceTotalsRecord {
    const totals = varianceTotals(
      lines.flatMap((l) => {
        const variance = lineVariance(countedLine(l));
        return variance === null || l.varianceValuePesewas === null ? [] : [{ direction: variance.direction, value: Money.ofPesewas(l.varianceValuePesewas) }];
      }),
    );
    return { gainPesewas: totals.gain.pesewas, lossPesewas: totals.loss.pesewas, totalPesewas: totals.total.pesewas };
  }

  private async refuseOverlap(tx: Transaction, claim: { readonly locationId: string; readonly scope: StockTakeScope; readonly productIds: readonly string[] }, statuses: readonly StockTakeStatus[], exceptId: string | null): Promise<void> {
    const others = await this.store.claimsAt(tx, claim.locationId, statuses, exceptId);
    if (others.some((other) => scopesOverlap(claim, other))) throw new StockTakeInvalidError([{ field: exceptId === null ? '/productIds' : '/id', rule: 'SCOPE_OVERLAP' }]);
  }

  /** The shared steps of every write, scoped to the take's location (or the location a new take names). */
  private command<T>(
    actor: Actor | undefined,
    permission: string,
    operationId: string,
    request: object,
    idempotencyKey: string,
    subject: string,
    work: (tx: Transaction) => Promise<StoredResponse<T>>,
  ): Promise<StoredResponse<T>> {
    return runStockCommand(this.uow, this.authoriser, this.idempotency, actor, permission, operationId, request, idempotencyKey, async (tx) => {
      if (operationId === 'createStockTake') {
        const location = (await this.refs.locationsIn(tx, [subject])).get(subject);
        return location === undefined ? {} : { branchId: location.branchId, locationId: location.id };
      }
      const record = await this.store.take(tx, subject);
      return record === null ? {} : { branchId: record.branchId, locationId: record.locationId };
    }, work);
  }

  private async readable(tx: Transaction, actor: Actor | undefined, id: string): Promise<StockTakeRecord> {
    const record = await this.store.take(tx, id);
    await this.authoriser.authorise(tx, actor, 'inv.stock_take.read', record === null ? {} : { branchId: record.branchId, locationId: record.locationId });
    if (record === null) throw new NotFoundError(`no stock take ${id}`);
    return record;
  }

  private async locked(tx: Transaction, id: string, statuses: readonly StockTakeStatus[]): Promise<StockTakeRecord> {
    const state = await this.store.lockTake(tx, id);
    if (state === null) throw new NotFoundError(`no stock take ${id}`);
    if (!statuses.includes(state.status)) throw new InvalidStateTransitionError(`stock take ${id} is ${state.status}`);
    return (await this.store.take(tx, id))!;
  }

  private async audited(tx: Transaction, action: string, before: StockTakeRecord, extra: Record<string, unknown> = {}): Promise<StockTakeView> {
    const beforeView = (await this.views(tx, [before]))[0]!;
    const view = await this.view(tx, before.id);
    await this.audit.record(tx, { module: 'inv', action, entityType: 'StockTake', entityId: before.id, branchId: before.branchId, before: { ...beforeView }, after: { ...view, ...extra } });
    return view;
  }

  private async view(tx: Transaction, id: string): Promise<StockTakeView> {
    return (await this.views(tx, [(await this.store.take(tx, id))!]))[0]!;
  }

  private async views(tx: Transaction, records: readonly StockTakeRecord[]): Promise<StockTakeView[]> {
    const locations = await this.refs.locationsIn(tx, records.map((r) => r.locationId));
    const names = await this.principals.refs(
      tx,
      records.flatMap((r) => [r.createdBy, ...(r.postedBy === null ? [] : [r.postedBy]), ...(r.countedBy === null ? [] : [r.countedBy])]),
    );
    const pesewas = (value: bigint | null): number | null => (value === null ? null : Money.ofPesewas(value).toJsonInteger());
    return records.map((r) => ({
      id: r.id,
      stockTakeNo: r.stockTakeNo,
      status: r.status,
      location: locationRef(locations.get(r.locationId)!),
      scope: r.scope,
      snapshotAt: r.snapshotAt?.toISOString() ?? null,
      countedBy: r.countedBy === null ? null : principalRef(names, r.countedBy),
      lineCount: r.lineCount,
      countedLineCount: r.countedLineCount,
      gainValuePesewas: pesewas(r.gainValuePesewas),
      lossValuePesewas: pesewas(r.lossValuePesewas),
      currency: 'GHS',
      approvalRequestId: r.approvalRequestId,
      branchId: r.branchId,
      version: r.version,
      createdAt: r.createdAt.toISOString(),
      createdBy: principalRef(names, r.createdBy),
      postedAt: r.postedAt?.toISOString() ?? null,
      postedBy: r.postedBy === null ? null : principalRef(names, r.postedBy),
    }));
  }

  private async lineViews(tx: Transaction, status: StockTakeStatus, lines: readonly StockTakeLineRecord[]): Promise<StockTakeLineView[]> {
    const products = await this.refs.productsIn(tx, lines.map((l) => l.productId));
    const units = await this.documentsStore.units(tx, lines.flatMap((l) => (l.stockUnitId === null ? [] : [l.stockUnitId])));
    const blind = BLIND.has(status);
    return lines.map((l) => {
      const product = products.get(l.productId)!;
      const variance = blind || l.varianceQty === null ? null : lineVariance(countedLine(l));
      return {
        id: l.id,
        product: productRef(product),
        stockUnit: l.stockUnitId === null ? null : unitRef(units.get(l.stockUnitId)),
        uom: product.baseUom,
        expectedQty: blind ? null : l.expectedQty,
        countedQty: l.countedQty,
        recountQty: l.recountQty,
        countedWeightKg: l.countedWeightKg,
        varianceQty: variance === null ? null : l.varianceQty,
        varianceValuePesewas: variance === null || l.varianceValuePesewas === null ? null : Money.ofPesewas(l.varianceValuePesewas).toJsonInteger(),
        varianceDirection: variance?.direction ?? null,
        needsRecount: needsRecount(status, countedLine(l)),
      };
    });
  }
}

function takeHash(take: Pick<StockTakeRecord, 'id' | 'locationId' | 'scope'>, lines: readonly StockTakeLineRecord[]): string {
  const payload = {
    id: take.id,
    locationId: take.locationId,
    scope: take.scope,
    lines: lines.map((l) => [l.id, l.productId, l.stockUnitId, l.expectedQty, l.countedQty, l.recountQty, l.varianceQty, l.varianceValuePesewas?.toString() ?? null]),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
