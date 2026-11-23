import { createHash } from 'node:crypto';
import { createUuidV7Generator, Money, Quantity, Weight, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { InvalidStateTransitionError, NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { ApprovalHandler, ApprovalRecord, Approvals, Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import type { LocationFacts, MasterDataRefs } from '../../mdm';
import { checkAdjustmentLines, type AdjustmentDirection, type StockRuleBroken } from '../domain/stock-documents';
import { isHeldVariance } from '../domain/stock-exception';
import { issue, valueAtAverage, type CostPool } from '../domain/valuation/cost-pool';
import { ordinal, pageProbe } from './counting';
import { InvReferenceNotFoundError, StockAdjustmentInvalidError } from './errors';
import type { Stock } from './stock';
import { locationRef, principalRef, productRef, readScopes, runStockCommand, unitRef, type ApprovalPendingView, type LocationRefView, type Page, type StockUnitRefView } from './stock-command';
import type { AdjustmentFilters, AdjustmentLineRecord, AdjustmentRecord, AdjustmentStatus, StockDocumentsStore } from './stock-documents-store';
import type { WeightSource } from './stock-store';

export const STOCK_WRITE_OFF = 'STOCK_WRITE_OFF';
/** The reasons an adjustment takes (the contract: "from the fixed list for STOCK_ADJUSTMENT or WASTAGE"). */
const ADJUSTMENT_REASON_DOMAINS: ReadonlySet<string> = new Set(['STOCK_ADJUSTMENT', 'WASTAGE']);
const NOT_ADJUSTED_AT: ReadonlySet<string> = new Set(['IN_TRANSIT', 'SITE']);
/** A weight typed on an adjustment line was entered by a person (A-139): the contract's line carries no source. */
const ADJUSTMENT_WEIGHT_SOURCE: WeightSource = 'MANUAL';

export interface AdjustmentLineInput {
  readonly productId: string;
  readonly stockUnitId?: string | undefined;
  readonly direction: AdjustmentDirection;
  readonly qty: string;
  readonly weightKg?: string | undefined;
}

export interface AdjustmentCreateRequest {
  readonly locationId: string;
  readonly reasonCode: string;
  readonly note?: string | undefined;
  readonly exceptionId?: string | undefined;
  readonly lines: readonly AdjustmentLineInput[];
}

export interface StockAdjustmentView {
  readonly id: string;
  readonly adjustmentNo: string | null;
  readonly status: AdjustmentStatus;
  readonly location: LocationRefView;
  readonly reasonCode: string;
  readonly note: string | null;
  readonly totalValuePesewas: number;
  readonly currency: 'GHS';
  readonly approvalRequestId: string | null;
  readonly exceptionId: string | null;
  readonly lines: ReadonlyArray<{
    readonly id: string;
    readonly lineNo: number;
    readonly product: { readonly id: string; readonly sku: string; readonly name: string };
    readonly stockUnit: StockUnitRefView | null;
    readonly direction: AdjustmentDirection;
    readonly qty: string;
    readonly uom: string;
    readonly weightKg: string | null;
    readonly valuePesewas: number;
    readonly movementId: string | null;
  }>;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: PrincipalRef;
  readonly postedAt: string | null;
  readonly postedBy: PrincipalRef | null;
}

/**
 * Stock adjustments (FR-INV-012, threat model abuse case "an adjustment used to hide a shortage"). An adjustment is
 * drafted with a reason from the fixed list and its lines, each valued from its cost pool (a loss at what the pool
 * would give up, a gain at the pool's average; never a figure from the request). Submitting values the lines again
 * and judges their total against the `STOCK_WRITE_OFF` policy (seed 50,000 pesewas): below it the adjustment posts at
 * once; at or above it, it waits for a different person holding `inv.adjustment.approve`, and stock is unchanged
 * until they approve. The approval binds to the lines and their values: if a pool moves meanwhile, the approval is
 * void. Animals are never adjusted (A-139). Every write is scoped to the adjustment's location, idempotent and audited.
 */
export class StockAdjustments implements ApprovalHandler {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: StockDocumentsStore,
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

  list(actor: Actor | undefined, filters: AdjustmentFilters, cursor: string | undefined, limit: number): Promise<Page<StockAdjustmentView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'inv.adjustment.read');
      const scopes = readScopes(await this.authoriser.scopes(tx, actor!, 'inv.adjustment.read'));
      const binding = { operationId: 'listStockAdjustments', principalId: actor!.principalId, filters: { ...filters } };
      const after = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.adjustments(tx, filters, scopes, after, pageProbe(limit));
      const data = found.slice(0, limit);
      const last = data.at(-1);
      const hasMore = found.length > limit;
      return { data: await this.views(tx, data), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  get(actor: Actor | undefined, id: string): Promise<StockAdjustmentView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const record = await this.store.adjustment(tx, id);
      await this.authoriser.authorise(tx, actor, 'inv.adjustment.read', record === null ? {} : { branchId: record.branchId, locationId: record.locationId });
      if (record === null) throw new NotFoundError(`no stock adjustment ${id}`);
      return (await this.views(tx, [record]))[0]!;
    });
  }

  create(actor: Actor | undefined, body: AdjustmentCreateRequest, idempotencyKey: string): Promise<StoredResponse<StockAdjustmentView>> {
    return runStockCommand(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      'inv.adjustment.create',
      'createStockAdjustment',
      body,
      idempotencyKey,
      async (tx) => {
        const location = (await this.refs.locationsIn(tx, [body.locationId])).get(body.locationId);
        return location === undefined ? {} : { branchId: location.branchId, locationId: location.id };
      },
      async (tx) => ({ status: 201, body: await this.createIn(tx, actor!, body) }),
    );
  }

  /**
   * Drafts an adjustment in the caller's transaction, every rule of createStockAdjustment applied and audited. Only
   * `StockExceptions` drafts the write-off of a held transfer variance (`forHeldVariance`): the one adjustment made in
   * transit, where the held stock waits (ADR-0048); by hand, a held variance is never named and transit never adjusted.
   */
  async createIn(tx: Transaction, actor: Actor, body: AdjustmentCreateRequest, options: { readonly forHeldVariance?: boolean } = {}): Promise<StockAdjustmentView> {
    const location = (await this.refs.locationsIn(tx, [body.locationId])).get(body.locationId);
    if (location === undefined || !location.isLive) throw new InvReferenceNotFoundError(['/locationId']);
    const broken: StockRuleBroken[] = [];
    const heldWriteOff = options.forHeldVariance === true && location.kind === 'IN_TRANSIT';
    if (!heldWriteOff && (location.isVirtual || NOT_ADJUSTED_AT.has(location.kind))) broken.push({ field: '/locationId', rule: 'NOT_A_STOCK_LOCATION' });
    const reason = (await this.refs.reasonCodesIn(tx, [body.reasonCode])).get(body.reasonCode);
    if (reason === undefined) throw new InvReferenceNotFoundError(['/reasonCode']);
    if (!ADJUSTMENT_REASON_DOMAINS.has(reason.domain)) broken.push({ field: '/reasonCode', rule: 'REASON_NOT_ALLOWED' });
    if (reason.requiresNote && body.note === undefined) broken.push({ field: '/note', rule: 'NOTE_REQUIRED' });
    if (body.exceptionId !== undefined) {
      const exception = await this.store.exceptionState(tx, body.exceptionId);
      if (exception === null) throw new InvReferenceNotFoundError(['/exceptionId']);
      if (exception.status !== 'OPEN' || exception.branchId !== location.branchId) broken.push({ field: '/exceptionId', rule: 'EXCEPTION_NOT_OPEN' });
      else if (isHeldVariance(exception) !== heldWriteOff) broken.push({ field: '/exceptionId', rule: 'RESOLVED_THROUGH_THE_EXCEPTION' });
    }
    broken.push(...(await this.lineRules(tx, location, body.lines)));
    if (broken.length > 0) throw new StockAdjustmentInvalidError(broken);

    const id = this.nextId();
    await this.documents.register(tx, { id, docType: 'STOCK_ADJUSTMENT', ownerModule: 'inv', branchId: location.branchId, actorId: actor.principalId });
    await this.store.insertAdjustment(
      tx,
      { id, locationId: location.id, reasonCode: body.reasonCode, note: body.note ?? null, exceptionId: body.exceptionId ?? null, branchId: location.branchId },
      actor.principalId,
    );
    for (const [index, line] of body.lines.entries()) {
      const draft: AdjustmentLineRecord = {
        id: this.nextId(),
        lineNo: ordinal(index),
        productId: line.productId,
        stockUnitId: line.stockUnitId ?? null,
        direction: line.direction,
        qty: Quantity.parse(line.qty).toDecimalString(),
        weightKg: line.weightKg === undefined ? null : Weight.parseKg(line.weightKg).toKgString(),
        weightSource: line.weightKg === undefined ? null : ADJUSTMENT_WEIGHT_SOURCE,
        valuePesewas: 0n,
        movementId: null,
      };
      await this.store.insertAdjustmentLine(tx, id, { ...draft, valuePesewas: (await this.valueOf(tx, location.branchId, draft)).pesewas });
    }
    const view = await this.view(tx, id);
    await this.audit.record(tx, { module: 'inv', action: 'CREATE', entityType: 'StockAdjustment', entityId: id, branchId: location.branchId, before: null, after: { ...view } });
    return view;
  }

  submit(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<StockAdjustmentView | ApprovalPendingView>> {
    return runStockCommand(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      'inv.adjustment.create',
      'submitStockAdjustment',
      { id },
      idempotencyKey,
      async (tx) => {
        const record = await this.store.adjustment(tx, id);
        return record === null ? {} : { branchId: record.branchId, locationId: record.locationId };
      },
      (tx) => this.submitIn(tx, actor!, id),
    );
  }

  /** An adjustment as the contract shows it, read in the caller's transaction (ORD's van write-off, B11 continued 4); null when none. It authorises nothing. */
  async viewIn(tx: Transaction, id: string): Promise<StockAdjustmentView | null> {
    const record = await this.store.adjustment(tx, id);
    return record === null ? null : (await this.views(tx, [record]))[0]!;
  }

  /** Values a DRAFT again, and posts it or asks for approval, in the caller's serializable transaction. */
  async submitIn(tx: Transaction, actor: Actor, id: string): Promise<StoredResponse<StockAdjustmentView | ApprovalPendingView>> {
    const before = await this.locked(tx, id, 'DRAFT');
    const location = (await this.refs.locationsIn(tx, [before.locationId])).get(before.locationId)!;
    // The rules again, against stock as it is now: a lot may have been sold out, a product archived.
    const broken = await this.lineRules(
      tx,
      location,
      before.lines.map((l) => ({ productId: l.productId, stockUnitId: l.stockUnitId ?? undefined, direction: l.direction, qty: l.qty })),
    );
    if (broken.length > 0) throw new StockAdjustmentInvalidError(broken);
    for (const line of before.lines) {
      await this.store.setAdjustmentLineValue(tx, line.id, (await this.valueOf(tx, before.branchId, line)).pesewas);
    }
    const valued = (await this.store.adjustment(tx, id))!;
    const total = Money.sum(valued.lines.map((l) => Money.ofPesewas(l.valuePesewas)));
    const judgement = await this.approvals.judgeIn(tx, STOCK_WRITE_OFF, before.branchId, total.pesewas);
    const now = this.clock.now();
    if (judgement.required) {
      const summary = `Adjust stock at ${location.code} (${valued.reasonCode}): ${valued.lines.length} line(s) valued ${total.pesewas} pesewas`;
      const request = await this.approvals.request(tx, actor, {
        kind: STOCK_WRITE_OFF,
        branchId: before.branchId,
        subjectDocumentId: id,
        payloadHash: adjustmentHash(valued),
        amountPesewas: total.pesewas,
        summary,
      });
      await this.store.markAdjustmentJudged(
        tx,
        id,
        { status: 'PENDING_APPROVAL', totalValuePesewas: total.pesewas, thresholdPesewas: judgement.thresholdPesewas, approvalRequestId: request.id, at: now },
        actor.principalId,
      );
      await this.audit.record(tx, {
        module: 'inv',
        action: 'SUBMIT',
        entityType: 'StockAdjustment',
        entityId: id,
        branchId: before.branchId,
        before: { status: 'DRAFT' },
        after: { status: 'PENDING_APPROVAL', approvalRequestId: request.id, totalValuePesewas: total.pesewas, thresholdPesewas: judgement.thresholdPesewas },
      });
      return {
        status: 202,
        body: { status: 'PENDING_APPROVAL', approvalRequestId: request.id, kind: STOCK_WRITE_OFF, subject: { id, docType: 'STOCK_ADJUSTMENT', number: null }, summary, requestedAt: request.requestedAt.toISOString() },
      };
    }
    await this.postLines(tx, actor.principalId, valued, location);
    await this.store.markAdjustmentJudged(
      tx,
      id,
      { status: 'POSTED', totalValuePesewas: total.pesewas, thresholdPesewas: judgement.thresholdPesewas, approvalRequestId: null, at: now },
      actor.principalId,
    );
    return { status: 200, body: await this.audited(tx, 'POST', before) };
  }

  /** ApprovalHandler: the adjustment's lines valued against the pools as they are now; a pool that moved voids it. */
  async currentPayloadHash(tx: Transaction, subjectDocumentId: string): Promise<string> {
    const record = await this.store.adjustment(tx, subjectDocumentId);
    if (record === null) throw new NotFoundError(`no stock adjustment ${subjectDocumentId}`);
    const lines = [];
    for (const line of record.lines) {
      lines.push({ ...line, valuePesewas: (await this.valueOf(tx, record.branchId, line)).pesewas });
    }
    return adjustmentHash({ ...record, lines });
  }

  /** ApprovalHandler: posts the adjustment in the approval's transaction, as the checker who let it happen. */
  async onApproved(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const before = await this.locked(tx, request.subjectDocumentId, 'PENDING_APPROVAL');
    const location = (await this.refs.locationsIn(tx, [before.locationId])).get(before.locationId)!;
    await this.postLines(tx, request.decidedBy!, before, location);
    await this.store.markAdjustmentDecided(tx, before.id, 'POSTED', this.clock.now(), request.decidedBy!);
    await this.audited(tx, 'POST', before, { approvalRequestId: request.id });
  }

  /** ApprovalHandler: a rejected or withdrawn adjustment is final; nothing moved. */
  async onRejected(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const before = await this.locked(tx, request.subjectDocumentId, 'PENDING_APPROVAL');
    await this.store.markAdjustmentDecided(tx, before.id, 'REJECTED', this.clock.now(), request.decidedBy ?? request.requestedBy);
    await this.audited(tx, 'REJECT', before, { approvalRequestId: request.id, decision: request.status });
  }

  /**
   * One movement per line through `Stock.postIn`: a loss to the branch's virtual LOSS, a gain from ADJUSTMENT. The
   * write-off of a held transfer variance resolves its exception first, as whoever lets the loss post, because the
   * database keeps held stock in transit until its exception is resolved (`ck_stock_held`, migration 0060).
   */
  private async postLines(tx: Transaction, actorId: string, adjustment: AdjustmentRecord, location: LocationFacts): Promise<void> {
    if (adjustment.exceptionId !== null) {
      const exception = await this.store.exceptionState(tx, adjustment.exceptionId);
      if (exception !== null && isHeldVariance(exception)) {
        await this.store.resolveException(tx, adjustment.exceptionId, { kind: 'WRITE_OFF', note: adjustment.note!, documentId: adjustment.id, at: this.clock.now() }, actorId);
        await this.audit.record(tx, {
          module: 'inv',
          action: 'RESOLVE',
          entityType: 'StockException',
          entityId: adjustment.exceptionId,
          branchId: adjustment.branchId,
          before: { status: 'OPEN' },
          after: { status: 'RESOLVED', resolutionKind: 'WRITE_OFF', resolutionDocumentId: adjustment.id, resolutionNote: adjustment.note },
        });
      }
    }
    const loss = await this.refs.virtualLocationIn(tx, location.branchId, 'LOSS');
    const gain = await this.refs.virtualLocationIn(tx, location.branchId, 'ADJUSTMENT');
    if (loss === null || gain === null) throw new Error(`branch ${location.branchId} lacks its virtual LOSS or ADJUSTMENT location; every branch is created with them (ADR-0042)`);
    const now = this.clock.now();
    for (const line of adjustment.lines) {
      const value = Money.ofPesewas(line.valuePesewas);
      const posted = await this.stock.postIn(tx, actorId, {
        movementType: line.direction === 'LOSS' ? 'ADJUST_LOSS' : 'ADJUST_GAIN',
        productId: line.productId,
        stockUnitId: line.stockUnitId,
        branchId: location.branchId,
        fromLocationId: line.direction === 'LOSS' ? location.id : gain,
        toLocationId: line.direction === 'LOSS' ? loss : location.id,
        qty: Quantity.parse(line.qty),
        weight: line.weightKg === null ? null : { kg: Weight.parseKg(line.weightKg), source: line.weightSource! },
        value,
        costElement: line.direction === 'GAIN' && value.pesewas > 0n ? 'PURCHASE' : null,
        reasonCode: adjustment.reasonCode,
        sourceDocumentId: adjustment.id,
        sourceLineRef: line.id,
        occurredAt: now,
      });
      await this.store.setAdjustmentLineMovement(tx, line.id, posted.id);
    }
  }

  /** A loss at what its pool would give up; a gain at its pool's average (ADR-0018, A-139). */
  private async valueOf(tx: Transaction, branchId: string, line: Pick<AdjustmentLineRecord, 'productId' | 'stockUnitId' | 'direction' | 'qty'>): Promise<Money> {
    const unit = line.stockUnitId === null ? undefined : (await this.store.units(tx, [line.stockUnitId])).get(line.stockUnitId);
    const row = await this.store.pool(tx, line.productId, line.stockUnitId, unit?.branchId ?? branchId);
    const pool: CostPool = row === null ? { qty: Quantity.zero(), value: Money.zero() } : { qty: Quantity.parse(row.qty), value: Money.ofPesewas(row.valuePesewas) };
    const qty = Quantity.parse(line.qty);
    return line.direction === 'LOSS' ? issue(pool, qty).carried : valueAtAverage(pool, qty);
  }

  private async lineRules(tx: Transaction, location: LocationFacts, lines: readonly AdjustmentLineInput[]): Promise<StockRuleBroken[]> {
    const products = await this.refs.productsIn(tx, lines.map((l) => l.productId));
    const units = await this.store.units(tx, lines.flatMap((l) => (l.stockUnitId === undefined ? [] : [l.stockUnitId])));
    const missing = lines.flatMap((l, index) => [
      ...(products.has(l.productId) ? [] : [`/lines/${index}/productId`]),
      ...(l.stockUnitId === undefined || units.has(l.stockUnitId) ? [] : [`/lines/${index}/stockUnitId`]),
    ]);
    if (missing.length > 0) throw new InvReferenceNotFoundError(missing);
    const broken = checkAdjustmentLines(
      lines.map((l) => ({
        productId: l.productId,
        product: products.get(l.productId)!,
        direction: l.direction,
        qty: Quantity.parse(l.qty),
        stockUnitId: l.stockUnitId ?? null,
        unit: l.stockUnitId === undefined ? null : units.get(l.stockUnitId)!,
      })),
    );
    lines.forEach((l, index) => {
      const unit = l.stockUnitId === undefined ? undefined : units.get(l.stockUnitId);
      if (unit !== undefined && unit.branchId !== location.branchId) broken.push({ field: `/lines/${index}/stockUnitId`, rule: 'NOT_IN_THIS_BRANCH' });
    });
    return broken;
  }

  private async locked(tx: Transaction, id: string, status: AdjustmentStatus): Promise<AdjustmentRecord> {
    const state = await this.store.lockAdjustment(tx, id);
    if (state === null) throw new NotFoundError(`no stock adjustment ${id}`);
    if (state.status !== status) throw new InvalidStateTransitionError(`stock adjustment ${id} is ${state.status}`);
    return (await this.store.adjustment(tx, id))!;
  }

  private async audited(tx: Transaction, action: string, before: AdjustmentRecord, extra: Record<string, unknown> = {}): Promise<StockAdjustmentView> {
    const beforeView = (await this.views(tx, [before]))[0]!;
    const view = await this.view(tx, before.id);
    await this.audit.record(tx, { module: 'inv', action, entityType: 'StockAdjustment', entityId: before.id, branchId: before.branchId, before: { ...beforeView }, after: { ...view, ...extra } });
    return view;
  }

  private async view(tx: Transaction, id: string): Promise<StockAdjustmentView> {
    return (await this.views(tx, [(await this.store.adjustment(tx, id))!]))[0]!;
  }

  private async views(tx: Transaction, records: readonly AdjustmentRecord[]): Promise<StockAdjustmentView[]> {
    const lines = records.flatMap((r) => r.lines);
    const products = await this.refs.productsIn(tx, lines.map((l) => l.productId));
    const locations = await this.refs.locationsIn(tx, records.map((r) => r.locationId));
    const units = await this.store.units(tx, lines.flatMap((l) => (l.stockUnitId === null ? [] : [l.stockUnitId])));
    const names = await this.principals.refs(tx, records.flatMap((r) => [r.createdBy, ...(r.postedBy === null ? [] : [r.postedBy])]));
    return records.map((r) => ({
      id: r.id,
      adjustmentNo: r.adjustmentNo,
      status: r.status,
      location: locationRef(locations.get(r.locationId)!),
      reasonCode: r.reasonCode,
      note: r.note,
      totalValuePesewas: Money.sum(r.lines.map((l) => Money.ofPesewas(l.valuePesewas))).toJsonInteger(),
      currency: 'GHS',
      approvalRequestId: r.approvalRequestId,
      exceptionId: r.exceptionId,
      lines: r.lines.map((l) => {
        const product = products.get(l.productId)!;
        return {
          id: l.id,
          lineNo: l.lineNo,
          product: productRef(product),
          stockUnit: l.stockUnitId === null ? null : unitRef(units.get(l.stockUnitId)),
          direction: l.direction,
          qty: l.qty,
          uom: product.baseUom,
          weightKg: l.weightKg,
          valuePesewas: Money.ofPesewas(l.valuePesewas).toJsonInteger(),
          movementId: l.movementId,
        };
      }),
      branchId: r.branchId,
      version: r.version,
      createdAt: r.createdAt.toISOString(),
      createdBy: principalRef(names, r.createdBy),
      postedAt: r.postedAt?.toISOString() ?? null,
      postedBy: r.postedBy === null ? null : principalRef(names, r.postedBy),
    }));
  }
}

function adjustmentHash(record: Pick<AdjustmentRecord, 'locationId' | 'reasonCode' | 'note' | 'exceptionId'> & { readonly lines: readonly AdjustmentLineRecord[] }): string {
  const payload = {
    locationId: record.locationId,
    reasonCode: record.reasonCode,
    note: record.note,
    exceptionId: record.exceptionId,
    lines: record.lines.map((l) => [l.lineNo, l.productId, l.stockUnitId, l.direction, l.qty, l.weightKg, l.valuePesewas.toString()]),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
