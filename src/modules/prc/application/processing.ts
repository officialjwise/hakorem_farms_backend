import { createHash } from 'node:crypto';
import { createUuidV7Generator, Money, Quantity, toBusinessDate, Weight, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { InvalidStateTransitionError, NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { ApprovalHandler, ApprovalRecord, Approvals, Authoriser, PrincipalNames } from '../../iam';
import { StockMovementAlreadyReversedError, StockReversalNotPossibleError, type Lineage, type Stock, type StockMovements, type StockUnitFacts, type StockUnits } from '../../inv';
import type { LocationFacts, MasterDataRefs, PricingService, ProductFacts } from '../../mdm';
import { allocateProcessingCost, type OutputKind, type ProcessingRuleBroken } from '../domain/cost-allocation';
import { checkOutputWeights, judgeYield, type YieldJudgement } from '../domain/yield';
import type { DirectCostIncurred, ProcessingOrderCompleted, ProcessingOrderReversed, ProcessingOrderStarted, YieldVarianceFlagged } from '../events';
import { addDays, ordinal, pageProbe } from './counting';
import { InputOnHoldError, PrcReferenceNotFoundError, ProcessingOrderInvalidError } from './errors';
import type { CostKind, OrderFilters, OrderRecord, OrderStatus, PackRecord, ProcessingStore, ReadScope, ReversalRecord, WeightSource } from './processing-store';

export interface ProcessingInputRequest {
  readonly stockUnitId: string;
  readonly weightKg: string;
  readonly weightSource: WeightSource;
}

export interface ProcessingOrderCreateRequest {
  readonly locationId: string;
  readonly outputLocationId: string;
  readonly inputs: readonly ProcessingInputRequest[];
}

export interface ProcessingOrderUpdateRequest {
  readonly version: number;
  readonly outputLocationId?: string | undefined;
  readonly inputs?: readonly ProcessingInputRequest[] | undefined;
}

export interface ProcessingOutputRequest {
  readonly productId: string;
  readonly outputKind: OutputKind;
  readonly weightKg: string;
  readonly weightSource: WeightSource;
  readonly packCount?: number | undefined;
  readonly expiresOn?: string | undefined;
}

export interface ProcessingCostRequest {
  readonly costKind: CostKind;
  readonly amountPesewas: bigint;
  readonly description: string;
}

interface Ref {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
}

export interface ProcessingOrderView {
  readonly id: string;
  readonly orderNo: string | null;
  readonly status: OrderStatus;
  readonly location: Ref;
  readonly outputLocation: Ref;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly inputs: ReadonlyArray<{
    readonly id: string;
    readonly stockUnit: { readonly id: string; readonly identifier: string; readonly tracking: 'SERIAL' | 'LOT' };
    readonly product: { readonly id: string; readonly sku: string; readonly name: string };
    readonly qty: string;
    readonly uom: string;
    readonly weightKg: string;
    readonly weightSource: WeightSource;
    readonly costPesewas: number | null;
  }>;
  readonly outputs: ReadonlyArray<{
    readonly id: string;
    readonly lineNo: number;
    readonly product: { readonly id: string; readonly sku: string; readonly name: string };
    readonly outputKind: OutputKind;
    readonly stockUnit: { readonly id: string; readonly identifier: string; readonly tracking: 'SERIAL' | 'LOT' } | null;
    readonly weightKg: string;
    readonly weightSource: WeightSource;
    readonly packCount: number | null;
    readonly referencePricePesewasPerKg: number;
    readonly allocationWeight: number;
    readonly allocatedCostPesewas: number;
    readonly expiresOn: string | null;
  }>;
  readonly costs: ReadonlyArray<{ readonly id: string; readonly costKind: CostKind; readonly amountPesewas: number; readonly description: string }>;
  readonly inputWeightKg: string | null;
  readonly outputWeightKg: string | null;
  readonly wasteWeightKg: string | null;
  readonly expectedYieldPercent: string | null;
  readonly actualYieldPercent: string | null;
  readonly yieldVarianceFlag: boolean;
  readonly inputCostPesewas: number | null;
  readonly directCostPesewas: number;
  readonly totalCostPesewas: number | null;
  readonly currency: 'GHS';
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: { readonly id: string; readonly displayName: string };
  readonly postedAt: string | null;
  readonly postedBy: { readonly id: string; readonly displayName: string } | null;
  /** The posted reversal (FR-PRC-011): who asked, when it posted and, at or above the threshold, who approved it. */
  readonly reversal: {
    readonly id: string;
    readonly reason: string;
    readonly reversedAt: string;
    readonly reversedBy: { readonly id: string; readonly displayName: string };
    readonly approvedBy: { readonly id: string; readonly displayName: string } | null;
    readonly approvalRequestId: string | null;
    readonly valuePesewas: number | null;
    readonly thresholdPesewas: number | null;
  } | null;
  /** A reversal waiting for a second approver (B06r): nothing has moved yet. */
  readonly pendingReversal: {
    readonly id: string;
    readonly reason: string;
    readonly requestedAt: string;
    readonly requestedBy: { readonly id: string; readonly displayName: string };
    readonly approvalRequestId: string;
    readonly valuePesewas: number;
    readonly thresholdPesewas: number;
  } | null;
}

/** The contract's `ApprovalPending`. */
export interface ApprovalPendingView {
  readonly status: 'PENDING_APPROVAL';
  readonly approvalRequestId: string;
  readonly kind: string;
  readonly subject: { readonly id: string; readonly docType: string; readonly number: null };
  readonly summary: string;
  readonly requestedAt: string;
}

export interface Page<V> {
  readonly data: readonly V[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

/** The most inputs and outputs one order carries: a day's goats at the slab, every cut of them. */
export const MAX_ORDER_INPUTS = 50;
export const MAX_ORDER_OUTPUTS = 50;
/** Where processing may happen and where its lots may go: a physical location that holds stock, never in transit. */
const NOT_HOLDING: ReadonlySet<string> = new Set(['IN_TRANSIT', 'SITE']);
/** The price an output's relative sales value is read at: the counter's price list for the branch, before promotions (A-153). */
const REFERENCE_CHANNEL = 'POS' as const;
const WEIGHED_BASE_UOM = 'KG';
const CHANGEABLE: ReadonlySet<OrderStatus> = new Set(['PLANNED', 'IN_PROGRESS']);
/** Threat model abuse case 18: a yield shortfall that hides meat taken from the slab. */
const YIELD_ABUSE_CASE = 18;
const UNKNOWN_PRINCIPAL = { id: '', displayName: 'Unknown' };
/** A reversal is judged against the stock adjustment threshold (ADR-0048's write-off rule, owner 2026-11-15). */
const ADJUSTMENT_THRESHOLD_KIND = 'STOCK_WRITE_OFF';
/** The approval a reversal at or above that threshold waits for: a different holder of `prc.order.reverse`, with step-up. */
export const PROCESSING_REVERSAL = 'PROCESSING_REVERSAL';
/** Threat model abuse case 29: a processing reversal used to put a carcass back after its meat has left. */
const REVERSAL_ABUSE_CASE = 29;
/** Packs that have left the cold room, or never will again: once one exists, the order is never reversed. */
const PACKS_GONE: ReadonlySet<string> = new Set(['PICKED', 'SOLD', 'WRITTEN_OFF']);

/** The batch number of an output lot: the order's production date, the tail of its id and the line, unique per product. */
function lotIdentifier(orderId: string, producedOn: string, lineNo: number): string {
  return `PRC-${producedOn.slice(2).replaceAll('-', '')}-${orderId.replaceAll('-', '').slice(-8)}-${String(lineNo).padStart(2, '0')}`;
}

/**
 * Processing orders (FR-PRC-001 to FR-PRC-008, FR-PRC-011; ADR-0018). An order is PLANNED with its input animals,
 * started (IN_PROGRESS) once every input is checked again, given its weighed outputs and direct costs, and completed
 * in one serializable transaction: every input is consumed by a PROCESS_CONSUME movement carrying its whole cost
 * pool, the total (input cost plus direct cost) is split across the saleable outputs by relative sales value with the
 * kernel's `allocate`, each saleable output becomes a new lot received by a PROCESS_OUTPUT movement carrying its
 * allocated cost, lineage links every output to every input, and yield is judged against the standards. A PLANNED or
 * IN_PROGRESS order is cancelled with no stock effect, since nothing moves until completion. Every handler authorises
 * first, scoped to the order's branch and processing location; every write is idempotent and audited.
 */
/** The events PRC publishes that post to the ledger (◆ in docs/DOMAIN_MODEL.md section 5.6), declared for FIN's boot assertion. */
export const PRC_LEDGER_EVENTS = ['prc.DirectCostIncurred', 'prc.ProcessingOrderReversed'] as const;

export class Processing implements ApprovalHandler {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: ProcessingStore,
    private readonly refs: MasterDataRefs,
    private readonly pricing: PricingService,
    private readonly units: StockUnits,
    private readonly stock: Stock,
    private readonly lineage: Lineage,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly documents: DocumentRegistry,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
    private readonly movements: StockMovements,
    private readonly approvals: Approvals,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, filters: OrderFilters, cursor: string | undefined, limit: number): Promise<Page<ProcessingOrderView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'prc.order.read');
      const scopes: ReadScope[] = (await this.authoriser.scopes(tx, actor!, 'prc.order.read')).map((s) => ({ branchId: s.branchId, locationId: s.locationId }));
      const binding = { operationId: 'listProcessingOrders', principalId: actor!.principalId, filters: { ...filters } };
      const after = cursor === undefined ? null : ((this.cursors.decode(cursor, binding)['id'] as string | undefined) ?? null);
      const found = await this.store.orders(tx, filters, scopes, after, pageProbe(limit));
      const data = found.slice(0, limit);
      const last = data.at(-1);
      const hasMore = found.length > limit;
      return {
        data: await this.views(tx, data),
        page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore },
      };
    });
  }

  get(actor: Actor | undefined, id: string): Promise<ProcessingOrderView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const record = await this.store.order(tx, id);
      await this.authoriser.authorise(tx, actor, 'prc.order.read', record === null ? {} : { branchId: record.branchId, locationId: record.locationId });
      if (record === null) throw new NotFoundError(`no processing order ${id}`);
      return (await this.views(tx, [record]))[0]!;
    });
  }

  create(actor: Actor | undefined, body: ProcessingOrderCreateRequest, idempotencyKey: string): Promise<StoredResponse<ProcessingOrderView>> {
    return this.write(
      actor,
      'prc.order.create',
      'createProcessingOrder',
      body,
      idempotencyKey,
      async (tx) => {
        const location = (await this.refs.locationsIn(tx, [body.locationId])).get(body.locationId);
        return location === undefined ? {} : { branchId: location.branchId, locationId: location.id };
      },
      async (tx) => ({ status: 201, body: await this.createIn(tx, actor!, body) }),
    );
  }

  /** Plans an order in the caller's transaction, every rule of createProcessingOrder applied and audited; the caller authorised it. */
  async createIn(tx: Transaction, actor: Actor, body: ProcessingOrderCreateRequest): Promise<ProcessingOrderView> {
    const { location, output } = await this.places(tx, body.locationId, body.outputLocationId);
    const facts = await this.checkInputs(tx, location, body.inputs);
    const id = this.nextId();
    await this.documents.register(tx, { id, docType: 'PROCESSING_ORDER', ownerModule: 'prc', branchId: location.branchId, actorId: actor.principalId });
    await this.store.insertOrder(tx, { id, locationId: location.id, outputLocationId: output.id, branchId: location.branchId }, actor.principalId);
    await this.insertInputs(tx, id, body.inputs, facts);
    const view = await this.view(tx, id);
    await this.audit.record(tx, { module: 'prc', action: 'CREATE', entityType: 'ProcessingOrder', entityId: id, branchId: view.branchId, before: null, after: { ...view } });
    return view;
  }

  update(actor: Actor | undefined, id: string, body: ProcessingOrderUpdateRequest, idempotencyKey: string): Promise<StoredResponse<ProcessingOrderView>> {
    return this.write(actor, 'prc.order.create', 'updateProcessingOrder', { id, ...body }, idempotencyKey, (tx) => this.scopeOf(tx, id), async (tx) => {
      const before = await this.locked(tx, id, ['PLANNED'], body.version);
      const { location, output } = await this.places(tx, before.locationId, body.outputLocationId ?? before.outputLocationId);
      const facts = body.inputs === undefined ? null : await this.checkInputs(tx, location, body.inputs);
      const set: Record<string, unknown> = {};
      if (body.outputLocationId !== undefined) set['output_location_id'] = output.id;
      if (!(await this.store.touch(tx, id, body.version, set, actor!.principalId))) throw new VersionConflictError(`processing order ${id} changed while it was updated`);
      if (body.inputs !== undefined) {
        await this.store.clearInputs(tx, id);
        await this.insertInputs(tx, id, body.inputs, facts!);
      }
      return this.audited(tx, 'UPDATE', before, 200);
    });
  }

  start(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<ProcessingOrderView>> {
    return this.write(actor, 'prc.order.process', 'startProcessingOrder', { id }, idempotencyKey, (tx) => this.scopeOf(tx, id), async (tx) => {
      const before = await this.locked(tx, id, ['PLANNED'], null);
      const { location } = await this.places(tx, before.locationId, before.outputLocationId);
      await this.checkInputs(tx, location, before.inputs);
      const now = this.clock.now();
      await this.store.markStarted(tx, id, now, actor!.principalId);
      await this.events.publish<ProcessingOrderStarted>(tx, {
        type: 'prc.ProcessingOrderStarted',
        subjectType: 'ProcessingOrder',
        subjectId: id,
        branchId: before.branchId,
        occurredAt: now,
        payload: { processingOrderId: id, branchId: before.branchId, locationId: before.locationId, stockUnitIds: before.inputs.map((i) => i.stockUnitId), startedAt: now.toISOString() },
      });
      return this.audited(tx, 'START', before, 200);
    });
  }

  recordOutputs(actor: Actor | undefined, id: string, body: { readonly version: number; readonly outputs: readonly ProcessingOutputRequest[] }, idempotencyKey: string): Promise<StoredResponse<ProcessingOrderView>> {
    return this.write(actor, 'prc.order.process', 'recordProcessingOutputs', { id, ...body }, idempotencyKey, (tx) => this.scopeOf(tx, id), async (tx) => {
      const before = await this.locked(tx, id, ['IN_PROGRESS'], body.version);
      await this.checkOutputs(tx, before, body.outputs);
      if (!(await this.store.touch(tx, id, body.version, {}, actor!.principalId))) throw new VersionConflictError(`processing order ${id} changed while its outputs were recorded`);
      await this.store.clearOutputs(tx, id);
      for (const [index, output] of body.outputs.entries()) {
        await this.store.insertOutput(tx, id, {
          id: this.nextId(),
          lineNo: ordinal(index),
          productId: output.productId,
          outputKind: output.outputKind,
          weightKg: Weight.parseKg(output.weightKg).toKgString(),
          weightSource: output.weightSource,
          packCount: output.packCount ?? null,
          expiresOn: output.expiresOn ?? null,
        });
      }
      return this.audited(tx, 'RECORD_OUTPUTS', before, 200);
    });
  }

  addCost(actor: Actor | undefined, id: string, body: ProcessingCostRequest, idempotencyKey: string): Promise<StoredResponse<ProcessingOrderView>> {
    return this.write(actor, 'prc.order.process', 'addProcessingCost', { id, ...body, amountPesewas: body.amountPesewas.toString() }, idempotencyKey, (tx) => this.scopeOf(tx, id), async (tx) => {
      const before = await this.locked(tx, id, ['PLANNED', 'IN_PROGRESS'], null);
      if (body.amountPesewas === 0n) throw new ProcessingOrderInvalidError([{ field: '/amountPesewas', rule: 'AMOUNT_ZERO' }]);
      const direct = Money.ofPesewas(before.directCostPesewas).plus(Money.ofPesewas(body.amountPesewas));
      await this.store.insertCost(tx, id, { id: this.nextId(), costKind: body.costKind, amountPesewas: body.amountPesewas, description: body.description }, actor!.principalId);
      await this.store.touch(tx, id, before.version, { direct_cost_pesewas: direct.pesewas.toString() }, actor!.principalId);
      return this.audited(tx, 'ADD_COST', before, 201);
    });
  }

  complete(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<ProcessingOrderView>> {
    return this.write(actor, 'prc.order.process', 'completeProcessingOrder', { id }, idempotencyKey, (tx) => this.scopeOf(tx, id), async (tx) => {
      const before = await this.locked(tx, id, ['IN_PROGRESS'], null);
      await this.completeIn(tx, actor!, before);
      return this.audited(tx, 'COMPLETE', before, 200);
    });
  }

  /**
   * Cancels an order not yet completed, with no stock effect; or reverses a COMPLETED one (FR-PRC-011; A-162 as
   * replaced by the owner, B06r), which also needs `prc.order.reverse` at the order's scope. The reversal is valued at
   * the order's total cost, what it takes back out of stock, and judged against the stock adjustment threshold
   * (STOCK_WRITE_OFF), copied onto the reversal and never read live again (ADR-0048): at or above it the reversal waits
   * (202 `ApprovalPending`) for a different holder of `prc.order.reverse` with step-up, and nothing moves until then;
   * below it the maker's reason posts it at once. Either way it is published for the daily exception report. Refused
   * outright while any output is not whole where the order put it, reserved, or packed into a pack that has been
   * picked, sold or written off, in the domain and in the database. The order stays COMPLETED and frozen.
   */
  cancel(actor: Actor | undefined, id: string, body: { readonly reason: string }, idempotencyKey: string): Promise<StoredResponse<ProcessingOrderView | ApprovalPendingView>> {
    return this.write<ProcessingOrderView | ApprovalPendingView>(actor, 'prc.order.create', 'cancelProcessingOrder', { id, ...body }, idempotencyKey, (tx) => this.scopeOf(tx, id), async (tx) => {
      const state = await this.store.lock(tx, id);
      if (state?.status === 'COMPLETED') {
        const order = (await this.store.order(tx, id))!;
        await this.authoriser.authorise(tx, actor, 'prc.order.reverse', { branchId: order.branchId, locationId: order.locationId });
        return this.reverseIn(tx, actor!, order, body.reason);
      }
      const before = await this.locked(tx, id, ['PLANNED', 'IN_PROGRESS'], null);
      await this.store.markCancelled(tx, id, body.reason, actor!.principalId);
      return this.audited(tx, 'CANCEL', before, 200, { reason: body.reason });
    });
  }

  /** ApprovalHandler: the reversal as it would post now; a lot or pack that moved since the request voids the approval. */
  async currentPayloadHash(tx: Transaction, subjectDocumentId: string): Promise<string> {
    const reversal = await this.store.reversal(tx, subjectDocumentId);
    if (reversal === null) throw new NotFoundError(`no processing reversal ${subjectDocumentId}`);
    const order = (await this.store.order(tx, reversal.orderId))!;
    return reversalHash(order, reversal.reason, await this.outputState(tx, order));
  }

  /** ApprovalHandler: posts the waiting reversal in the approval's transaction, as the checker who let it happen. */
  async onApproved(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const reversal = await this.lockedReversal(tx, request.subjectDocumentId);
    await this.store.lock(tx, reversal.orderId);
    const order = (await this.store.order(tx, reversal.orderId))!;
    const packs = await this.checkUnsold(tx, order);
    const approver = request.decidedBy!;
    const now = this.clock.now();
    await this.store.decideReversal(tx, reversal.id, 'POSTED', now, approver);
    await this.postReversalIn(tx, approver, order, (await this.store.reversal(tx, reversal.id))!, packs, now);
    await this.audited(tx, 'REVERSE', order, 200, { reason: reversal.reason, approvalRequestId: request.id, approvedBy: approver });
  }

  /** ApprovalHandler: a rejected or withdrawn reversal is final; nothing moved, and the order may be reversed again. */
  async onRejected(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const reversal = await this.lockedReversal(tx, request.subjectDocumentId);
    const order = (await this.store.order(tx, reversal.orderId))!;
    await this.store.decideReversal(tx, reversal.id, 'REJECTED', this.clock.now(), request.decidedBy ?? request.requestedBy);
    await this.audited(tx, 'REVERSAL_REJECTED', order, 200, { processingReversalId: reversal.id, approvalRequestId: request.id, decision: request.status });
  }

  // Reversal.

  private async reverseIn(tx: Transaction, actor: Actor, order: OrderRecord, reason: string): Promise<StoredResponse<ProcessingOrderView | ApprovalPendingView>> {
    if (order.reversal?.status === 'POSTED') throw new ProcessingOrderInvalidError([{ field: '/id', rule: 'ORDER_REVERSED' }]);
    if (order.reversal?.status === 'PENDING_APPROVAL') throw new ProcessingOrderInvalidError([{ field: '/id', rule: 'REVERSAL_PENDING' }]);
    const packs = await this.checkUnsold(tx, order);
    const value = Money.ofPesewas(order.totalCostPesewas!);
    const judgement = await this.approvals.judgeIn(tx, ADJUSTMENT_THRESHOLD_KIND, order.branchId, value.pesewas);
    const reversalId = this.nextId();
    const now = this.clock.now();
    await this.documents.register(tx, { id: reversalId, docType: 'PROCESSING_REVERSAL', ownerModule: 'prc', branchId: order.branchId, actorId: actor.principalId });
    const base = { id: reversalId, orderId: order.id, branchId: order.branchId, reason, valuePesewas: value.pesewas, thresholdPesewas: judgement.thresholdPesewas, at: now };
    if (judgement.required) {
      const tags = (await this.units.factsIn(tx, order.inputs.map((i) => i.stockUnitId), now));
      const summary = `Reverse the processing of ${order.inputs.map((i) => tags.get(i.stockUnitId)?.identifier ?? i.stockUnitId).join(', ')}, valued ${value.pesewas} pesewas (${reason})`;
      const request = await this.approvals.request(tx, actor, {
        kind: PROCESSING_REVERSAL,
        branchId: order.branchId,
        subjectDocumentId: reversalId,
        payloadHash: reversalHash(order, reason, await this.outputState(tx, order)),
        amountPesewas: value.pesewas,
        summary,
      });
      await this.store.insertReversal(tx, { ...base, status: 'PENDING_APPROVAL', approvalRequestId: request.id }, actor.principalId);
      await this.audited(tx, 'REQUEST_REVERSAL', order, 202, { reason, processingReversalId: reversalId, approvalRequestId: request.id, valuePesewas: value.pesewas.toString(), thresholdPesewas: judgement.thresholdPesewas.toString() });
      return {
        status: 202,
        body: { status: 'PENDING_APPROVAL', approvalRequestId: request.id, kind: PROCESSING_REVERSAL, subject: { id: reversalId, docType: 'PROCESSING_REVERSAL', number: null }, summary, requestedAt: request.requestedAt.toISOString() },
      };
    }
    await this.store.insertReversal(tx, { ...base, status: 'POSTED', approvalRequestId: null }, actor.principalId);
    await this.postReversalIn(tx, actor.principalId, order, (await this.store.reversal(tx, reversalId))!, packs, now);
    return this.audited(tx, 'REVERSE', order, 200, { reason });
  }

  /**
   * Every saleable output whole where the order put it and not reserved, and no pack of it picked, sold or written off;
   * otherwise 422 `OUTPUT_SOLD` (`OUTPUT_RESERVED`) and nothing moves. Answers the order's packs.
   */
  private async checkUnsold(tx: Transaction, order: OrderRecord): Promise<readonly PackRecord[]> {
    const state = await this.outputState(tx, order);
    for (const output of state.outputs) {
      if (!output.whole || output.packsGone) throw new ProcessingOrderInvalidError([{ field: `/outputs/${output.lineNo}`, rule: 'OUTPUT_SOLD' }]);
      if (output.reserved) throw new ProcessingOrderInvalidError([{ field: `/outputs/${output.lineNo}`, rule: 'OUTPUT_RESERVED' }]);
    }
    return state.packs;
  }

  /** Where each saleable output stands now, and the order's packs: what a reversal depends on. */
  private async outputState(tx: Transaction, order: OrderRecord): Promise<OutputState> {
    const saleable = order.outputs.filter((o) => o.stockUnitId !== null);
    const lots = saleable.map((o) => o.stockUnitId!);
    const onHand = await this.units.onHandOfIn(tx, lots);
    const facts = await this.units.factsIn(tx, lots, this.clock.now());
    const packs = await this.store.packsOf(tx, order.id, null, 1_000_000);
    return {
      packs,
      outputs: saleable.map((output) => {
        const lot = output.stockUnitId!;
        const where = onHand.filter((u) => u.id === lot);
        const here = where.filter((u) => u.locationId === order.outputLocationId).map((u) => Weight.parseKg(u.onHandQty));
        return {
          lineNo: output.lineNo,
          lot,
          whole: where.length === here.length && Weight.sum(here).equals(Weight.parseKg(output.weightKg)),
          reserved: facts.get(lot)!.reserved,
          packsGone: packs.some((p) => p.stockUnitId === lot && PACKS_GONE.has(p.status)),
        };
      }),
    };
  }

  /**
   * Reverses every movement the completion posted through INV, the outputs first and then the inputs, each carrying the
   * value it carried, so the animals stand where they stood at the cost they had; the packs become REVERSED; and
   * `prc.ProcessingOrderReversed` carries what B8 posts and the daily exception report (B12) reads.
   */
  private async postReversalIn(tx: Transaction, actorId: string, order: OrderRecord, reversal: ReversalRecord, packs: readonly PackRecord[], now: Date): Promise<void> {
    const saleable = order.outputs.filter((o) => o.stockUnitId !== null);
    try {
      for (const output of saleable) await this.movements.reverseForDocumentIn(tx, actorId, output.movementId!, reversal.id);
      for (const input of order.inputs) await this.movements.reverseForDocumentIn(tx, actorId, input.movementId!, reversal.id);
    } catch (error) {
      if (error instanceof StockReversalNotPossibleError || error instanceof StockMovementAlreadyReversedError) {
        throw new ProcessingOrderInvalidError([{ field: '/id', rule: 'OUTPUT_CHANGED' }]);
      }
      throw error;
    }
    await this.store.setPackStatus(tx, packs.map((p) => p.id), 'REVERSED', actorId);
    const approvedBy = reversal.approvalRequestId === null ? null : actorId;
    await this.events.publish<ProcessingOrderReversed>(tx, {
      type: 'prc.ProcessingOrderReversed',
      subjectType: 'ProcessingOrder',
      subjectId: order.id,
      branchId: order.branchId,
      occurredAt: now,
      payload: {
        processingOrderId: order.id,
        processingReversalId: reversal.id,
        branchId: order.branchId,
        inputCostPesewas: Money.ofPesewas(order.inputCostPesewas!).toJsonInteger(),
        directCostPesewas: Money.ofPesewas(order.directCostPesewas).toJsonInteger(),
        totalCostPesewas: Money.ofPesewas(order.totalCostPesewas!).toJsonInteger(),
        valuePesewas: Money.ofPesewas(reversal.valuePesewas!).toJsonInteger(),
        thresholdPesewas: Money.ofPesewas(reversal.thresholdPesewas!).toJsonInteger(),
        needsApproval: reversal.approvalRequestId !== null,
        approvalRequestId: reversal.approvalRequestId,
        approvedBy,
        processingCostIds: order.costs.map((c) => c.id),
        inputStockUnitIds: order.inputs.map((i) => i.stockUnitId),
        outputStockUnitIds: saleable.map((o) => o.stockUnitId!),
        reason: reversal.reason,
        actorId: reversal.requestedBy,
        reversedAt: now.toISOString(),
        abuseCases: [REVERSAL_ABUSE_CASE],
      },
    });
  }

  private async lockedReversal(tx: Transaction, id: string): Promise<ReversalRecord> {
    const reversal = await this.store.lockReversal(tx, id);
    if (reversal === null) throw new NotFoundError(`no processing reversal ${id}`);
    if (reversal.status !== 'PENDING_APPROVAL') throw new InvalidStateTransitionError(`processing reversal ${id} is ${reversal.status}`);
    return reversal;
  }

  // Completion.

  private async completeIn(tx: Transaction, actor: Actor, order: OrderRecord): Promise<void> {
    const { location, output: outputLocation } = await this.places(tx, order.locationId, order.outputLocationId);
    await this.checkInputs(tx, location, order.inputs);
    const outputs = order.outputs;
    const products = await this.refs.productsIn(tx, [...order.inputs.map((i) => i.productId), ...outputs.map((o) => o.productId)]);
    await this.checkOutputs(tx, order, outputs.map((o) => ({ ...o, packCount: o.packCount ?? undefined, expiresOn: o.expiresOn ?? undefined })));
    const processing = await this.refs.virtualLocationIn(tx, order.branchId, 'PROCESSING');
    if (processing === null) {
      throw new Error(`branch ${order.branchId} has no virtual PROCESSING location; every branch is created with one (ADR-0042)`);
    }
    const now = this.clock.now();

    // 1. Consume every input: each movement carries the unit's whole cost pool, as the trigger decides (ADR-0018).
    let inputCost = Money.zero();
    for (const input of order.inputs) {
      const posted = await this.stock.postIn(tx, actor.principalId, {
        movementType: 'PROCESS_CONSUME',
        productId: input.productId,
        stockUnitId: input.stockUnitId,
        branchId: order.branchId,
        fromLocationId: order.locationId,
        toLocationId: processing,
        qty: Quantity.parse(input.qty),
        weight: { kg: Weight.parseKg(input.weightKg), source: input.weightSource },
        sourceDocumentId: order.id,
        sourceLineRef: input.id,
        occurredAt: now,
      });
      await this.store.setInputConsumed(tx, input.id, posted.value.pesewas, posted.id);
      inputCost = inputCost.plus(posted.value);
    }
    const total = inputCost.plus(Money.ofPesewas(order.directCostPesewas));

    // 2. Reference prices, snapshotted now, and the split of the total by relative sales value.
    const prices = await this.referencePrices(tx, order, outputs);
    const allocation = allocateProcessingCost(
      total,
      outputs.map((o) => ({ lineNo: o.lineNo, kind: o.outputKind, weight: Weight.parseKg(o.weightKg), referencePricePerKg: prices.get(o.lineNo) ?? Money.zero() })),
    );
    if (!allocation.ok) throw new ProcessingOrderInvalidError(allocation.error);

    // 3. Yield against the standards of the input product, when every input is the same product.
    const inputWeight = Weight.sum(order.inputs.map((i) => Weight.parseKg(i.weightKg)));
    const inputProducts = [...new Set(order.inputs.map((i) => i.productId))];
    const standards = inputProducts.length === 1 ? await this.store.standardsOf(tx, inputProducts[0]!) : [];
    const judged = judgeYield(
      inputWeight,
      outputs.map((o) => ({ productId: o.productId, kind: o.outputKind, weight: Weight.parseKg(o.weightKg) })),
      new Map(standards.map((s) => [s.outputProductId, { expectedPercent: s.expectedPercent, tolerancePercent: s.tolerancePercent }])),
    );

    // 4. Receive each saleable output as a new lot at its allocated cost, traced to every input.
    const producedOn = toBusinessDate(now);
    const inputUnits = order.inputs.map((i) => i.stockUnitId);
    for (const [index, output] of outputs.entries()) {
      const allocated = allocation.value[index]!;
      if (output.outputKind === 'WASTE') continue;
      const product = products.get(output.productId)!;
      const expiresOn = output.expiresOn ?? (product.shelfLifeDays === null ? null : addDays(producedOn, product.shelfLifeDays));
      const identifier = lotIdentifier(order.id, producedOn, output.lineNo);
      const weight = Weight.parseKg(output.weightKg);
      const unitId = await this.units.registerLotIn(tx, actor.principalId, {
        productId: output.productId,
        branchId: order.branchId,
        identifier,
        producedOn,
        expiresOn,
        storageTempClass: product.storageTempClass,
        sourceDocumentId: order.id,
        weightKg: weight.toKgString(),
        weighedAt: now,
      });
      const posted = await this.stock.postIn(tx, actor.principalId, {
        movementType: 'PROCESS_OUTPUT',
        productId: output.productId,
        stockUnitId: unitId,
        branchId: order.branchId,
        fromLocationId: processing,
        toLocationId: outputLocation.id,
        qty: Quantity.parse(weight.toKgString()),
        weight: { kg: weight, source: output.weightSource },
        packCount: output.packCount,
        value: allocated.allocated,
        costElement: 'PROCESSING',
        sourceDocumentId: order.id,
        sourceLineRef: output.id,
        occurredAt: now,
      });
      await this.lineage.linkIn(tx, actor.principalId, unitId, inputUnits, 'PROCESSING', order.id);
      await this.store.setOutputCosted(tx, output.id, {
        referencePricePesewasPerKg: prices.get(output.lineNo)!.pesewas,
        allocationWeight: allocated.allocationWeight,
        allocatedCostPesewas: allocated.allocated.pesewas,
        expiresOn,
        stockUnitId: unitId,
        movementId: posted.id,
      });
    }

    // 5. Freeze the order with its sums; the deferred trigger checks them again at commit.
    const saleable = outputs.filter((o) => o.outputKind !== 'WASTE').map((o) => Weight.parseKg(o.weightKg));
    const waste = outputs.filter((o) => o.outputKind === 'WASTE').map((o) => Weight.parseKg(o.weightKg));
    await this.store.markCompleted(
      tx,
      order.id,
      {
        at: now,
        inputWeightKg: inputWeight.toKgString(),
        outputWeightKg: Weight.sum(saleable).toKgString(),
        wasteWeightKg: Weight.sum(waste).toKgString(),
        expectedYieldPercent: judged.expectedPercent,
        actualYieldPercent: judged.actualPercent,
        yieldVarianceFlag: judged.flagged,
        inputCostPesewas: inputCost.pesewas,
        totalCostPesewas: total.pesewas,
      },
      actor.principalId,
    );
    await this.publishCompletion(tx, actor, order, inputCost, total, judged, inputWeight, now);
  }

  private async referencePrices(tx: Transaction, order: OrderRecord, outputs: OrderRecord['outputs']): Promise<Map<number, Money>> {
    const saleable = outputs.filter((o) => o.outputKind !== 'WASTE');
    const prices = new Map<number, Money>();
    if (saleable.length === 0) return prices;
    const resolved = await this.pricing.resolveIn(tx, {
      channel: REFERENCE_CHANNEL,
      branchId: order.branchId,
      at: this.clock.now(),
      lines: saleable.map((o) => ({ lineRef: String(o.lineNo), productId: o.productId, weightKg: o.weightKg, quantity: o.weightKg })),
    });
    const missing: ProcessingRuleBroken[] = [];
    for (const line of resolved.lines) {
      const lineNo = Number(line.lineRef);
      if (line.outcome === 'RESOLVED' && line.resolved !== null && line.resolved.basis === 'PER_KG') {
        prices.set(lineNo, Money.fromJsonInteger(line.resolved.listPricePesewas));
      } else {
        missing.push({ field: `/outputs/${outputs.findIndex((o) => o.lineNo === lineNo)}/referencePricePesewasPerKg`, rule: 'REFERENCE_PRICE_MISSING' });
      }
    }
    if (missing.length > 0) throw new ProcessingOrderInvalidError(missing);
    return prices;
  }

  private async publishCompletion(tx: Transaction, actor: Actor, order: OrderRecord, inputCost: Money, total: Money, judged: YieldJudgement, inputWeight: Weight, now: Date): Promise<void> {
    for (const cost of order.costs) {
      await this.events.publish<DirectCostIncurred>(tx, {
        type: 'prc.DirectCostIncurred',
        subjectType: 'ProcessingOrder',
        subjectId: order.id,
        branchId: order.branchId,
        occurredAt: now,
        payload: { processingOrderId: order.id, processingCostId: cost.id, costKind: cost.costKind, valuePesewas: Money.ofPesewas(cost.amountPesewas).toJsonInteger(), branchId: order.branchId, sourceDocumentId: order.id },
      });
    }
    const completed = (await this.store.order(tx, order.id))!;
    await this.events.publish<ProcessingOrderCompleted>(tx, {
      type: 'prc.ProcessingOrderCompleted',
      subjectType: 'ProcessingOrder',
      subjectId: order.id,
      branchId: order.branchId,
      occurredAt: now,
      payload: {
        processingOrderId: order.id,
        branchId: order.branchId,
        inputCostPesewas: inputCost.toJsonInteger(),
        directCostPesewas: Money.ofPesewas(order.directCostPesewas).toJsonInteger(),
        totalCostPesewas: total.toJsonInteger(),
        inputStockUnitIds: order.inputs.map((i) => i.stockUnitId),
        outputs: completed.outputs.map((o) => ({
          lineNo: o.lineNo,
          outputKind: o.outputKind,
          productId: o.productId,
          stockUnitId: o.stockUnitId,
          weightKg: o.weightKg,
          allocatedCostPesewas: Money.ofPesewas(o.allocatedCostPesewas).toJsonInteger(),
        })),
        yieldVarianceFlag: judged.flagged,
        completedAt: now.toISOString(),
      },
    });
    if (judged.flagged) {
      await this.events.publish<YieldVarianceFlagged>(tx, {
        type: 'prc.YieldVarianceFlagged',
        subjectType: 'ProcessingOrder',
        subjectId: order.id,
        branchId: order.branchId,
        occurredAt: now,
        payload: {
          processingOrderId: order.id,
          branchId: order.branchId,
          actorId: actor.principalId,
          inputWeightKg: inputWeight.toKgString(),
          expectedYieldPercent: judged.expectedPercent!,
          actualYieldPercent: judged.actualPercent!,
          lines: judged.lines,
          abuseCases: [YIELD_ABUSE_CASE],
        },
      });
    }
  }

  // Shared steps.

  private async write<T>(
    actor: Actor | undefined,
    permission: string,
    operationId: string,
    request: object,
    idempotencyKey: string,
    scope: (tx: Transaction) => Promise<{ branchId?: string; locationId?: string }>,
    work: (tx: Transaction) => Promise<StoredResponse<T>>,
  ): Promise<StoredResponse<T>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, permission, await scope(tx));
      const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key: idempotencyKey, request });
      if (claim.kind === 'REPLAY') {
        return claim.response as StoredResponse<T>;
      }
      const response = await work(tx);
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** The branch and processing location a write on an order is scoped to; an unknown order is 404 after the unscoped check. */
  private async scopeOf(tx: Transaction, id: string): Promise<{ branchId?: string; locationId?: string }> {
    const record = await this.store.order(tx, id);
    return record === null ? {} : { branchId: record.branchId, locationId: record.locationId };
  }

  private async locked(tx: Transaction, id: string, statuses: readonly OrderStatus[], version: number | null): Promise<OrderRecord> {
    const state = await this.store.lock(tx, id);
    if (state === null) throw new NotFoundError(`no processing order ${id}`);
    if (!statuses.includes(state.status)) throw new InvalidStateTransitionError(`processing order ${id} is ${state.status}`);
    if (version !== null && state.version !== version) throw new VersionConflictError(`processing order ${id} is at version ${state.version}, not ${version}`);
    return (await this.store.order(tx, id))!;
  }

  private async audited(tx: Transaction, action: string, before: OrderRecord, status: number, extra: Record<string, unknown> = {}): Promise<StoredResponse<ProcessingOrderView>> {
    const beforeView = (await this.views(tx, [before]))[0]!;
    const view = await this.view(tx, before.id);
    await this.audit.record(tx, { module: 'prc', action, entityType: 'ProcessingOrder', entityId: before.id, branchId: view.branchId, before: { ...beforeView }, after: { ...view, ...extra } });
    return { status, body: view };
  }

  private async places(tx: Transaction, locationId: string, outputLocationId: string): Promise<{ location: LocationFacts; output: LocationFacts }> {
    const found = await this.refs.locationsIn(tx, [locationId, outputLocationId]);
    const location = found.get(locationId);
    const output = found.get(outputLocationId);
    const missing = [...(location === undefined || !location.isLive ? ['/locationId'] : []), ...(output === undefined || !output.isLive ? ['/outputLocationId'] : [])];
    if (missing.length > 0) throw new PrcReferenceNotFoundError(missing);
    const broken: ProcessingRuleBroken[] = [];
    if (location!.isVirtual || NOT_HOLDING.has(location!.kind)) broken.push({ field: '/locationId', rule: 'NOT_A_PROCESSING_LOCATION' });
    if (output!.isVirtual || NOT_HOLDING.has(output!.kind)) broken.push({ field: '/outputLocationId', rule: 'NOT_AN_OUTPUT_LOCATION' });
    if (output!.branchId !== location!.branchId) broken.push({ field: '/outputLocationId', rule: 'WRONG_BRANCH' });
    if (locationId === outputLocationId) broken.push({ field: '/outputLocationId', rule: 'SAME_AS_PROCESSING_LOCATION' });
    if (broken.length > 0) throw new ProcessingOrderInvalidError(broken);
    return { location: location!, output: output! };
  }

  /**
   * The inputs, checked now against inventory (FR-PRC-001): each a live animal at the processing location, not sold,
   * consumed or written off, and under no unreleased hold. A hold is refused last, as STOCK_UNIT_ON_HOLD with its end.
   */
  private async checkInputs(tx: Transaction, location: LocationFacts, inputs: readonly ProcessingInputRequest[]): Promise<ReadonlyMap<string, StockUnitFacts>> {
    if (inputs.length === 0) throw new ProcessingOrderInvalidError([{ field: '/inputs', rule: 'NO_INPUTS' }]);
    if (inputs.length > MAX_ORDER_INPUTS) throw new ProcessingOrderInvalidError([{ field: '/inputs', rule: 'TOO_MANY_INPUTS' }]);
    const facts = await this.units.factsIn(tx, inputs.map((i) => i.stockUnitId), this.clock.now());
    const missing = inputs.flatMap((input, index) => (facts.has(input.stockUnitId) ? [] : [`/inputs/${index}/stockUnitId`]));
    if (missing.length > 0) throw new PrcReferenceNotFoundError(missing);
    const broken: ProcessingRuleBroken[] = [];
    const held: Array<{ field: string; identifier: string; kind: string; endsAt: Date | null }> = [];
    const seen = new Set<string>();
    inputs.forEach((input, index) => {
      const unit = facts.get(input.stockUnitId)!;
      const field = `/inputs/${index}/stockUnitId`;
      if (seen.has(input.stockUnitId)) broken.push({ field, rule: 'INPUT_REPEATED' });
      seen.add(input.stockUnitId);
      if (unit.tracking !== 'SERIAL') broken.push({ field, rule: 'INPUT_NOT_AN_ANIMAL' });
      else if (unit.status !== 'ACTIVE') broken.push({ field, rule: 'INPUT_NOT_AVAILABLE' });
      else if (unit.currentLocationId !== location.id) broken.push({ field, rule: 'INPUT_NOT_HERE' });
      if (Weight.parseKg(input.weightKg).isZero()) broken.push({ field: `/inputs/${index}/weightKg`, rule: 'WEIGHT_ZERO' });
      for (const hold of unit.holds) held.push({ field, identifier: unit.identifier, kind: hold.kind, endsAt: hold.endsAt });
    });
    if (broken.length > 0) throw new ProcessingOrderInvalidError(broken);
    if (held.length > 0) throw new InputOnHoldError(held);
    return facts;
  }

  /** The weighed outputs (FR-PRC-002, FR-PRC-008): saleable outputs are lots weighed in kilograms; all of them weigh no more than the inputs. */
  private async checkOutputs(tx: Transaction, order: OrderRecord, outputs: readonly ProcessingOutputRequest[]): Promise<void> {
    if (outputs.length > MAX_ORDER_OUTPUTS) throw new ProcessingOrderInvalidError([{ field: '/outputs', rule: 'TOO_MANY_OUTPUTS' }]);
    const products = await this.refs.productsIn(tx, outputs.map((o) => o.productId));
    const missing = outputs.flatMap((o, index) => (products.has(o.productId) ? [] : [`/outputs/${index}/productId`]));
    if (missing.length > 0) throw new PrcReferenceNotFoundError(missing);
    const today = toBusinessDate(this.clock.now());
    const broken: ProcessingRuleBroken[] = [];
    outputs.forEach((o, index) => {
      const product: ProductFacts = products.get(o.productId)!;
      if (Weight.parseKg(o.weightKg).isZero()) broken.push({ field: `/outputs/${index}/weightKg`, rule: 'WEIGHT_ZERO' });
      if (o.outputKind === 'WASTE') {
        if (o.packCount !== undefined || o.expiresOn !== undefined) broken.push({ field: `/outputs/${index}`, rule: 'NOT_FOR_WASTE' });
        return;
      }
      if (product.tracking !== 'LOT') broken.push({ field: `/outputs/${index}/productId`, rule: 'OUTPUT_NOT_A_LOT' });
      else if (product.baseUom !== WEIGHED_BASE_UOM) broken.push({ field: `/outputs/${index}/productId`, rule: 'OUTPUT_NOT_BY_WEIGHT' });
      if (!product.isLive) broken.push({ field: `/outputs/${index}/productId`, rule: 'PRODUCT_NOT_ACTIVE' });
      if (o.expiresOn !== undefined && o.expiresOn < today) broken.push({ field: `/outputs/${index}/expiresOn`, rule: 'EXPIRY_BEFORE_PRODUCTION' });
    });
    const inputWeight = Weight.sum(order.inputs.map((i) => Weight.parseKg(i.weightKg)));
    broken.push(...checkOutputWeights(inputWeight, outputs.map((o) => ({ productId: o.productId, kind: o.outputKind, weight: Weight.parseKg(o.weightKg) }))));
    if (broken.length > 0) throw new ProcessingOrderInvalidError(broken);
  }

  private async insertInputs(tx: Transaction, orderId: string, inputs: readonly ProcessingInputRequest[], facts: ReadonlyMap<string, StockUnitFacts>): Promise<void> {
    for (const [index, input] of inputs.entries()) {
      await this.store.insertInput(tx, orderId, {
        id: this.nextId(),
        lineNo: ordinal(index),
        stockUnitId: input.stockUnitId,
        productId: facts.get(input.stockUnitId)!.productId,
        qty: Quantity.ofUnits(1n).toDecimalString(),
        weightKg: Weight.parseKg(input.weightKg).toKgString(),
        weightSource: input.weightSource,
      });
    }
  }

  private async view(tx: Transaction, id: string): Promise<ProcessingOrderView> {
    return (await this.views(tx, [(await this.store.order(tx, id))!]))[0]!;
  }

  private async views(tx: Transaction, records: readonly OrderRecord[]): Promise<ProcessingOrderView[]> {
    const products = await this.refs.productsIn(tx, records.flatMap((r) => [...r.inputs.map((i) => i.productId), ...r.outputs.map((o) => o.productId)]));
    const locations = await this.refs.locationsIn(tx, records.flatMap((r) => [r.locationId, r.outputLocationId]));
    const units = await this.units.factsIn(tx, records.flatMap((r) => [...r.inputs.map((i) => i.stockUnitId), ...r.outputs.flatMap((o) => (o.stockUnitId === null ? [] : [o.stockUnitId]))]), this.clock.now());
    const principals = await this.principals.refs(
      tx,
      records.flatMap((r) => [r.createdBy, ...(r.postedBy === null ? [] : [r.postedBy]), ...(r.reversal === null ? [] : [r.reversal.requestedBy, ...(r.reversal.postedBy === null ? [] : [r.reversal.postedBy])])]),
    );
    const who = (id: string) => principals.get(id) ?? UNKNOWN_PRINCIPAL;
    const amount = (value: bigint | null) => (value === null ? null : Money.ofPesewas(value).toJsonInteger());
    const ref = (l: LocationFacts) => ({ id: l.id, code: l.code, name: l.name, kind: l.kind });
    const productRef = (id: string) => {
      const p = products.get(id)!;
      return { id: p.id, sku: p.sku, name: p.name };
    };
    const unitRef = (id: string) => {
      const u = units.get(id)!;
      return { id: u.id, identifier: u.identifier, tracking: u.tracking };
    };
    const money = (pesewas: bigint) => Money.ofPesewas(pesewas).toJsonInteger();
    return records.map((r) => ({
      id: r.id,
      orderNo: r.orderNo,
      status: r.status,
      location: ref(locations.get(r.locationId)!),
      outputLocation: ref(locations.get(r.outputLocationId)!),
      startedAt: r.startedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      inputs: r.inputs.map((i) => ({
        id: i.id,
        stockUnit: unitRef(i.stockUnitId),
        product: productRef(i.productId),
        qty: i.qty,
        uom: products.get(i.productId)!.baseUom,
        weightKg: i.weightKg,
        weightSource: i.weightSource,
        // Until completion the input shows the cost it would carry now, its whole pool (FR-PRC-001).
        costPesewas: money(i.costPesewas ?? (CHANGEABLE.has(r.status) ? units.get(i.stockUnitId)!.poolValuePesewas : 0n)),
      })),
      outputs: r.outputs.map((o) => ({
        id: o.id,
        lineNo: o.lineNo,
        product: productRef(o.productId),
        outputKind: o.outputKind,
        stockUnit: o.stockUnitId === null ? null : unitRef(o.stockUnitId),
        weightKg: o.weightKg,
        weightSource: o.weightSource,
        packCount: o.packCount,
        referencePricePesewasPerKg: money(o.referencePricePesewasPerKg),
        allocationWeight: Number(o.allocationWeight),
        allocatedCostPesewas: money(o.allocatedCostPesewas),
        expiresOn: o.expiresOn,
      })),
      costs: r.costs.map((c) => ({ id: c.id, costKind: c.costKind, amountPesewas: money(c.amountPesewas), description: c.description })),
      inputWeightKg: r.inputWeightKg ?? Weight.sum(r.inputs.map((i) => Weight.parseKg(i.weightKg))).toKgString(),
      outputWeightKg: r.outputWeightKg,
      wasteWeightKg: r.wasteWeightKg,
      expectedYieldPercent: r.expectedYieldPercent,
      actualYieldPercent: r.actualYieldPercent,
      yieldVarianceFlag: r.yieldVarianceFlag,
      inputCostPesewas: r.inputCostPesewas === null ? null : money(r.inputCostPesewas),
      directCostPesewas: money(r.directCostPesewas),
      totalCostPesewas: r.totalCostPesewas === null ? null : money(r.totalCostPesewas),
      currency: 'GHS' as const,
      branchId: r.branchId,
      version: r.version,
      createdAt: r.createdAt.toISOString(),
      createdBy: principals.get(r.createdBy) ?? UNKNOWN_PRINCIPAL,
      postedAt: r.postedAt?.toISOString() ?? null,
      postedBy: r.postedBy === null ? null : (principals.get(r.postedBy) ?? UNKNOWN_PRINCIPAL),
      reversal:
        r.reversal?.status !== 'POSTED'
          ? null
          : {
              id: r.reversal.id,
              reason: r.reversal.reason,
              reversedAt: r.reversal.postedAt!.toISOString(),
              reversedBy: who(r.reversal.requestedBy),
              approvedBy: r.reversal.approvalRequestId === null ? null : who(r.reversal.postedBy!),
              approvalRequestId: r.reversal.approvalRequestId,
              valuePesewas: amount(r.reversal.valuePesewas),
              thresholdPesewas: amount(r.reversal.thresholdPesewas),
            },
      pendingReversal:
        r.reversal?.status !== 'PENDING_APPROVAL'
          ? null
          : {
              id: r.reversal.id,
              reason: r.reversal.reason,
              requestedAt: r.reversal.requestedAt.toISOString(),
              requestedBy: who(r.reversal.requestedBy),
              approvalRequestId: r.reversal.approvalRequestId!,
              valuePesewas: amount(r.reversal.valuePesewas)!,
              thresholdPesewas: amount(r.reversal.thresholdPesewas)!,
            },
    }));
  }
}

interface OutputState {
  readonly packs: readonly PackRecord[];
  readonly outputs: ReadonlyArray<{ readonly lineNo: number; readonly lot: string; readonly whole: boolean; readonly reserved: boolean; readonly packsGone: boolean }>;
}

/** The canonical payload a reversal's approval is taken against: the order, the reason, and where every output and pack stands. */
function reversalHash(order: OrderRecord, reason: string, state: OutputState): string {
  const payload = {
    orderId: order.id,
    totalCostPesewas: order.totalCostPesewas?.toString() ?? null,
    reason,
    outputs: state.outputs.map((o) => [o.lineNo, o.lot, o.whole, o.reserved, o.packsGone]),
    packs: state.packs.map((p) => [p.id, p.status]),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
