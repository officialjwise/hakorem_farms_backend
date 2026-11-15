import { createUuidV7Generator, Money, Quantity, toBusinessDate, Weight, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from '../../iam';
import type { Lineage, Stock, StockUnits } from '../../inv';
import type { MasterDataRefs } from '../../mdm';
import { checkBirth, checkDam, checkSire, expectedBirth, nextBreedingStatus, stillbirthsOf, type BreedingStatus } from '../domain/breeding';
import type { AnimalRegistered, BirthRecorded } from '../events';
import { LivestockRecordInvalidError, LivReferenceNotFoundError } from './errors';
import type { BreedingFilters, BreedingRecordRow, HerdStore } from './herd-store';
import type { LivestockStore, Sex, WeightSource } from './livestock-store';
import { afterOf, pageOf, pageProbe, readScopeOf, runWrite, type Page } from './support';

export interface BreedingCreateRequest {
  readonly damId: string;
  readonly sireId?: string | undefined;
  readonly matedOn: string;
  readonly expectedBirthOn?: string | undefined;
  readonly notes?: string | undefined;
}

export interface BreedingUpdateRequest {
  readonly version: number;
  readonly expectedBirthOn?: string | undefined;
  readonly status?: 'MATED' | 'CONFIRMED' | undefined;
  readonly notes?: string | undefined;
}

export interface BirthRequest {
  readonly actualBirthOn: string;
  readonly litterSize: number;
  readonly offspring: ReadonlyArray<{ readonly tagNo: string; readonly sex: Sex; readonly weightKg?: string | undefined; readonly weightSource?: WeightSource | undefined }>;
  readonly notes?: string | undefined;
}

/** The contract's `BreedingRecord`. */
export interface BreedingRecordView {
  readonly id: string;
  readonly dam: { readonly id: string; readonly tagNo: string };
  readonly sire: { readonly id: string; readonly tagNo: string } | null;
  readonly matedOn: string;
  readonly expectedBirthOn: string | null;
  readonly actualBirthOn: string | null;
  readonly litterSize: number | null;
  readonly liveBirths: number | null;
  readonly status: BreedingStatus;
  readonly notes: string | null;
  readonly offspring: ReadonlyArray<{ readonly id: string; readonly tagNo: string; readonly sex: Sex }>;
  readonly version: number;
}

const ONE_HEAD = '1.000';

/**
 * Breeding and births (FR-LIV-010, FR-LIV-011; ADR-0018). A mating names a live female dam of a species with a
 * gestation period on record, and the sire where known; its expected birth is counted from that period, which is data.
 * A birth registers each live offspring through inventory (`StockUnits.registerSerialIn`, then a BIRTH movement from
 * the branch's PRODUCTION location into the dam's pen at nil cost), opens its record here with the dam, the sire and
 * the birth linked, and records the lineage to the dam (`Lineage.linkIn`, BIRTH), all in one serializable transaction.
 * The dam must have been female and alive on the birth date. Each write authorises at the dam's branch and pen.
 */
export class Breeding {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: LivestockStore,
    private readonly herd: HerdStore,
    private readonly refs: MasterDataRefs,
    private readonly units: StockUnits,
    private readonly stock: Stock,
    private readonly lineage: Lineage,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly documents: DocumentRegistry,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, filters: BreedingFilters, cursor: string | undefined, limit: number): Promise<Page<BreedingRecordView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'liv.breeding.read');
      const scope = await readScopeOf(tx, this.authoriser, this.units, actor!, 'liv.breeding.read');
      const binding = { operationId: 'listBreedingRecords', principalId: actor!.principalId, filters: { ...filters } };
      const rows = await this.herd.listBreeding(tx, filters, scope, afterOf(this.cursors, binding, cursor), pageProbe(limit));
      return pageOf(this.cursors, binding, rows, limit, (r) => r.id, await this.viewsIn(tx, rows.slice(0, limit)));
    });
  }

  get(actor: Actor | undefined, id: string): Promise<BreedingRecordView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const record = (await this.herd.breeding(tx, [id]))[0];
      await this.authoriser.authorise(tx, actor, 'liv.breeding.read', record === undefined ? {} : await this.damScope(tx, record.damId));
      if (record === undefined) throw new NotFoundError(`no breeding record ${id}`);
      return (await this.viewsIn(tx, [record]))[0]!;
    });
  }

  create(actor: Actor | undefined, body: BreedingCreateRequest, idempotencyKey: string): Promise<StoredResponse<BreedingRecordView>> {
    return runWrite(this.uow, this.authoriser, this.idempotency, actor, 'liv.breeding.record', 'createBreedingRecord', body, idempotencyKey, (tx) => this.damScope(tx, body.damId), async (tx, who) => ({
      status: 201,
      body: await this.createIn(tx, who, body),
    }));
  }

  /** Records a mating in the caller's serializable transaction; the caller authorised it. */
  async createIn(tx: Transaction, actor: Actor, body: BreedingCreateRequest): Promise<BreedingRecordView> {
    const dam = await this.store.lockAnimal(tx, body.damId);
    const sire = body.sireId === undefined ? null : ((await this.store.animals(tx, [body.sireId]))[0] ?? null);
    const missing = [...(dam === null ? ['/damId'] : []), ...(body.sireId !== undefined && sire === null ? ['/sireId'] : [])];
    if (missing.length > 0) throw new LivReferenceNotFoundError(missing);
    const species = (await this.refs.speciesIn(tx, [dam!.speciesId])).get(dam!.speciesId)!;
    const gestationDays = await this.herd.gestationDays(tx, species.code);
    const broken = [
      ...checkDam({ status: dam!.status, sex: dam!.sex, gestationDays }),
      ...(sire === null ? [] : checkSire({ id: sire.stockUnitId, sex: sire.sex, speciesId: sire.speciesId }, dam!.speciesId, dam!.stockUnitId)),
    ];
    const now = this.clock.now();
    if (body.matedOn > toBusinessDate(now)) broken.push({ field: '/matedOn', rule: 'IN_THE_FUTURE' });
    const expected = body.expectedBirthOn ?? (gestationDays === null ? null : expectedBirth(body.matedOn, gestationDays));
    if (expected !== null && expected < body.matedOn) broken.push({ field: '/expectedBirthOn', rule: 'EXPECTED_BEFORE_MATING' });
    if (broken.length > 0) throw new LivestockRecordInvalidError(broken);
    const id = this.nextId();
    await this.documents.register(tx, { id, docType: 'BREEDING_RECORD', ownerModule: 'liv', branchId: dam!.branchId, actorId: actor.principalId });
    await this.herd.insertBreeding(tx, { id, damId: dam!.stockUnitId, sireId: sire?.stockUnitId ?? null, matedOn: body.matedOn, expectedBirthOn: expected, notes: body.notes ?? null, status: 'MATED', branchId: dam!.branchId }, actor.principalId);
    const view = (await this.viewsIn(tx, [(await this.herd.breeding(tx, [id]))[0]!]))[0]!;
    await this.audit.record(tx, { module: 'liv', action: 'CREATE', entityType: 'BreedingRecord', entityId: id, branchId: dam!.branchId, before: null, after: { ...view } });
    return view;
  }

  update(actor: Actor | undefined, id: string, body: BreedingUpdateRequest, idempotencyKey: string): Promise<StoredResponse<BreedingRecordView>> {
    return runWrite(this.uow, this.authoriser, this.idempotency, actor, 'liv.breeding.record', 'updateBreedingRecord', { id, ...body }, idempotencyKey, (tx) => this.recordScope(tx, id), async (tx, who) => {
      const before = await this.locked(tx, id);
      if (before.version !== body.version) throw new VersionConflictError(`breeding record ${id} is at version ${before.version}, not ${body.version}`);
      const status = nextBreedingStatus(before.status, body.status);
      if (!status.ok) throw new LivestockRecordInvalidError([{ field: '/status', rule: status.error }]);
      if (body.expectedBirthOn !== undefined && body.expectedBirthOn < before.matedOn) throw new LivestockRecordInvalidError([{ field: '/expectedBirthOn', rule: 'EXPECTED_BEFORE_MATING' }]);
      const set: Record<string, unknown> = { status: status.value };
      if (body.expectedBirthOn !== undefined) set['expected_birth_on'] = body.expectedBirthOn;
      if (body.notes !== undefined) set['notes'] = body.notes;
      await this.herd.updateBreeding(tx, id, set, who.principalId);
      return { status: 200, body: await this.audited(tx, before, 'UPDATE') };
    });
  }

  fail(actor: Actor | undefined, id: string, reason: string, idempotencyKey: string): Promise<StoredResponse<BreedingRecordView>> {
    return runWrite(this.uow, this.authoriser, this.idempotency, actor, 'liv.breeding.record', 'failBreedingRecord', { id, reason }, idempotencyKey, (tx) => this.recordScope(tx, id), async (tx, who) => {
      const before = await this.locked(tx, id);
      const open = nextBreedingStatus(before.status, undefined);
      if (!open.ok) throw new LivestockRecordInvalidError([{ field: '/reason', rule: open.error }]);
      await this.herd.updateBreeding(tx, id, { status: 'FAILED', fail_reason: reason, posted_at: this.clock.now(), posted_by: who.principalId }, who.principalId);
      return { status: 200, body: await this.audited(tx, before, 'FAIL') };
    });
  }

  recordBirth(actor: Actor | undefined, id: string, body: BirthRequest, idempotencyKey: string): Promise<StoredResponse<BreedingRecordView>> {
    return runWrite(this.uow, this.authoriser, this.idempotency, actor, 'liv.breeding.record', 'recordBirth', { id, ...body }, idempotencyKey, (tx) => this.recordScope(tx, id), async (tx, who) => ({
      status: 200,
      body: await this.recordBirthIn(tx, who, id, body),
    }));
  }

  /** Records a birth and registers its live offspring in the caller's serializable transaction; the caller authorised it. */
  async recordBirthIn(tx: Transaction, actor: Actor, id: string, body: BirthRequest): Promise<BreedingRecordView> {
    const before = await this.locked(tx, id);
    const dam = (await this.store.animals(tx, [before.damId]))[0]!;
    const now = this.clock.now();
    const tags = body.offspring.map((o) => o.tagNo);
    const broken = checkBirth(
      before,
      { actualBirthOn: body.actualBirthOn, litterSize: body.litterSize, tags },
      { sex: dam.sex, status: dam.status, closedOn: dam.statusChangedAt === null ? null : toBusinessDate(dam.statusChangedAt) },
      toBusinessDate(now),
    );
    const pen = (await this.units.factsIn(tx, [dam.stockUnitId], now)).get(dam.stockUnitId)!.currentLocationId;
    // Offspring are born where the dam stands; a dam no longer standing anywhere leaves them nowhere to be (A-159).
    if (broken.length === 0 && pen === null) broken.push({ field: '/actualBirthOn', rule: 'DAM_NOT_IN_A_PEN' });
    for (const [index, tag] of tags.entries()) {
      if ((await this.store.liveAnimalByTag(tx, tag)) !== null) broken.push({ field: `/offspring/${index}/tagNo`, rule: 'TAG_IN_USE' });
    }
    const taken = new Set(await this.units.activeIdentifiersIn(tx, dam.productId, tags));
    tags.forEach((tag, index) => {
      if (taken.has(tag) && !broken.some((b) => b.field === `/offspring/${index}/tagNo`)) broken.push({ field: `/offspring/${index}/tagNo`, rule: 'TAG_IN_USE' });
    });
    if (broken.length > 0) throw new LivestockRecordInvalidError(broken);
    const production = await this.refs.virtualLocationIn(tx, dam.branchId, 'PRODUCTION');
    if (production === null) throw new Error(`branch ${dam.branchId} has no virtual PRODUCTION location; every branch is created with one (ADR-0042)`);
    const offspringIds: string[] = [];
    for (const kid of body.offspring) {
      const weight = kid.weightKg === undefined ? null : Weight.parseKg(kid.weightKg).toKgString();
      const unitId = await this.units.registerSerialIn(tx, actor.principalId, { productId: dam.productId, branchId: dam.branchId, identifier: kid.tagNo, sourceDocumentId: id, weightKg: weight, weighedAt: weight === null ? null : now });
      await this.stock.postIn(tx, actor.principalId, {
        movementType: 'BIRTH',
        productId: dam.productId,
        stockUnitId: unitId,
        branchId: dam.branchId,
        fromLocationId: production,
        toLocationId: pen!,
        qty: Quantity.parse(ONE_HEAD),
        weight: weight === null ? null : { kg: Weight.parseKg(weight), source: kid.weightSource! },
        sourceDocumentId: id,
        sourceLineRef: unitId,
        occurredAt: now,
      });
      await this.store.insertAnimal(
        tx,
        {
          stockUnitId: unitId,
          tagNo: kid.tagNo,
          speciesId: dam.speciesId,
          productId: dam.productId,
          branchId: dam.branchId,
          breed: dam.breed,
          sex: kid.sex,
          dateOfBirth: body.actualBirthOn,
          acquiredOn: body.actualBirthOn,
          source: 'BIRTH',
          supplierId: null,
          acquisitionCostPesewas: 0n,
          damId: dam.stockUnitId,
          sireId: before.sireId,
          purpose: 'GROWING',
          breedingRecordId: id,
        },
        actor.principalId,
      );
      if (weight !== null) {
        await this.store.insertWeight(tx, { id: this.nextId(), stockUnitId: unitId, branchId: dam.branchId, weightKg: weight, weightSource: kid.weightSource!, headWeighed: 1, measuredAt: now, actorId: actor.principalId });
      }
      await this.lineage.linkIn(tx, actor.principalId, unitId, [dam.stockUnitId], 'BIRTH', id);
      await this.events.publish<AnimalRegistered>(tx, {
        type: 'liv.AnimalRegistered',
        subjectType: 'Animal',
        subjectId: unitId,
        branchId: dam.branchId,
        occurredAt: now,
        payload: { stockUnitId: unitId, tagNo: kid.tagNo, speciesId: dam.speciesId, productId: dam.productId, branchId: dam.branchId, source: 'BIRTH', supplierId: null, acquisitionCostPesewas: Money.zero().toJsonInteger(), purpose: 'GROWING' },
      });
      offspringIds.push(unitId);
    }
    await this.herd.updateBreeding(
      tx,
      id,
      {
        status: 'BORN',
        actual_birth_on: body.actualBirthOn,
        litter_size: body.litterSize,
        live_births: body.offspring.length,
        stillbirths: stillbirthsOf({ actualBirthOn: body.actualBirthOn, litterSize: body.litterSize, tags }),
        ...(body.notes === undefined ? {} : { notes: body.notes }),
        posted_at: now,
        posted_by: actor.principalId,
      },
      actor.principalId,
    );
    const view = await this.audited(tx, before, 'BIRTH');
    await this.events.publish<BirthRecorded>(tx, {
      type: 'liv.BirthRecorded',
      subjectType: 'BreedingRecord',
      subjectId: id,
      branchId: dam.branchId,
      occurredAt: now,
      payload: { breedingRecordId: id, damId: dam.stockUnitId, branchId: dam.branchId, actualBirthOn: body.actualBirthOn, litterSize: body.litterSize, liveBirths: body.offspring.length, offspringIds },
    });
    return view;
  }

  async viewsIn(tx: Transaction, records: readonly BreedingRecordRow[]): Promise<BreedingRecordView[]> {
    if (records.length === 0) return [];
    const parents = new Map((await this.store.animals(tx, records.flatMap((r) => [r.damId, ...(r.sireId === null ? [] : [r.sireId])]))).map((a) => [a.stockUnitId, a.tagNo] as const));
    const offspring = await this.herd.offspringOf(tx, records.map((r) => r.id));
    return records.map((r) => ({
      id: r.id,
      dam: { id: r.damId, tagNo: parents.get(r.damId)! },
      sire: r.sireId === null ? null : { id: r.sireId, tagNo: parents.get(r.sireId)! },
      matedOn: r.matedOn,
      expectedBirthOn: r.expectedBirthOn,
      actualBirthOn: r.actualBirthOn,
      litterSize: r.litterSize,
      liveBirths: r.liveBirths,
      status: r.status,
      notes: r.notes,
      offspring: offspring.filter((o) => o.breedingRecordId === r.id).map((o) => ({ id: o.id, tagNo: o.tagNo, sex: o.sex })),
      version: r.version,
    }));
  }

  private async locked(tx: Transaction, id: string): Promise<BreedingRecordRow> {
    const record = await this.herd.lockBreeding(tx, id);
    if (record === null) throw new NotFoundError(`no breeding record ${id}`);
    return record;
  }

  private async audited(tx: Transaction, before: BreedingRecordRow, action: string): Promise<BreedingRecordView> {
    const [beforeView, view] = await this.viewsIn(tx, [before, (await this.herd.breeding(tx, [before.id]))[0]!]);
    await this.audit.record(tx, { module: 'liv', action, entityType: 'BreedingRecord', entityId: before.id, branchId: before.branchId, before: { ...beforeView! }, after: { ...view! } });
    return view!;
  }

  /** The dam's branch and pen: where a breeding write is authorised. */
  private async damScope(tx: Transaction, damId: string): Promise<{ branchId?: string; locationId?: string | null }> {
    const dam = (await this.store.animals(tx, [damId]))[0];
    if (dam === undefined) return {};
    const unit = (await this.units.factsIn(tx, [damId], this.clock.now())).get(damId);
    return { branchId: dam.branchId, locationId: unit?.currentLocationId ?? null };
  }

  private async recordScope(tx: Transaction, id: string): Promise<{ branchId?: string; locationId?: string | null }> {
    const record = (await this.herd.breeding(tx, [id]))[0];
    return record === undefined ? {} : this.damScope(tx, record.damId);
  }
}
