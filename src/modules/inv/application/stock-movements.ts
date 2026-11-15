import { createHash } from 'node:crypto';
import { createUuidV7Generator, Money, Quantity, Weight, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { InvalidStateTransitionError, NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { ApprovalHandler, ApprovalRecord, Approvals, Authoriser, PrincipalNames } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { pageProbe } from './counting';
import { InvReferenceNotFoundError, StockMovementAlreadyReversedError, StockPoolValueGoneError, StockReversalNotPossibleError } from './errors';
import type { Stock } from './stock';
import { movementViews, readScopes, runStockCommand, type ApprovalPendingView, type Page, type StockMovementView } from './stock-command';
import type { MovementFilters, MovementRecord, MovementTypeRecord, StockDocumentsStore } from './stock-documents-store';

export const STOCK_REVERSAL = 'STOCK_REVERSAL';
/** A transfer's movements are corrected by the transfer, never one by one: its document would no longer agree. */
const NOT_REVERSIBLE: ReadonlySet<string> = new Set(['TRANSFER_DISPATCH', 'TRANSFER_RECEIPT']);
/** The reasons a reversal takes: the stock adjustment list (FR-MDM-011), for a movement booked in error. */
const REVERSAL_REASON_DOMAINS: ReadonlySet<string> = new Set(['STOCK_ADJUSTMENT']);

export interface ReversalRequest {
  readonly reasonCode: string;
  readonly note: string;
}

/**
 * The movement ledger over HTTP (FR-INV-001 to FR-INV-004): movement types, movements and a stock unit's movements,
 * narrowed to the reader's grants, and the reversal of one movement. A reversal is a new movement with source and
 * destination swapped, carrying the original's value, once; at or above the threshold (seed 50,000 pesewas) it waits
 * for a different person (`STOCK_REVERSAL`, ADR-0017), and nothing moves until they approve. Each reversal is kept
 * as an `inv.stock_reversal` document, the reversing movement's source document (A-139).
 */
export class StockMovements implements ApprovalHandler {
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

  listTypes(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<MovementTypeRecord>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'inv.stock.read');
      const binding = { operationId: 'listMovementTypes', principalId: actor!.principalId, filters: {} };
      const after = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['code'] ?? null);
      const rows = (await this.store.movementTypes(tx)).filter((t) => after === null || t.code > after);
      const data = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { code: last.code }) : null, limit, hasMore } };
    });
  }

  list(actor: Actor | undefined, filters: MovementFilters, cursor: string | undefined, limit: number): Promise<Page<StockMovementView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'inv.movement.read');
      return this.page(tx, actor!, 'listStockMovements', filters, cursor, limit);
    });
  }

  get(actor: Actor | undefined, id: string): Promise<StockMovementView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const movement = await this.store.movement(tx, id);
      await this.authoriser.authorise(tx, actor, 'inv.movement.read', movement === null ? {} : await this.scopeOfMovement(tx, movement));
      if (movement === null) throw new NotFoundError(`no stock movement ${id}`);
      return (await this.views(tx, [movement]))[0]!;
    });
  }

  /** A stock unit's movements, newest first: read as the unit is (A-137 (e)), then narrowed to the reader's grants. */
  listForUnit(actor: Actor | undefined, unitId: string, cursor: string | undefined, limit: number): Promise<Page<StockMovementView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const unit = (await this.store.units(tx, [unitId])).get(unitId);
      await this.authoriser.authorise(tx, actor, 'inv.movement.read', unit === undefined ? {} : { branchId: unit.branchId, locationId: unit.tracking === 'SERIAL' ? unit.currentLocationId : null });
      if (unit === undefined) throw new NotFoundError(`no stock unit ${unitId}`);
      return this.page(tx, actor!, 'listStockUnitMovements', { stockUnitId: unitId }, cursor, limit);
    });
  }

  reverse(actor: Actor | undefined, id: string, body: ReversalRequest, idempotencyKey: string): Promise<StoredResponse<StockMovementView | ApprovalPendingView>> {
    return runStockCommand(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      'inv.movement.reverse',
      'reverseStockMovement',
      { id, ...body },
      idempotencyKey,
      async (tx) => {
        const movement = await this.store.movement(tx, id);
        return movement === null ? {} : this.scopeOfMovement(tx, movement);
      },
      (tx) => this.reverseIn(tx, actor!, id, body),
    );
  }

  private async reverseIn(tx: Transaction, actor: Actor, id: string, body: ReversalRequest): Promise<StoredResponse<StockMovementView | ApprovalPendingView>> {
    const movement = await this.store.movement(tx, id);
    if (movement === null) throw new NotFoundError(`no stock movement ${id}`);
    const type = (await this.store.movementTypes(tx)).find((t) => t.code === movement.movementType)!;
    if (movement.reversesMovementId !== null) throw new StockReversalNotPossibleError([{ field: '/id', rule: 'REVERSAL_OF_A_REVERSAL' }]);
    if (NOT_REVERSIBLE.has(movement.movementType)) throw new StockReversalNotPossibleError([{ field: '/id', rule: 'TRANSFER_MOVEMENT' }]);
    if (type.isValueOnly) throw new StockReversalNotPossibleError([{ field: '/id', rule: 'VALUE_ONLY_MOVEMENT' }]);
    if ((await this.store.reversedBy(tx, [id])).has(id) || (await this.store.hasOpenReversal(tx, id))) {
      throw new StockMovementAlreadyReversedError(`movement ${id} is reversed, or its reversal waits for approval`);
    }
    const reason = (await this.refs.reasonCodesIn(tx, [body.reasonCode])).get(body.reasonCode);
    if (reason === undefined) throw new InvReferenceNotFoundError(['/reasonCode']);
    if (!REVERSAL_REASON_DOMAINS.has(reason.domain)) throw new StockReversalNotPossibleError([{ field: '/reasonCode', rule: 'REASON_NOT_ALLOWED' }]);

    const judgement = await this.approvals.judgeIn(tx, STOCK_REVERSAL, movement.branchId, movement.valuePesewas);
    const reversalId = this.nextId();
    await this.documents.register(tx, { id: reversalId, docType: 'STOCK_REVERSAL', ownerModule: 'inv', branchId: movement.branchId, actorId: actor.principalId });
    const record = {
      id: reversalId,
      movementId: id,
      reasonCode: body.reasonCode,
      note: body.note,
      valuePesewas: movement.valuePesewas,
      branchId: movement.branchId,
      thresholdPesewas: judgement.thresholdPesewas,
    };
    if (judgement.required) {
      const summary = `Reverse ${movement.movementType} movement ${id} of ${movement.qtyBase} valued ${movement.valuePesewas} pesewas (${body.reasonCode})`;
      const request = await this.approvals.request(tx, actor, {
        kind: STOCK_REVERSAL,
        branchId: movement.branchId,
        subjectDocumentId: reversalId,
        payloadHash: reversalHash({ ...record, status: 'PENDING_APPROVAL' }),
        amountPesewas: movement.valuePesewas,
        summary,
      });
      await this.store.insertReversal(tx, { ...record, approvalRequestId: request.id, reversalMovementId: null, status: 'PENDING_APPROVAL', postedAt: null }, actor.principalId);
      await this.audit.record(tx, {
        module: 'inv',
        action: 'SUBMIT',
        entityType: 'StockReversal',
        entityId: reversalId,
        branchId: movement.branchId,
        before: null,
        after: { movementId: id, reasonCode: body.reasonCode, note: body.note, valuePesewas: movement.valuePesewas, status: 'PENDING_APPROVAL', approvalRequestId: request.id },
      });
      const pending: ApprovalPendingView = {
        status: 'PENDING_APPROVAL',
        approvalRequestId: request.id,
        kind: STOCK_REVERSAL,
        subject: { id: reversalId, docType: 'STOCK_REVERSAL', number: null },
        summary,
        requestedAt: request.requestedAt.toISOString(),
      };
      return { status: 202, body: pending };
    }
    const reversing = await this.postReversal(tx, actor.principalId, movement, reversalId, body.reasonCode);
    await this.store.insertReversal(tx, { ...record, approvalRequestId: null, reversalMovementId: reversing, status: 'POSTED', postedAt: this.clock.now() }, actor.principalId);
    const view = (await this.views(tx, [(await this.store.movement(tx, reversing))!]))[0]!;
    await this.audit.record(tx, {
      module: 'inv',
      action: 'REVERSE',
      entityType: 'StockMovement',
      entityId: id,
      branchId: movement.branchId,
      before: null,
      after: { reversalId, reversingMovementId: reversing, reasonCode: body.reasonCode, note: body.note, valuePesewas: movement.valuePesewas },
    });
    return { status: 201, body: view };
  }

  /**
   * Reverses a movement a higher module's document posted, in the caller's serializable transaction, as that document's
   * correction (FR-PRC-011: a processing order's reversal): the exact opposite through `Stock.postIn`, carrying the
   * original's value, with `sourceDocumentId` the correcting document. No reason code and no approval: the caller has
   * authorised its own command and decided that the correction may be made. A movement already reversed, a reversal,
   * a transfer leg or a value-only movement is refused, as the HTTP reversal refuses them.
   */
  async reverseForDocumentIn(tx: Transaction, actorId: string, movementId: string, sourceDocumentId: string): Promise<string> {
    const movement = await this.store.movement(tx, movementId);
    if (movement === null) throw new NotFoundError(`no stock movement ${movementId}`);
    const type = (await this.store.movementTypes(tx)).find((t) => t.code === movement.movementType)!;
    if (movement.reversesMovementId !== null) throw new StockReversalNotPossibleError([{ field: '/id', rule: 'REVERSAL_OF_A_REVERSAL' }]);
    if (NOT_REVERSIBLE.has(movement.movementType)) throw new StockReversalNotPossibleError([{ field: '/id', rule: 'TRANSFER_MOVEMENT' }]);
    if (type.isValueOnly) throw new StockReversalNotPossibleError([{ field: '/id', rule: 'VALUE_ONLY_MOVEMENT' }]);
    if ((await this.store.reversedBy(tx, [movementId])).has(movementId) || (await this.store.hasOpenReversal(tx, movementId))) {
      throw new StockMovementAlreadyReversedError(`movement ${movementId} is reversed, or its reversal waits for approval`);
    }
    return this.postReversal(tx, actorId, movement, sourceDocumentId, null);
  }

  /** ApprovalHandler: the reversal as it was asked for; it cannot change while it waits. */
  async currentPayloadHash(tx: Transaction, subjectDocumentId: string): Promise<string> {
    const reversal = await this.store.lockReversal(tx, subjectDocumentId);
    if (reversal === null) throw new NotFoundError(`no stock reversal ${subjectDocumentId}`);
    return reversalHash(reversal);
  }

  /** ApprovalHandler: posts the reversing movement in the approval's transaction, as the checker who let it happen. */
  async onApproved(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const reversal = (await this.store.lockReversal(tx, request.subjectDocumentId))!;
    if (reversal.status !== 'PENDING_APPROVAL') throw new InvalidStateTransitionError(`stock reversal ${reversal.id} is ${reversal.status}`);
    const movement = (await this.store.movement(tx, reversal.movementId))!;
    const reversing = await this.postReversal(tx, request.decidedBy!, movement, reversal.id, reversal.reasonCode);
    await this.store.markReversalDecided(tx, reversal.id, { status: 'POSTED', reversalMovementId: reversing, at: this.clock.now() }, request.decidedBy!);
    await this.audit.record(tx, {
      module: 'inv',
      action: 'REVERSE',
      entityType: 'StockMovement',
      entityId: movement.id,
      branchId: movement.branchId,
      before: null,
      after: { reversalId: reversal.id, reversingMovementId: reversing, reasonCode: reversal.reasonCode, note: reversal.note, valuePesewas: movement.valuePesewas, approvalRequestId: request.id },
    });
  }

  /** ApprovalHandler: a rejected or withdrawn reversal is closed; nothing moved, and it may be asked for again. */
  async onRejected(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const reversal = (await this.store.lockReversal(tx, request.subjectDocumentId))!;
    await this.store.markReversalDecided(tx, reversal.id, { status: 'REJECTED', reversalMovementId: null, at: this.clock.now() }, request.decidedBy ?? request.requestedBy);
    await this.audit.record(tx, {
      module: 'inv',
      action: 'REJECT',
      entityType: 'StockReversal',
      entityId: reversal.id,
      branchId: reversal.branchId,
      before: { status: 'PENDING_APPROVAL' },
      after: { status: 'REJECTED', approvalRequestId: request.id, decision: request.status },
    });
  }

  /** The exact opposite of a movement, through `Stock.postIn`: the trigger checks it and gives it the original's value. */
  private async postReversal(tx: Transaction, actorId: string, movement: MovementRecord, reversalId: string, reasonCode: string | null): Promise<string> {
    try {
      const posted = await this.stock.postIn(tx, actorId, {
        movementType: movement.movementType,
        productId: movement.productId,
        stockUnitId: movement.stockUnitId,
        branchId: movement.branchId,
        fromLocationId: movement.toLocationId,
        toLocationId: movement.fromLocationId,
        qty: Quantity.parse(movement.qtyBase),
        weight: movement.weightKg === null ? null : { kg: Weight.parseKg(movement.weightKg), source: movement.weightSource! },
        packCount: movement.packCount,
        value: Money.ofPesewas(movement.valuePesewas),
        costElement: movement.costElement,
        reasonCode,
        sourceDocumentId: reversalId,
        reversesMovementId: movement.id,
        occurredAt: this.clock.now(),
      });
      return posted.id;
    } catch (error) {
      if (error instanceof StockPoolValueGoneError) {
        throw new StockReversalNotPossibleError([{ field: '/id', rule: 'POOL_VALUE_GONE' }]);
      }
      throw error;
    }
  }

  /** The branch and the physical location a movement is scoped to: where the stock was or is (A-134 (e)). */
  private async scopeOfMovement(tx: Transaction, movement: MovementRecord): Promise<{ branchId: string; locationId: string }> {
    const locations = await this.refs.locationsIn(tx, [movement.fromLocationId, movement.toLocationId]);
    const from = locations.get(movement.fromLocationId)!;
    return { branchId: movement.branchId, locationId: from.isVirtual ? movement.toLocationId : movement.fromLocationId };
  }

  private async page(tx: Transaction, actor: Actor, operationId: string, filters: MovementFilters, cursor: string | undefined, limit: number): Promise<Page<StockMovementView>> {
    const scopes = readScopes(await this.authoriser.scopes(tx, actor, 'inv.movement.read'));
    const binding = { operationId, principalId: actor.principalId, filters: { ...filters } };
    const before = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
    const found = await this.store.movements(tx, filters, scopes, before, pageProbe(limit));
    const data = found.slice(0, limit);
    const last = data.at(-1);
    const hasMore = found.length > limit;
    return { data: await this.views(tx, data), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
  }

  private views(tx: Transaction, records: readonly MovementRecord[]): Promise<StockMovementView[]> {
    return movementViews(tx, records, { store: this.store, refs: this.refs, documents: this.documents, principals: this.principals });
  }
}

function reversalHash(r: { readonly movementId: string; readonly reasonCode: string; readonly note: string; readonly valuePesewas: bigint; readonly status: string }): string {
  return createHash('sha256')
    .update(JSON.stringify({ movementId: r.movementId, reasonCode: r.reasonCode, note: r.note, valuePesewas: r.valuePesewas.toString(), status: r.status }))
    .digest('hex');
}
