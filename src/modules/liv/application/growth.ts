import { toBusinessDate } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { Cursors } from '../../../platform/http/cursor';
import type { Authoriser } from '../../iam';
import type { StockUnits, UnitOnHand } from '../../inv';
import type { MasterDataRefs } from '../../mdm';
import { headOf } from '../domain/cost-spread';
import { feedShare, groupGrowth, type GrowthMember } from '../domain/growth';
import { LivestockRecordInvalidError } from './errors';
import type { HerdStore, WindowFeedRow } from './herd-store';
import type { WeightRecord } from './livestock-store';
import { afterOf, pageOf, pageProbe, readScopeOf, type Page } from './support';

export interface GrowthQuery {
  readonly groupBy: 'PEN' | 'BATCH';
  readonly from: string;
  readonly to: string;
  readonly speciesId?: string | undefined;
}

/** The contract's `GrowthRow`. */
export interface GrowthRowView {
  readonly group: { readonly id: string; readonly code: string; readonly name: string; readonly kind: 'PEN' | 'BATCH' };
  readonly species: { readonly id: string; readonly code: string; readonly name: string };
  readonly head: number;
  readonly startAverageKg: string | null;
  readonly endAverageKg: string | null;
  readonly averageDailyGainKg: string | null;
  readonly feedQty: string | null;
  readonly feedConversionRatio: string | null;
  readonly mortalityPercent: string;
}

interface Row {
  readonly key: string;
  readonly view: GrowthRowView;
}

interface UnitInfo {
  readonly id: string;
  readonly speciesId: string;
  readonly tracking: 'SERIAL' | 'LOT';
}

/** The last millisecond of a business day. Africa/Accra keeps GMT all year, so its days are UTC days. */
const END_OF_DAY = 'T23:59:59.999Z';
const START_OF_DAY = 'T00:00:00.000Z';

/**
 * Growth, feed conversion and mortality by pen or batch over a window of business days (FR-LIV-005, FR-LIV-016,
 * SA-21; A-159). A pen's members are the animals and flocks inventory had standing there both when the window opened
 * and when it closed; a batch's member is its flock's lot, if it had head at both ends. Their weighings inside the
 * window give the averages and the daily gain (domain `groupGrowth`); the feed is the posted consumptions of the
 * window, a pen taking what was issued to it and a batch its head-day share, both for the group's species; mortality
 * is the posted deaths in the window over the head at its start. Read-only, at read committed, scoped to the branches
 * and locations the actor may read.
 */
export class Growth {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly herd: HerdStore,
    private readonly refs: MasterDataRefs,
    private readonly units: StockUnits,
    private readonly authoriser: Authoriser,
    private readonly cursors: Cursors,
  ) {}

  list(actor: Actor | undefined, query: GrowthQuery, cursor: string | undefined, limit: number): Promise<Page<GrowthRowView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'liv.report.read');
      if (query.from > query.to) throw new LivestockRecordInvalidError([{ field: '/from', rule: 'WINDOW_BACKWARDS' }]);
      const scope = await readScopeOf(tx, this.authoriser, this.units, actor!, 'liv.report.read');
      const locationBranches = [...(await this.refs.locationsIn(tx, scope.locationIds)).values()].map((l) => l.branchId);
      const branchIds = [...new Set([...scope.branchIds, ...locationBranches])];
      const visible = (branchId: string, locationId: string | null) => scope.branchIds.includes(branchId) || (locationId !== null && scope.locationIds.includes(locationId));
      const start = new Date(`${query.from}${START_OF_DAY}`);
      const end = new Date(`${query.to}${END_OF_DAY}`);
      const rows = query.groupBy === 'PEN' ? await this.pens(tx, branchIds, query, start, end, visible) : await this.batches(tx, branchIds, query, start, end, visible);
      rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const binding = { operationId: 'listGrowth', principalId: actor!.principalId, filters: { ...query } };
      const after = afterOf(this.cursors, binding, cursor);
      const page = rows.filter((r) => after === null || r.key > after).slice(0, pageProbe(limit));
      return pageOf(this.cursors, binding, page, limit, (r) => r.key, page.slice(0, limit).map((r) => r.view));
    });
  }

  private async pens(tx: Transaction, branchIds: readonly string[], query: GrowthQuery, start: Date, end: Date, visible: (branchId: string, locationId: string | null) => boolean): Promise<Row[]> {
    const animals = await this.herd.livestockOf(tx, branchIds, start);
    const flocks = await this.herd.batchesInWindow(tx, branchIds, undefined, start, query.to);
    const info = new Map<string, UnitInfo>([
      ...animals.map((a) => [a.stockUnitId, { id: a.stockUnitId, speciesId: a.speciesId, tracking: 'SERIAL' as const }] as const),
      ...flocks.map((b) => [b.stockUnitId!, { id: b.stockUnitId!, speciesId: b.speciesId, tracking: 'LOT' as const }] as const),
    ]);
    const ids = [...info.keys()];
    const [atStart, atEnd] = [await this.units.onHandAsOfIn(tx, ids, start), await this.units.onHandAsOfIn(tx, ids, end)];
    const weighings = await this.herd.weighingsOf(tx, ids, start, end);
    const deaths = await this.herd.deathsOf(tx, ids, start, end);
    const feed = await this.herd.feedInWindow(tx, branchIds, query.from, query.to);
    const groups = new Map<string, { locationId: string; speciesId: string }>();
    for (const held of [...atStart, ...atEnd]) {
      const speciesId = info.get(held.id)!.speciesId;
      if (query.speciesId !== undefined && speciesId !== query.speciesId) continue;
      groups.set(`${held.locationId}|${speciesId}`, { locationId: held.locationId, speciesId });
    }
    const locations = await this.refs.locationsIn(tx, [...groups.values()].map((g) => g.locationId));
    const species = await this.refs.speciesIn(tx, [...groups.values()].map((g) => g.speciesId));
    const rows: Row[] = [];
    for (const group of groups.values()) {
      const location = locations.get(group.locationId)!;
      if (!visible(location.branchId, location.id)) continue;
      const here = (list: readonly UnitOnHand[]) => list.filter((u) => u.locationId === group.locationId && info.get(u.id)!.speciesId === group.speciesId);
      const startHere = here(atStart);
      const endHere = new Map(here(atEnd).map((u) => [u.id, u] as const));
      const members = startHere.filter((u) => endHere.has(u.id)).map((u) => this.member(endHere.get(u.id)!, weighings));
      const ofSpecies = new Set([...info.values()].filter((u) => u.speciesId === group.speciesId).map((u) => u.id));
      const feedQty = this.feedOf(feed.filter((f) => f.locationId === group.locationId), ofSpecies);
      const dead = deaths.filter((d) => d.locationId === group.locationId && ofSpecies.has(d.stockUnitId)).reduce((sum, d) => sum + BigInt(d.head), 0n);
      const headAtStart = startHere.reduce((sum, u) => sum + headOf(u.tracking, u.onHandQty), 0n);
      const figures = groupGrowth(members, feedQty, dead, headAtStart);
      const kind = species.get(group.speciesId)!;
      rows.push({
        key: `${location.code}|${kind.code}|${location.id}`,
        view: this.view({ id: location.id, code: location.code, name: location.name, kind: 'PEN' }, kind, figures, feedQty),
      });
    }
    return rows;
  }

  private async batches(tx: Transaction, branchIds: readonly string[], query: GrowthQuery, start: Date, end: Date, visible: (branchId: string, locationId: string | null) => boolean): Promise<Row[]> {
    const batches = await this.herd.batchesInWindow(tx, branchIds, query.speciesId, start, query.to);
    const ids = batches.map((b) => b.stockUnitId!);
    const [atStart, atEnd] = [await this.units.onHandAsOfIn(tx, ids, start), await this.units.onHandAsOfIn(tx, ids, end)];
    const weighings = await this.herd.weighingsOf(tx, ids, start, end);
    const deaths = await this.herd.deathsOf(tx, ids, start, end);
    const feed = await this.herd.feedInWindow(tx, branchIds, query.from, query.to);
    const species = await this.refs.speciesIn(tx, batches.map((b) => b.speciesId));
    const rows: Row[] = [];
    for (const batch of batches) {
      const lot = batch.stockUnitId!;
      if (!visible(batch.branchId, batch.locationId)) continue;
      const headAt = (list: readonly UnitOnHand[]) => list.filter((u) => u.id === lot).reduce((sum, u) => sum + headOf('LOT', u.onHandQty), 0n);
      const headAtStart = headAt(atStart);
      const headAtEnd = headAt(atEnd);
      const members: GrowthMember[] = headAtStart > 0n && headAtEnd > 0n ? [{ head: headAtEnd, weighings: this.weighingsOf(lot, weighings) }] : [];
      const feedQty = this.feedOf(feed, new Set([lot]));
      const dead = deaths.filter((d) => d.stockUnitId === lot).reduce((sum, d) => sum + BigInt(d.head), 0n);
      const figures = groupGrowth(members, feedQty, dead, headAtStart);
      rows.push({ key: `${batch.batchNo}|${batch.id}`, view: this.view({ id: batch.id, code: batch.batchNo, name: batch.batchNo, kind: 'BATCH' }, species.get(batch.speciesId)!, figures, feedQty) });
    }
    return rows;
  }

  private member(unit: UnitOnHand, weighings: readonly WeightRecord[]): GrowthMember {
    return { head: headOf(unit.tracking, unit.onHandQty), weighings: this.weighingsOf(unit.id, weighings) };
  }

  private weighingsOf(unitId: string, weighings: readonly WeightRecord[]) {
    return weighings.filter((w) => w.stockUnitId === unitId).map((w) => ({ at: w.measuredAt, day: toBusinessDate(w.measuredAt), kg: w.weightKg }));
  }

  /** The units' head-day share of each issue they took part in; null when none of them was fed in the window. */
  private feedOf(issues: readonly WindowFeedRow[], unitIds: ReadonlySet<string>): string | null {
    const shared = issues.flatMap((issue) => {
      const share = issue.shares.filter((s) => unitIds.has(s.stockUnitId)).reduce((sum, s) => sum + s.headDays, 0n);
      const total = issue.shares.reduce((sum, s) => sum + s.headDays, 0n);
      return share === 0n ? [] : [{ qty: issue.qty, share, total }];
    });
    return shared.length === 0 ? null : feedShare(shared);
  }

  private view(group: GrowthRowView['group'], species: { id: string; code: string; name: string }, figures: ReturnType<typeof groupGrowth>, feedQty: string | null): GrowthRowView {
    return {
      group,
      species: { id: species.id, code: species.code, name: species.name },
      head: Number(figures.head),
      startAverageKg: figures.startAverageKg,
      endAverageKg: figures.endAverageKg,
      averageDailyGainKg: figures.averageDailyGainKg,
      feedQty,
      feedConversionRatio: figures.feedConversionRatio,
      mortalityPercent: figures.mortalityPercent,
    };
  }
}
