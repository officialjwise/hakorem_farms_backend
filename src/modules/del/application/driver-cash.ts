import { createUuidV7Generator, Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { IsolationLevelError, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Authoriser, PrincipalNames } from '../../iam';
import type { DriverCash } from '../../pay';
import { handInFigures, judgeHandIn, type VarianceDirection } from '../domain/driver-cash';
import { endOfBusinessDate, pageProbe } from '../domain/numbering';
import type { DriverCashRemitted } from '../events';
import { DriverCashInvalidError } from './errors';
import type { CollectionRecord, DriverCashStore, ReconciliationRecord } from './driver-cash-store';

const READ = 'del.cash_reconciliation.read';
const READ_MINE = 'del.delivery.read.assigned';
export const DRIVER_CASH_REMITTED = 'del.DriverCashRemitted';

/** What POS's hand-in gives DEL, once it has judged the receiving cashier's own open shift (CR-057, ADR-0077). */
export interface HandInRequest {
  readonly branchId: string;
  readonly shiftDocumentId: string;
  readonly register: { readonly id: string; readonly code: string };
  readonly driverId: string;
  /** What the cashier counted, in pesewas; zero when the driver hands in nothing. */
  readonly declaredPesewas: bigint;
  readonly note: string | null;
}

export interface ReconciliationQuery {
  readonly driverId: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly varianceOnly: boolean;
}

interface PrincipalRef {
  readonly id: string;
  readonly displayName: string;
}

/** The contract's `CodCollectionLite`. */
export interface CollectionView {
  readonly deliveryNo: string | null;
  readonly recipientName: string;
  readonly amountPesewas: number;
  readonly capturedAt: string;
}

/** The contract's `DriverCashReconciliation`: a hand-in at a till shift, the driver variance report's row. */
export interface DriverCashReconciliationView {
  readonly id: string;
  readonly status: 'POSTED';
  readonly driver: PrincipalRef;
  readonly reconciliationDate: string;
  readonly shiftId: string;
  readonly tillPaymentId: string | null;
  readonly expectedPesewas: number;
  readonly declaredPesewas: number;
  readonly variancePesewas: number;
  readonly varianceDirection: VarianceDirection;
  readonly receivedBy: PrincipalRef;
  readonly note: string | null;
  readonly collections: readonly CollectionView[];
  readonly currency: 'GHS';
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: string;
}

/** The contract's `DriverCashSummary`: the cash a driver still holds. */
export interface DriverCashSummaryView {
  readonly driver: PrincipalRef;
  readonly date: string;
  readonly expectedPesewas: number;
  readonly collections: readonly CollectionView[];
  readonly reconciled: boolean;
  readonly currency: 'GHS';
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

const json = (pesewas: bigint) => Money.ofPesewas(pesewas).toJsonInteger();
const collectionView = (c: CollectionRecord): CollectionView => ({ deliveryNo: c.deliveryNo, recipientName: c.recipientName, amountPesewas: json(c.amountPesewas), capturedAt: c.capturedAt.toISOString() });

/**
 * A driver's cash on delivery (FR-DEL-010, CR-057, ADR-0092, abuse cases 6 and 43). Every collection is a payment held
 * by the driver (1020) until it is handed in. `receiveIn` is the port POS's hand-in calls in its own serializable
 * transaction once it has judged the receiving cashier's own open shift through the till's one deciding function
 * (`tillTakesCash`): every collection the driver still holds at the shift's branch is handed in, exactly once
 * (`uq_driver_cash_handed_in_proof`); what the cashier counted goes onto the shift through PAY's `DriverCash.handInIn`
 * (so the shift's close counts it); a count short of what was expected stays short (never typed in as loose cash), and
 * ◆ `del.DriverCashRemitted` posts Dr 1000 the till, Cr 1020 the driver, the difference to 6900, for the driver variance
 * report (`DRIVER_VARIANCE`, B12). Over HTTP the driver reads only their own cash (`getMyCashSummary`), and the Manager
 * and the Owner read the hand-ins of the branches they hold the report at, deny by default (ADR-0035).
 */
export class DriverCashReconciliations {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: DriverCashStore,
    private readonly driverCash: DriverCash,
    private readonly documents: DocumentRegistry,
    private readonly events: DomainEvents,
    private readonly audit: AuditTrail,
    private readonly authoriser: Authoriser,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /**
   * The hand-in, in POS's serializable transaction (CR-057): it authorises nothing (POS's hand-in has, on the cashier's
   * own open shift); the cashier receiving is never the driver, and a driver with no cash held hands in nothing.
   */
  async receiveIn(tx: Transaction, actor: Actor, request: HandInRequest): Promise<DriverCashReconciliationView> {
    if (tx.isolation !== 'serializable') throw new IsolationLevelError(tx.isolation);
    const held = await this.store.held(tx, request.driverId, request.branchId, null);
    const broken = judgeHandIn({ driverId: request.driverId, receiverId: actor.principalId, heldCount: held.length });
    if (broken.length > 0) throw new DriverCashInvalidError(broken);

    const figures = handInFigures(
      held.map((c) => Money.ofPesewas(c.amountPesewas)),
      Money.ofPesewas(request.declaredPesewas),
    );
    const at = this.clock.now();
    const id = this.nextId();
    await this.documents.register(tx, { id, docType: 'DRIVER_CASH_RECONCILIATION', ownerModule: 'del', branchId: request.branchId, actorId: actor.principalId });
    const payment = figures.received.isZero()
      ? null
      : await this.driverCash.handInIn(tx, actor, {
          branchId: request.branchId,
          driverId: request.driverId,
          shiftDocumentId: request.shiftDocumentId,
          register: request.register,
          amountPesewas: figures.received.pesewas,
          receivedAt: at,
        });
    const record: ReconciliationRecord = {
      id,
      driverId: request.driverId,
      reconciliationDate: toBusinessDate(at),
      shiftDocumentId: request.shiftDocumentId,
      tillPaymentId: payment?.id ?? null,
      expectedPesewas: figures.expected.pesewas,
      declaredPesewas: figures.received.pesewas,
      variancePesewas: figures.short.plus(figures.over).pesewas,
      varianceDirection: figures.direction,
      receivedBy: actor.principalId,
      note: request.note?.trim() || null,
      branchId: request.branchId,
      version: 1,
      createdAt: at,
    };
    await this.store.insert(tx, { ...record, actorId: actor.principalId, postedAt: at });
    await this.store.insertHandedIn(tx, id, held, actor.principalId);

    const names = await this.principals.refs(tx, [request.driverId]);
    const handedIn: DriverCashRemitted = {
      reconciliationId: id,
      driverId: request.driverId,
      driverName: names.get(request.driverId)?.displayName ?? request.driverId,
      receivedBy: actor.principalId,
      shiftId: request.shiftDocumentId,
      register: request.register,
      tillPaymentId: payment?.id ?? null,
      branchId: request.branchId,
      expectedPesewas: figures.expected.toJsonInteger(),
      receivedPesewas: figures.received.toJsonInteger(),
      shortPesewas: figures.short.toJsonInteger(),
      overPesewas: figures.over.toJsonInteger(),
      varianceDirection: figures.direction,
      proofIds: held.map((c) => c.proofId),
      abuseCases: figures.direction === 'EXACT' ? [] : [6, 43],
      handedInAt: at.toISOString(),
    };
    await this.events.publish<DriverCashRemitted>(tx, { type: DRIVER_CASH_REMITTED, subjectType: 'DriverCashReconciliation', subjectId: id, branchId: request.branchId, payload: handedIn, occurredAt: at });
    const view = (await this.viewsIn(tx, [record]))[0]!;
    await this.audit.record(tx, { module: 'del', action: 'HAND_IN', entityType: 'DriverCashReconciliation', entityId: id, branchId: request.branchId, before: null, after: { ...view } });
    return view;
  }

  /**
   * getMyCashSummary: the cash the caller still holds from their own deliveries, collected up to the end of the date
   * (today in Africa/Accra by default), at every branch: nobody else's, whatever else the caller holds.
   */
  summary(actor: Actor | undefined, date: string | undefined): Promise<DriverCashSummaryView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ_MINE);
      const day = date ?? toBusinessDate(this.clock.now());
      const held = await this.store.held(tx, actor!.principalId, null, endOfBusinessDate(day));
      const me = (await this.principals.refs(tx, [actor!.principalId])).get(actor!.principalId) ?? { id: actor!.principalId, displayName: actor!.displayName };
      return {
        driver: { id: me.id, displayName: me.displayName },
        date: day,
        expectedPesewas: Money.sum(held.map((c) => Money.ofPesewas(c.amountPesewas))).toJsonInteger(),
        collections: held.map(collectionView),
        reconciled: held.length === 0,
        currency: 'GHS',
      };
    });
  }

  /** getDriverCashReconciliation: at its branch; another branch's is refused as any other. */
  get(actor: Actor | undefined, id: string): Promise<DriverCashReconciliationView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const [found] = await this.store.reconciliations(tx, [id]);
      if (found === undefined) throw new NotFoundError('no such driver cash reconciliation');
      await this.authoriser.authorise(tx, actor, READ, { branchId: found.branchId });
      return (await this.viewsIn(tx, [found]))[0]!;
    });
  }

  /** listDriverCashReconciliations: the driver variance report at the branches the caller reads whole, newest first. */
  list(actor: Actor | undefined, query: ReconciliationQuery, cursor: string | undefined, limit: number): Promise<Page<DriverCashReconciliationView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const branchIds = [...new Set((await this.authoriser.scopes(tx, actor!, READ)).filter((s) => s.locationId === null).map((s) => s.branchId))].sort();
      const binding = { operationId: 'listDriverCashReconciliations', principalId: actor!.principalId, filters: { ...query } };
      const beforeId = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.list(tx, { branchIds, ...query }, beforeId, pageProbe(limit));
      const data = await this.viewsIn(tx, await this.store.reconciliations(tx, found.slice(0, limit)));
      const hasMore = found.length > limit;
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  private async viewsIn(tx: Transaction, records: readonly ReconciliationRecord[]): Promise<DriverCashReconciliationView[]> {
    if (records.length === 0) return [];
    const names = await this.principals.refs(tx, [...new Set(records.flatMap((r) => [r.driverId, r.receivedBy]))]);
    const collections = await this.store.collectionsOf(tx, records.map((r) => r.id));
    const ref = (id: string): PrincipalRef => {
      const found = names.get(id);
      return { id, displayName: found?.displayName ?? id };
    };
    return records.map((r) => ({
      id: r.id,
      status: 'POSTED' as const,
      driver: ref(r.driverId),
      reconciliationDate: r.reconciliationDate,
      shiftId: r.shiftDocumentId,
      tillPaymentId: r.tillPaymentId,
      expectedPesewas: json(r.expectedPesewas),
      declaredPesewas: json(r.declaredPesewas),
      variancePesewas: json(r.variancePesewas),
      varianceDirection: r.varianceDirection,
      receivedBy: ref(r.receivedBy),
      note: r.note,
      collections: (collections.get(r.id) ?? []).map(collectionView),
      currency: 'GHS' as const,
      branchId: r.branchId,
      version: r.version,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
