import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRefRecord, DocumentRegistry } from '../../../platform/documents/document-registry';
import { InvalidStateTransitionError, NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { checkHoldPlacement, judgeRelease, type HoldKind } from '../domain/stock-hold';
import { pageProbe } from './counting';
import { InvReferenceNotFoundError, StockHoldInvalidError, WithdrawalCannotBeReleasedError } from './errors';
import { principalRef, readScopes, runStockCommand, unitRef, type Page, type StockUnitRefView } from './stock-command';
import type { StockDocumentsStore, UnitRecord } from './stock-documents-store';
import type { StockHoldFilters, StockHoldRecord, StockHoldStore } from './stock-hold-store';

export interface StockHoldCreateRequest {
  readonly stockUnitId: string;
  readonly kind: 'QUARANTINE' | 'INVESTIGATION';
  readonly endsAt?: Date | undefined;
  readonly note: string;
}

export interface StockHoldReleaseRequest {
  readonly reasonCode: string;
  readonly note: string;
}

/** What a caller in the same process asks for when it places a hold (the `Holds` interface: LIV, cold chain). */
export interface HoldPlacementRequest {
  readonly stockUnitId: string;
  readonly kind: HoldKind;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  /** The caller's document that causes the hold: a treatment, a temperature reading. */
  readonly sourceDocumentId: string;
  readonly note?: string | null;
}

/** The contract's `StockHold`. */
export interface StockHoldView {
  readonly id: string;
  readonly stockUnit: StockUnitRefView;
  readonly kind: HoldKind;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly sourceDocument: DocumentRefRecord;
  readonly releasedAt: string | null;
  readonly releasedBy: PrincipalRef | null;
  readonly releaseReasonCode: string | null;
  readonly createdAt: string;
  readonly createdBy: PrincipalRef;
}

/**
 * Holds (FR-INV-022, FR-INV-008, ADR-0019, threat model abuse case 23). A hold blocks sale, processing and dispatch
 * of an animal or lot (the movement types `blocked_by_hold`, enforced by the movement trigger of migration 0044)
 * while it is in force. A manager places a quarantine or investigation hold by hand; LIV places a withdrawal hold
 * through `placeIn` in the treatment's transaction, and the cold chain a quarantine in the reading's. A hold placed by
 * hand is its own `STOCK_HOLD` document. A person releases a quarantine or investigation hold early, once, with a
 * reason from the HOLD_RELEASE list and a note, and never one they placed themselves; a withdrawal hold is never
 * released: it ends by time. Every write is scoped to the unit's branch and, for an animal, where it stands; each is
 * serializable, idempotent and audited.
 */
export class StockHolds {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: StockHoldStore,
    private readonly documentsStore: StockDocumentsStore,
    private readonly refs: MasterDataRefs,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly documents: DocumentRegistry,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, filters: StockHoldFilters, cursor: string | undefined, limit: number): Promise<Page<StockHoldView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'inv.hold.read');
      const scopes = readScopes(await this.authoriser.scopes(tx, actor!, 'inv.hold.read'));
      const binding = { operationId: 'listStockHolds', principalId: actor!.principalId, filters: { ...filters } };
      const after = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.holds(tx, filters, this.clock.now(), scopes, after, pageProbe(limit));
      const data = found.slice(0, limit);
      const last = data.at(-1);
      const hasMore = found.length > limit;
      return { data: await this.views(tx, data), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  create(actor: Actor | undefined, body: StockHoldCreateRequest, idempotencyKey: string): Promise<StoredResponse<StockHoldView>> {
    return runStockCommand(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      'inv.hold.create',
      'createStockHold',
      { ...body, endsAt: body.endsAt?.toISOString() },
      idempotencyKey,
      async (tx) => scopeOf((await this.documentsStore.units(tx, [body.stockUnitId])).get(body.stockUnitId)),
      async (tx) => {
        const id = this.nextId();
        await this.documents.register(tx, { id, docType: 'STOCK_HOLD', ownerModule: 'inv', branchId: (await this.unit(tx, body.stockUnitId)).branchId, actorId: actor!.principalId });
        await this.placeIn(tx, actor!.principalId, { stockUnitId: body.stockUnitId, kind: body.kind, startsAt: this.clock.now(), endsAt: body.endsAt ?? null, sourceDocumentId: id, note: body.note }, id);
        return { status: 201, body: (await this.views(tx, [(await this.store.hold(tx, id))!]))[0]! };
      },
    );
  }

  /**
   * The `Holds` interface: places a hold in the caller's transaction, every placement rule applied and audited. The
   * movement trigger enforces it from the next movement on; placing it locks the unit row, as a sale does.
   */
  async placeIn(tx: Transaction, actorId: string, request: HoldPlacementRequest, id: string = this.nextId()): Promise<string> {
    const unit = await this.unit(tx, request.stockUnitId);
    const broken = checkHoldPlacement({ kind: request.kind, unitStatus: unit.status, startsAt: request.startsAt, endsAt: request.endsAt });
    if (broken.length > 0) throw new StockHoldInvalidError(broken);
    await this.store.insertHold(
      tx,
      { id, stockUnitId: unit.id, kind: request.kind, startsAt: request.startsAt, endsAt: request.endsAt, sourceDocumentId: request.sourceDocumentId, note: request.note ?? null },
      actorId,
    );
    await this.audit.record(tx, { module: 'inv', action: 'PLACE', entityType: 'StockHold', entityId: id, branchId: unit.branchId, before: null, after: { ...(await this.store.hold(tx, id))! } });
    return id;
  }

  release(actor: Actor | undefined, id: string, body: StockHoldReleaseRequest, idempotencyKey: string): Promise<StoredResponse<StockHoldView>> {
    return runStockCommand(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      'inv.hold.release',
      'releaseStockHold',
      { id, ...body },
      idempotencyKey,
      async (tx) => {
        const hold = await this.store.hold(tx, id);
        return hold === null ? {} : scopeOf((await this.documentsStore.units(tx, [hold.stockUnitId])).get(hold.stockUnitId));
      },
      async (tx) => {
        const before = await this.store.lockHold(tx, id);
        if (before === null) throw new NotFoundError(`no stock hold ${id}`);
        const reason = (await this.refs.reasonCodesIn(tx, [body.reasonCode])).get(body.reasonCode);
        if (reason === undefined) throw new InvReferenceNotFoundError(['/reasonCode']);
        const now = this.clock.now();
        const judged = judgeRelease({ hold: before, at: now, releasedBy: actor!.principalId, reasonDomain: reason.domain });
        if (judged.refusal !== null) {
          throw judged.refusal === 'WITHDRAWAL'
            ? new WithdrawalCannotBeReleasedError(`hold ${id} is a withdrawal hold; it ends on ${before.endsAt?.toISOString() ?? 'its date'}`)
            : new InvalidStateTransitionError(`hold ${id} is released or has ended`);
        }
        if (judged.broken.length > 0) throw new StockHoldInvalidError(judged.broken);
        await this.store.release(tx, id, { at: now, reasonCode: body.reasonCode, note: body.note }, actor!.principalId);
        const after = (await this.store.hold(tx, id))!;
        const unit = await this.unit(tx, before.stockUnitId);
        await this.audit.record(tx, { module: 'inv', action: 'RELEASE', entityType: 'StockHold', entityId: id, branchId: unit.branchId, before: { ...before }, after: { ...after } });
        return { status: 200, body: (await this.views(tx, [after]))[0]! };
      },
    );
  }

  private async unit(tx: Transaction, stockUnitId: string): Promise<UnitRecord> {
    const unit = (await this.documentsStore.units(tx, [stockUnitId])).get(stockUnitId);
    if (unit === undefined) throw new InvReferenceNotFoundError(['/stockUnitId']);
    return unit;
  }

  private async views(tx: Transaction, records: readonly StockHoldRecord[]): Promise<StockHoldView[]> {
    const units = await this.documentsStore.units(tx, records.map((r) => r.stockUnitId));
    const documents = await this.documents.refs(tx, records.map((r) => r.sourceDocumentId));
    const names = await this.principals.refs(tx, records.flatMap((r) => [r.createdBy, ...(r.releasedBy === null ? [] : [r.releasedBy])]));
    return records.map((r) => ({
      id: r.id,
      stockUnit: unitRef(units.get(r.stockUnitId))!,
      kind: r.kind,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt?.toISOString() ?? null,
      sourceDocument: documents.get(r.sourceDocumentId) ?? { id: r.sourceDocumentId, docType: 'UNKNOWN', number: null },
      releasedAt: r.releasedAt?.toISOString() ?? null,
      releasedBy: r.releasedBy === null ? null : principalRef(names, r.releasedBy),
      releaseReasonCode: r.releaseReasonCode,
      createdAt: r.createdAt.toISOString(),
      createdBy: principalRef(names, r.createdBy),
    }));
  }
}

/** A unit is acted on in its branch and, for an animal, where it stands; a lot has no single place (A-137 (e)). */
function scopeOf(unit: UnitRecord | undefined): { branchId?: string; locationId?: string } {
  if (unit === undefined) return {};
  return unit.tracking === 'SERIAL' && unit.currentLocationId !== null ? { branchId: unit.branchId, locationId: unit.currentLocationId } : { branchId: unit.branchId };
}
