import { createUuidV7Generator, Money, Quantity, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, PrincipalNames } from '../../iam';
import type { Stock, StockUnits } from '../../inv';
import type { MasterDataRefs } from '../../mdm';
import { checkAnimalEdit, checkMove } from '../domain/herd';
import { averageDailyGain, type GrowthWeighing } from '../domain/growth';
import type { AnimalMoved, AnimalUpdated } from '../events';
import type { Animals, AnimalView } from './animals';
import { LivestockRecordInvalidError, LivReferenceNotFoundError } from './errors';
import type { HerdStore } from './herd-store';
import type { AnimalRecord, LivestockStore, Purpose, Sex } from './livestock-store';
import { afterOf, pageOf, pageProbe, runWrite, type Page } from './support';

export interface AnimalUpdateRequest {
  readonly version: number;
  readonly breed?: string | undefined;
  readonly purpose?: Purpose | undefined;
  readonly gradeId?: string | undefined;
  readonly sex?: Sex | undefined;
  readonly tagNo?: string | undefined;
}

export interface AnimalMoveRequest {
  readonly toLocationId: string;
  readonly note?: string | undefined;
}

type EventKind = 'ACQUIRED' | 'BORN' | 'WEIGHED' | 'TREATED' | 'VACCINATED' | 'MOVED' | 'MATED' | 'GAVE_BIRTH' | 'SOLD' | 'SLAUGHTERED' | 'DIED' | 'CULLED' | 'COST_ADDED';

/** The contract's `AnimalEvent`. */
export interface AnimalEventView {
  readonly at: string;
  readonly kind: EventKind;
  readonly summary: string;
  readonly document: { readonly id: string; readonly docType: string; readonly number: string | null } | null;
  readonly valuePesewas: number | null;
  readonly actor: { readonly id: string; readonly displayName: string } | null;
}

interface TimelineEntry {
  readonly at: Date;
  readonly kind: EventKind;
  readonly summary: string;
  readonly documentId: string | null;
  readonly value: bigint | null;
  readonly actorId: string | null;
  /** Orders entries at the same instant, and is what the cursor carries. */
  readonly key: string;
}

const SOURCE_TEXT: Readonly<Record<'WEIGHT' | 'SCALE' | 'MANUAL' | 'ESTIMATE', string>> = { WEIGHT: '', SCALE: 'by scale', MANUAL: 'entered by hand', ESTIMATE: 'estimated' };
const CLOSED_KIND: Readonly<Record<'SOLD' | 'SLAUGHTERED' | 'DEAD' | 'CULLED', EventKind>> = { SOLD: 'SOLD', SLAUGHTERED: 'SLAUGHTERED', DEAD: 'DIED', CULLED: 'CULLED' };
const HEALTH_TEXT: Readonly<Record<string, string>> = { VACCINATION: 'Vaccinated', TREATMENT: 'Treated', CHECK: 'Health check', DEWORMING: 'Dewormed' };
const cedis = (pesewas: bigint) => `GHS ${(pesewas / 100n).toLocaleString('en-GH')}.${(pesewas % 100n).toString().padStart(2, '0')}`;

/**
 * Edits, moves and the timeline of an animal (FR-LIV-002, FR-LIV-003; ADR-0018). An edit changes what the register
 * holds about an animal, never its cost: breed, sex and purpose (which decides whether later feed and veterinary cost
 * is capitalised or expensed), and its grade, which is its stock unit's and so inventory's to set. A move is a
 * TRANSFER_INTERNAL movement through INV's `Stock.postIn` from where inventory says the animal stands, which the
 * database insists on too; a hold does not stop it, and it changes no cost. Each write authorises first, at the
 * animal's branch and location (and the destination's), then runs serializable, idempotent, audited, with its event
 * through the outbox.
 */
export class AnimalCare {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: LivestockStore,
    private readonly herd: HerdStore,
    private readonly animals: Animals,
    private readonly refs: MasterDataRefs,
    private readonly units: StockUnits,
    private readonly stock: Stock,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly documents: DocumentRegistry,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  update(actor: Actor | undefined, id: string, body: AnimalUpdateRequest, idempotencyKey: string): Promise<StoredResponse<AnimalView>> {
    return runWrite(this.uow, this.authoriser, this.idempotency, actor, 'liv.animal.update', 'updateAnimal', { id, ...body }, idempotencyKey, (tx) => this.scopeOf(tx, id), async (tx, who) => {
      const before = await this.store.lockAnimal(tx, id);
      if (before === null) throw new NotFoundError(`no animal ${id}`);
      if (before.version !== body.version) throw new VersionConflictError(`animal ${id} is at version ${before.version}, not ${body.version}`);
      const broken = checkAnimalEdit({ status: before.status, sex: before.sex, tagNo: before.tagNo, isDam: await this.herd.isDam(tx, id) }, body);
      if (broken.length > 0) throw new LivestockRecordInvalidError(broken);
      if (body.gradeId !== undefined && (await this.refs.gradesIn(tx, [body.gradeId])).get(body.gradeId) === undefined) throw new LivReferenceNotFoundError(['/gradeId']);
      const now = this.clock.now();
      const [beforeView] = await this.animals.viewsIn(tx, [before], now);
      const set: Record<string, unknown> = {};
      if (body.breed !== undefined) set['breed'] = body.breed;
      if (body.sex !== undefined) set['sex'] = body.sex;
      if (body.purpose !== undefined) set['purpose'] = body.purpose;
      if (!(await this.herd.updateAnimal(tx, id, body.version, set, who.principalId))) throw new VersionConflictError(`animal ${id} changed while it was updated`);
      if (body.gradeId !== undefined) await this.units.setGradeIn(tx, who.principalId, id, body.gradeId);
      const after = (await this.store.animals(tx, [id]))[0]!;
      const [view] = await this.animals.viewsIn(tx, [after], now);
      await this.audit.record(tx, { module: 'liv', action: 'UPDATE', entityType: 'Animal', entityId: id, branchId: after.branchId, before: { ...beforeView! }, after: { ...view! } });
      await this.events.publish<AnimalUpdated>(tx, {
        type: 'liv.AnimalUpdated',
        subjectType: 'Animal',
        subjectId: id,
        branchId: after.branchId,
        occurredAt: now,
        payload: { stockUnitId: id, branchId: after.branchId, changed: Object.keys(body).filter((k) => k !== 'version'), purpose: after.purpose },
      });
      return { status: 200, body: view! };
    });
  }

  move(actor: Actor | undefined, id: string, body: AnimalMoveRequest, idempotencyKey: string): Promise<StoredResponse<AnimalView>> {
    return runWrite(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      'liv.animal.move',
      'moveAnimal',
      { id, ...body },
      idempotencyKey,
      async (tx) => {
        const here = await this.scopeOf(tx, id);
        const to = (await this.refs.locationsIn(tx, [body.toLocationId])).get(body.toLocationId);
        return to === undefined ? [here] : [here, { branchId: to.branchId, locationId: to.id }];
      },
      async (tx, who) => ({ status: 200, body: await this.moveIn(tx, who, id, body) }),
    );
  }

  /** Moves an animal in the caller's serializable transaction; the caller authorised it. */
  async moveIn(tx: Transaction, actor: Actor, id: string, body: AnimalMoveRequest): Promise<AnimalView> {
    const animal = await this.store.lockAnimal(tx, id);
    if (animal === null) throw new NotFoundError(`no animal ${id}`);
    const to = (await this.refs.locationsIn(tx, [body.toLocationId])).get(body.toLocationId);
    if (to === undefined) throw new LivReferenceNotFoundError(['/toLocationId']);
    const now = this.clock.now();
    const unit = (await this.units.factsIn(tx, [id], now)).get(id)!;
    const broken = checkMove({ alive: animal.status === 'ALIVE', branchId: animal.branchId, currentLocationId: unit.currentLocationId }, to);
    if (broken.length > 0) throw new LivestockRecordInvalidError(broken);
    const moveId = this.nextId();
    await this.documents.register(tx, { id: moveId, docType: 'ANIMAL_MOVE', ownerModule: 'liv', branchId: animal.branchId, actorId: actor.principalId });
    const movement = await this.stock.postIn(tx, actor.principalId, {
      movementType: 'TRANSFER_INTERNAL',
      productId: animal.productId,
      stockUnitId: id,
      branchId: animal.branchId,
      fromLocationId: unit.currentLocationId!,
      toLocationId: to.id,
      qty: Quantity.parse('1.000'),
      sourceDocumentId: moveId,
      occurredAt: now,
    });
    const record = { id: moveId, stockUnitId: id, branchId: animal.branchId, fromLocationId: unit.currentLocationId!, toLocationId: to.id, movementId: movement.id, note: body.note ?? null, occurredAt: now, actorId: actor.principalId };
    await this.herd.insertMove(tx, record);
    await this.audit.record(tx, { module: 'liv', action: 'MOVE', entityType: 'Animal', entityId: id, branchId: animal.branchId, before: { locationId: record.fromLocationId }, after: { locationId: to.id, movementId: movement.id, note: record.note } });
    await this.events.publish<AnimalMoved>(tx, {
      type: 'liv.AnimalMoved',
      subjectType: 'Animal',
      subjectId: id,
      branchId: animal.branchId,
      occurredAt: now,
      payload: { moveId, stockUnitId: id, branchId: animal.branchId, fromLocationId: record.fromLocationId, toLocationId: to.id, movementId: movement.id, occurredAt: now.toISOString() },
    });
    return (await this.animals.viewsIn(tx, [(await this.store.animals(tx, [id]))[0]!], now))[0]!;
  }

  /**
   * Everything that happened to an animal, oldest first (FR-LIV-003, FR-LIV-005): how it arrived, its weighings with
   * the daily gain since the one before, its treatments and vaccinations with the cost it carried, the feed cost spread
   * onto it, its moves, its matings and births, and how it left. Read from the register's own records; the stock
   * effects behind them are inventory's.
   */
  timeline(actor: Actor | undefined, id: string, cursor: string | undefined, limit: number): Promise<Page<AnimalEventView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const animal = (await this.store.animals(tx, [id]))[0];
      const facts = animal === undefined ? undefined : (await this.units.factsIn(tx, [id], this.clock.now())).get(id);
      await this.authoriser.authorise(tx, actor, 'liv.animal.read', animal === undefined ? {} : { branchId: animal.branchId, locationId: facts?.currentLocationId ?? null });
      if (animal === undefined) throw new NotFoundError(`no animal ${id}`);
      const binding = { operationId: 'listAnimalTimeline', principalId: actor!.principalId, filters: { id } };
      const after = afterOf(this.cursors, binding, cursor);
      // ISO instants sort as text, so the cursor key orders the timeline by time, then by the entry's own key.
      const keyOf = (e: TimelineEntry) => `${e.at.toISOString()}|${e.key}`;
      const entries = (await this.entriesOf(tx, animal, facts!.sourceDocumentId)).sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1));
      const rows = entries.filter((e) => after === null || keyOf(e) > after).slice(0, pageProbe(limit));
      return pageOf(this.cursors, binding, rows, limit, keyOf, await this.eventViews(tx, rows.slice(0, limit)));
    });
  }

  private async entriesOf(tx: Transaction, animal: AnimalRecord, sourceDocumentId: string): Promise<TimelineEntry[]> {
    const entries: TimelineEntry[] = [];
    const supplier = animal.supplierId === null ? null : (await this.refs.suppliersIn(tx, [animal.supplierId])).get(animal.supplierId)!;
    const dam = animal.damId === null ? null : (await this.store.animals(tx, [animal.damId]))[0]!;
    const born = animal.source === 'BIRTH';
    entries.push({
      // The day it arrived or was born, from its first moment, so it heads the timeline even when recorded later.
      at: new Date(`${animal.acquiredOn}T00:00:00.000Z`),
      kind: born ? 'BORN' : 'ACQUIRED',
      summary: born ? `Born to ${dam?.tagNo ?? 'its dam'} on ${animal.acquiredOn}` : supplier !== null ? `Bought from ${supplier.name} at ${cedis(animal.acquisitionCostPesewas)}` : `Opening stock at ${cedis(animal.acquisitionCostPesewas)}`,
      documentId: born ? animal.breedingRecordId : sourceDocumentId,
      value: animal.acquisitionCostPesewas,
      actorId: null,
      key: `0:${animal.stockUnitId}`,
    });
    const weighings = await this.herd.weighingsOf(tx, [animal.stockUnitId]);
    const seen: GrowthWeighing[] = [];
    for (const w of weighings) {
      const previous = seen.at(-1);
      const here = { at: w.measuredAt, day: toBusinessDate(w.measuredAt), kg: w.weightKg };
      const gain = previous === undefined ? null : averageDailyGain([previous, here]);
      seen.push(here);
      entries.push({ at: w.measuredAt, kind: 'WEIGHED', summary: `${w.weightKg} kg ${SOURCE_TEXT[w.weightSource]}${gain === null ? '' : `; average daily gain ${gain} kg`}`, documentId: null, value: null, actorId: w.actorId, key: `1:${w.id}` });
    }
    const health = await this.herd.healthOfUnit(tx, animal.stockUnitId);
    const medicines = await this.refs.productsIn(tx, health.flatMap((h) => (h.productId === null ? [] : [h.productId])));
    for (const h of health) {
      const medicine = h.productId === null ? '' : `, ${medicines.get(h.productId)!.name}`;
      entries.push({
        at: h.occurredAt,
        kind: h.kind === 'VACCINATION' ? 'VACCINATED' : 'TREATED',
        summary: `${HEALTH_TEXT[h.kind]}${medicine}${h.withdrawalDays > 0 ? `; withdrawal ${h.withdrawalDays} days` : ''}`,
        documentId: h.id,
        value: h.amountPesewas,
        actorId: h.actorId,
        key: `2:${h.id}`,
      });
    }
    const feed = await this.herd.feedOfUnit(tx, animal.stockUnitId);
    const pens = await this.refs.locationsIn(tx, feed.map((f) => f.locationId));
    for (const f of feed) {
      entries.push({
        at: f.postedAt,
        kind: 'COST_ADDED',
        summary: `Feed of ${f.consumedOn} ${f.treatment === 'CAPITALISED' ? 'added from' : 'expensed in'} ${pens.get(f.locationId)!.name}`,
        documentId: f.consumptionId,
        value: f.amountPesewas,
        actorId: f.actorId,
        key: `3:${f.consumptionId}`,
      });
    }
    const moves = await this.herd.movesOf(tx, animal.stockUnitId);
    const places = await this.refs.locationsIn(tx, moves.flatMap((m) => [m.fromLocationId, m.toLocationId]));
    for (const m of moves) {
      entries.push({ at: m.occurredAt, kind: 'MOVED', summary: `Moved from ${places.get(m.fromLocationId)!.name} to ${places.get(m.toLocationId)!.name}`, documentId: m.id, value: null, actorId: m.actorId, key: `4:${m.id}` });
    }
    for (const r of await this.herd.breedingOfDam(tx, animal.stockUnitId)) {
      entries.push({ at: r.createdAt, kind: 'MATED', summary: `Mated on ${r.matedOn}${r.expectedBirthOn === null ? '' : `; due ${r.expectedBirthOn}`}`, documentId: r.id, value: null, actorId: r.createdBy, key: `5:${r.id}` });
      if (r.status === 'BORN') {
        entries.push({ at: r.postedAt!, kind: 'GAVE_BIRTH', summary: `Gave birth on ${r.actualBirthOn}: ${r.liveBirths} live of ${r.litterSize}`, documentId: r.id, value: null, actorId: r.postedBy, key: `6:${r.id}` });
      }
    }
    if (animal.status !== 'ALIVE' && animal.statusChangedAt !== null) {
      const written = (await this.herd.mortalityOfUnit(tx, animal.stockUnitId))[0];
      entries.push({
        at: animal.statusChangedAt,
        kind: CLOSED_KIND[animal.status],
        summary: `${CLOSED_KIND[animal.status] === 'DIED' ? 'Died' : animal.status.charAt(0) + animal.status.slice(1).toLowerCase()}, leaving with ${cedis(animal.exitValuePesewas ?? 0n)} of cost`,
        documentId: written?.id ?? null,
        value: animal.exitValuePesewas,
        actorId: null,
        key: `7:${animal.stockUnitId}`,
      });
    }
    return entries;
  }

  private async eventViews(tx: Transaction, entries: readonly TimelineEntry[]): Promise<AnimalEventView[]> {
    const documents = await this.documents.refs(tx, entries.flatMap((e) => (e.documentId === null ? [] : [e.documentId])));
    const people = await this.principals.refs(tx, entries.flatMap((e) => (e.actorId === null ? [] : [e.actorId])));
    return entries.map((e) => {
      const document = e.documentId === null ? undefined : documents.get(e.documentId);
      const person = e.actorId === null ? undefined : people.get(e.actorId);
      return {
        at: e.at.toISOString(),
        kind: e.kind,
        summary: e.summary,
        document: document === undefined ? null : { id: document.id, docType: document.docType, number: document.number },
        valuePesewas: e.value === null ? null : Money.ofPesewas(e.value).toJsonInteger(),
        actor: person === undefined ? null : { id: person.id, displayName: person.displayName },
      };
    });
  }

  /** Where the animal stands, for its write's authorisation: its branch and current location, or none if unknown. */
  private async scopeOf(tx: Transaction, id: string): Promise<{ branchId?: string; locationId?: string | null }> {
    const animal = (await this.store.animals(tx, [id]))[0];
    if (animal === undefined) return {};
    const unit = (await this.units.factsIn(tx, [id], this.clock.now())).get(id);
    return { branchId: animal.branchId, locationId: unit?.currentLocationId ?? null };
  }
}
