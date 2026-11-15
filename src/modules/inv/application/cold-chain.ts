import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import type { LocationFacts, MasterDataRefs } from '../../mdm';
import { checkReading, excursionNote, isExcursion, quarantineStart, type TemperatureRange } from '../domain/temperature';
import { pageProbe } from './counting';
import { InvReferenceNotFoundError, TemperatureReadingInvalidError } from './errors';
import { locationRef, principalRef, readScopes, runStockCommand, type LocationRefView, type Page } from './stock-command';
import type { StockAlertStore, TemperatureReadingFilters, TemperatureReadingRecord } from './stock-alert-store';
import type { StockDocumentsStore } from './stock-documents-store';
import type { StockHolds } from './stock-holds';

export interface TemperatureReadingCreateRequest {
  readonly id?: string | undefined;
  readonly locationId: string;
  readonly readingC: string;
  readonly measuredAt: Date;
  readonly source: 'MANUAL' | 'SENSOR';
}

/** The contract's `TemperatureReading`. */
export interface TemperatureReadingView {
  readonly id: string;
  readonly location: LocationRefView;
  readonly readingC: string;
  readonly measuredAt: string;
  readonly source: 'MANUAL' | 'SENSOR';
  readonly isExcursion: boolean;
  readonly exceptionId: string | null;
  readonly actor: PrincipalRef;
}

/** `inv.TemperatureExcursionRecorded` v1: a reading outside its location's range quarantined what was there. */
export interface TemperatureExcursionRecorded {
  readonly readingId: string;
  readonly excursionDocumentId: string;
  readonly locationId: string;
  readonly readingC: string;
  readonly minC: string;
  readonly maxC: string;
  readonly measuredAt: string;
  readonly holdIds: readonly string[];
  readonly exceptionIds: readonly string[];
}

/**
 * The cold chain (FR-INV-007, FR-INV-008, ADR-0019, threat model abuse case 25). A reading is recorded against its
 * location's permitted range, which master data holds and which is copied onto the reading, so the database checks
 * the excursion flag against the range it was judged by. A reading outside the range is an excursion: in the same
 * serializable transaction it registers a `TEMPERATURE_EXCURSION` document, places a `QUARANTINE` hold through the
 * `Holds` interface on every lot and animal with stock in the location (from when the reading was taken), raises one
 * `TEMPERATURE_EXCURSION` stock exception per stock line there (untracked stock cannot be held, so its exception says
 * so), and publishes `inv.TemperatureExcursionRecorded` through the outbox. A person releases each hold with a reason
 * (`releaseStockHold`), never the one who recorded the excursion. Readings are append-only; the client may supply the
 * id, so an offline resubmission is stored once.
 */
export class ColdChain {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: StockAlertStore,
    private readonly documentsStore: StockDocumentsStore,
    private readonly refs: MasterDataRefs,
    private readonly holds: StockHolds,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly documents: DocumentRegistry,
    private readonly events: DomainEvents,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, filters: TemperatureReadingFilters, cursor: string | undefined, limit: number): Promise<Page<TemperatureReadingView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'inv.cold_chain.read');
      const scopes = readScopes(await this.authoriser.scopes(tx, actor!, 'inv.cold_chain.read'));
      const binding = {
        operationId: 'listTemperatureReadings',
        principalId: actor!.principalId,
        filters: { locationId: filters.locationId ?? null, from: filters.from?.toISOString() ?? null, to: filters.to?.toISOString() ?? null, excursionsOnly: filters.excursionsOnly ?? null },
      };
      const decoded = cursor === undefined ? null : this.cursors.decode(cursor, binding);
      const after = decoded === null ? null : { measuredAt: decoded['measuredAt'] as string, id: decoded['id'] as string };
      const found = await this.store.readings(tx, filters, scopes, after, pageProbe(limit));
      const data = found.slice(0, limit);
      const last = data.at(-1);
      const hasMore = found.length > limit;
      return {
        data: await this.views(tx, data),
        page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { measuredAt: last.measuredAt.toISOString(), id: last.id }) : null, limit, hasMore },
      };
    });
  }

  record(actor: Actor | undefined, body: TemperatureReadingCreateRequest, idempotencyKey: string): Promise<StoredResponse<TemperatureReadingView>> {
    return runStockCommand(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      'inv.cold_chain.record',
      'recordTemperatureReading',
      { ...body, measuredAt: body.measuredAt.toISOString() },
      idempotencyKey,
      async (tx) => {
        const location = (await this.refs.locationsIn(tx, [body.locationId])).get(body.locationId);
        return location === undefined ? {} : { branchId: location.branchId, locationId: location.id };
      },
      async (tx) => {
        if (body.id !== undefined) {
          const first = await this.store.reading(tx, body.id);
          if (first !== null) {
            // A resubmission from an offline queue: the first reading stands, whatever this one says.
            if (first.locationId !== body.locationId) throw new TemperatureReadingInvalidError([{ field: '/id', rule: 'ID_IN_USE' }]);
            return { status: 201, body: (await this.views(tx, [first]))[0]! };
          }
        }
        const location = (await this.refs.locationsIn(tx, [body.locationId])).get(body.locationId);
        if (location === undefined || !location.isLive) throw new InvReferenceNotFoundError(['/locationId']);
        const now = this.clock.now();
        const broken = location.isVirtual ? [{ field: '/locationId', rule: 'NOT_A_STOCK_LOCATION' }] : checkReading({ range: location.tempRange, measuredAt: body.measuredAt, now });
        if (broken.length > 0) throw new TemperatureReadingInvalidError(broken);
        const range = location.tempRange!;
        const id = body.id ?? this.nextId();
        const excursion = isExcursion(body.readingC, range);
        const quarantine = excursion ? await this.quarantine(tx, actor!, id, body, location, range, now) : null;
        await this.store.insertReading(
          tx,
          {
            id,
            locationId: location.id,
            branchId: location.branchId,
            readingC: body.readingC,
            rangeMinC: range.minC,
            rangeMaxC: range.maxC,
            measuredAt: body.measuredAt,
            source: body.source,
            isExcursion: excursion,
            excursionDocumentId: quarantine?.documentId ?? null,
            exceptionId: quarantine?.exceptionIds[0] ?? null,
          },
          actor!.principalId,
        );
        const after = (await this.store.reading(tx, id))!;
        await this.audit.record(tx, {
          module: 'inv',
          action: 'RECORD',
          entityType: 'TemperatureReading',
          entityId: id,
          branchId: location.branchId,
          before: null,
          after: { ...after, holdIds: quarantine?.holdIds ?? [], exceptionIds: quarantine?.exceptionIds ?? [] },
        });
        if (quarantine !== null) {
          await this.events.publish<TemperatureExcursionRecorded>(tx, {
            type: 'inv.TemperatureExcursionRecorded',
            subjectType: 'TemperatureReading',
            subjectId: id,
            branchId: location.branchId,
            occurredAt: body.measuredAt,
            payload: {
              readingId: id,
              excursionDocumentId: quarantine.documentId,
              locationId: location.id,
              readingC: body.readingC,
              minC: range.minC,
              maxC: range.maxC,
              measuredAt: body.measuredAt.toISOString(),
              holdIds: quarantine.holdIds,
              exceptionIds: quarantine.exceptionIds,
            },
          });
        }
        return { status: 201, body: (await this.views(tx, [after]))[0]! };
      },
    );
  }

  /** FR-INV-008: a hold on every lot and animal with stock in the location, and an exception for every stock line there. */
  private async quarantine(
    tx: Transaction,
    actor: Actor,
    readingId: string,
    body: TemperatureReadingCreateRequest,
    location: LocationFacts,
    range: TemperatureRange,
    now: Date,
  ): Promise<{ readonly documentId: string; readonly holdIds: string[]; readonly exceptionIds: string[] }> {
    const documentId = this.nextId();
    await this.documents.register(tx, { id: documentId, docType: 'TEMPERATURE_EXCURSION', ownerModule: 'inv', branchId: location.branchId, actorId: actor.principalId });
    const note = excursionNote(body.readingC, range, location.code);
    const holdIds: string[] = [];
    const exceptionIds: string[] = [];
    for (const line of await this.store.stockAt(tx, location.id)) {
      let holdId: string | null = null;
      if (line.stockUnitId !== null && line.unitStatus === 'ACTIVE') {
        holdId = await this.holds.placeIn(tx, actor.principalId, {
          stockUnitId: line.stockUnitId,
          kind: 'QUARANTINE',
          startsAt: quarantineStart(body.measuredAt, now),
          endsAt: null,
          sourceDocumentId: documentId,
          note,
        });
        holdIds.push(holdId);
      }
      exceptionIds.push(
        await this.documentsStore.insertException(tx, {
          kind: 'TEMPERATURE_EXCURSION',
          branchId: location.branchId,
          productId: line.productId,
          stockUnitId: line.stockUnitId,
          locationId: location.id,
          movementId: null,
          sourceDocumentId: documentId,
          qty: line.onHandQty,
          details: { readingId, readingC: body.readingC, minC: range.minC, maxC: range.maxC, locationCode: location.code, measuredAt: body.measuredAt.toISOString(), holdId },
        }),
      );
    }
    return { documentId, holdIds, exceptionIds };
  }

  private async views(tx: Transaction, records: readonly TemperatureReadingRecord[]): Promise<TemperatureReadingView[]> {
    const locations = await this.refs.locationsIn(tx, records.map((r) => r.locationId));
    const names = await this.principals.refs(tx, records.map((r) => r.actorId));
    return records.map((r) => ({
      id: r.id,
      location: locationRef(locations.get(r.locationId)!),
      readingC: r.readingC,
      measuredAt: r.measuredAt.toISOString(),
      source: r.source,
      isExcursion: r.isExcursion,
      exceptionId: r.exceptionId,
      actor: principalRef(names, r.actorId),
    }));
  }
}
