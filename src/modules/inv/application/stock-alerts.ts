import { createUuidV7Generator, Quantity, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { exactlyInRuleUnit, inRuleUnit, wholeUnitsToReach, type RuleScale } from '../domain/rule-unit';
import {
  checkReorderLevels,
  daysToExpiry,
  expiryLeadDays,
  judgeExpiry,
  judgeLevels,
  suggestedQty,
  type ExpiryAlertKind,
  type LevelAlertKind,
  type StockAlertKind,
} from '../domain/stock-alert';
import { pageProbe } from './counting';
import { InvReferenceNotFoundError, ReorderRuleInvalidError } from './errors';
import { locationRef, productRef, readScopes, runStockCommand, unitRef, type LocationRefView, type Page, type StockUnitRefView } from './stock-command';
import type { ReorderRuleRecord, StockAlertFilters, StockAlertRecord, StockAlertStore } from './stock-alert-store';
import type { StockDocumentsStore } from './stock-documents-store';

/** Kinds of location that hold no stock a rule can count: in transit is not available (ADR-0048), a site holds none. */
const NOT_COUNTED_AT: ReadonlySet<string> = new Set(['IN_TRANSIT', 'SITE']);

export interface ReorderRuleCreateRequest {
  readonly productId: string;
  readonly branchId: string;
  readonly locationId?: string | undefined;
  /** The unit the three levels are counted in (a crate): the product's base unit when absent (B09e continued). */
  readonly uom?: string | undefined;
  readonly minQty: string;
  readonly reorderPointQty: string;
  readonly maxQty: string;
  readonly expiryAlertDays?: number | undefined;
}

/** The levels are counted in the rule's own unit, the one it was created with. */
export interface ReorderRuleUpdateRequest {
  readonly version: number;
  readonly minQty?: string | undefined;
  readonly reorderPointQty?: string | undefined;
  readonly maxQty?: string | undefined;
  readonly expiryAlertDays?: number | undefined;
}

/** The contract's `ReorderRule`. */
export interface ReorderRuleView {
  readonly id: string;
  readonly product: { readonly id: string; readonly sku: string; readonly name: string };
  readonly branchId: string;
  readonly location: LocationRefView | null;
  /** The unit the levels were entered in; `minQty`, `reorderPointQty` and `maxQty` are in it. */
  readonly uom: string;
  readonly minQty: string;
  readonly reorderPointQty: string;
  readonly maxQty: string;
  /** The product's base unit and the three levels in it, as stock is counted (B09e continued). */
  readonly baseUom: string;
  readonly minQtyBase: string;
  readonly reorderPointQtyBase: string;
  readonly maxQtyBase: string;
  readonly expiryAlertDays: number | null;
  readonly version: number;
}

/** A level alert of a rule counted in a selling unit, in that unit: whole units and the base units left over. */
export interface RuleUnitQuantities {
  readonly uom: string;
  readonly onHandQty: string;
  readonly onHandLooseQty: string;
  readonly thresholdQty: string | null;
  readonly suggestedQty: string | null;
}

/** The contract's `StockAlert`. */
export interface StockAlertView {
  readonly kind: StockAlertKind;
  readonly product: { readonly id: string; readonly sku: string; readonly name: string };
  readonly location: LocationRefView | null;
  readonly stockUnit: StockUnitRefView | null;
  readonly uom: string;
  readonly onHandQty: string;
  readonly thresholdQty: string | null;
  readonly suggestedQty: string | null;
  readonly expiresOn: string | null;
  readonly daysToExpiry: number | null;
  /** The same figures in the rule's selling unit (B09e continued); null for an expiry alert or a rule in the base unit. */
  readonly inRuleUnit: RuleUnitQuantities | null;
  readonly raisedAt: string;
}

/** `inv.StockAlertRaised` v1: a low-stock, below-minimum, expiring or expired alert was raised, once per crossing. */
export interface StockAlertRaised {
  readonly alertId: string;
  readonly kind: StockAlertKind;
  readonly productId: string;
  readonly locationId: string | null;
  readonly stockUnitId: string | null;
  readonly qty: string;
  readonly thresholdQty: string | null;
  readonly suggestedQty: string | null;
  readonly expiresOn: string | null;
}

/**
 * Reorder rules and stock alerts (FR-INV-015, FR-INV-016). A rule per product and branch, or one location of it, holds
 * the minimum, reorder point and maximum and the expiry lead time. Whenever available stock changes (a movement posted
 * through `Stock.postIn`, a reservation made or ended, a hold placed or released) `evaluateIn` judges the product's
 * rules in that same transaction: an alert is raised once when available stock falls to or below a level, published
 * as `inv.StockAlertRaised` through the outbox, and cleared once it rises above, so a further sale raises nothing.
 * The daily `stock-alerts` job (`StockAlertSweep`) judges every rule again and raises the expiry alerts. Rule writes
 * are serializable, idempotent and audited; alerts are listed open, newest first, within the reader's grants.
 */
export class StockAlerts {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: StockAlertStore,
    private readonly documentsStore: StockDocumentsStore,
    private readonly refs: MasterDataRefs,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /**
   * Judges the level alerts of the rules of these products (all rules when null) against available stock now, in the
   * caller's transaction: raises what has crossed, clears what has recovered. Answers how many it raised and cleared.
   */
  async evaluateIn(tx: Transaction, actorId: string, productIds: readonly string[] | null): Promise<{ readonly raised: number; readonly cleared: number }> {
    if (productIds !== null && productIds.length === 0) return { raised: 0, cleared: 0 };
    const levels = await this.store.levels(tx, productIds === null ? null : [...new Set(productIds)]);
    if (levels.length === 0) return { raised: 0, cleared: 0 };
    const open = await this.store.openLevelAlerts(tx, levels.map((l) => l.reorderRuleId));
    const now = this.clock.now();
    let raised = 0;
    let cleared = 0;
    for (const level of levels) {
      const mine = open.filter((a) => a.reorderRuleId === level.reorderRuleId);
      const available = Quantity.parse(level.availableQty);
      const judged = judgeLevels(
        available,
        { minQty: Quantity.parse(level.minQty), reorderPointQty: Quantity.parse(level.reorderPointQty), maxQty: Quantity.parse(level.maxQty) },
        new Set<LevelAlertKind>(mine.map((a) => a.kind)),
      );
      for (const kind of judged.clear) {
        await this.store.clearAlert(tx, mine.find((a) => a.kind === kind)!.id, now, actorId);
        cleared += 1;
      }
      for (const alert of judged.raise) {
        const inserted = await this.raise(tx, actorId, now, {
          id: this.nextId(),
          kind: alert.kind,
          branchId: level.branchId,
          productId: level.productId,
          locationId: level.locationId,
          stockUnitId: null,
          reorderRuleId: level.reorderRuleId,
          qty: available.toDecimalString(),
          thresholdQty: alert.thresholdQty.toDecimalString(),
          suggestedQty: alert.suggestedQty.toDecimalString(),
          expiresOn: null,
        });
        if (inserted) raised += 1;
      }
    }
    return { raised, cleared };
  }

  /** The expiry alerts of every dated lot where it stands, as of today in Africa/Accra (FR-INV-016). */
  async evaluateExpiryIn(tx: Transaction, actorId: string): Promise<{ readonly raised: number; readonly cleared: number }> {
    const now = this.clock.now();
    const today = toBusinessDate(now);
    const lots = await this.store.datedLots(tx);
    const rules = await this.store.leadTimes(tx, lots.map((l) => l.productId));
    const open = await this.store.openExpiryAlerts(tx);
    const seen = new Set<string>();
    let raised = 0;
    let cleared = 0;
    const clear = async (alerts: ReadonlyArray<{ readonly id: string }>) => {
      for (const alert of alerts) {
        await this.store.clearAlert(tx, alert.id, now, actorId);
        cleared += 1;
      }
    };
    for (const lot of lots) {
      const key = `${lot.stockUnitId}:${lot.locationId}`;
      seen.add(key);
      const rule =
        rules.find((r) => r.productId === lot.productId && r.branchId === lot.branchId && r.locationId === lot.locationId) ??
        rules.find((r) => r.productId === lot.productId && r.branchId === lot.branchId && r.locationId === null);
      const mine = open.filter((a) => a.stockUnitId === lot.stockUnitId && a.locationId === lot.locationId);
      const judged = judgeExpiry({ expiresOn: lot.expiresOn, onHand: Quantity.parse(lot.onHandQty) }, today, expiryLeadDays(rule?.expiryAlertDays), new Set<ExpiryAlertKind>(mine.map((a) => a.kind)));
      await clear(mine.filter((a) => judged.clear.includes(a.kind)));
      if (judged.raise !== null) {
        const inserted = await this.raise(tx, actorId, now, {
          id: this.nextId(),
          kind: judged.raise,
          branchId: lot.branchId,
          productId: lot.productId,
          locationId: lot.locationId,
          stockUnitId: lot.stockUnitId,
          reorderRuleId: null,
          qty: lot.onHandQty,
          thresholdQty: null,
          suggestedQty: null,
          expiresOn: lot.expiresOn,
        });
        if (inserted) raised += 1;
      }
    }
    // A lot with nothing left where it was alerted needs no alert there.
    await clear(open.filter((a) => !seen.has(`${a.stockUnitId}:${a.locationId}`)));
    return { raised, cleared };
  }

  listRules(actor: Actor | undefined, filters: { readonly productId?: string | undefined; readonly branchId?: string | undefined }, cursor: string | undefined, limit: number): Promise<Page<ReorderRuleView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'inv.reorder_rule.read', filters.branchId === undefined ? {} : { branchId: filters.branchId });
      const scopes = readScopes(await this.authoriser.scopes(tx, actor!, 'inv.reorder_rule.read'));
      const binding = { operationId: 'listReorderRules', principalId: actor!.principalId, filters: { ...filters } };
      const after = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.rules(tx, filters, scopes, after, pageProbe(limit));
      const data = found.slice(0, limit);
      const last = data.at(-1);
      const hasMore = found.length > limit;
      return { data: await this.ruleViews(tx, data), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  createRule(actor: Actor | undefined, body: ReorderRuleCreateRequest, idempotencyKey: string): Promise<StoredResponse<ReorderRuleView>> {
    return runStockCommand(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      'inv.reorder_rule.manage',
      'createReorderRule',
      body,
      idempotencyKey,
      async () => (body.locationId === undefined ? { branchId: body.branchId } : { branchId: body.branchId, locationId: body.locationId }),
      async (tx) => {
        const product = (await this.refs.productsIn(tx, [body.productId])).get(body.productId);
        const branch = (await this.refs.branchesIn(tx, [body.branchId])).get(body.branchId);
        const location = body.locationId === undefined ? undefined : (await this.refs.locationsIn(tx, [body.locationId])).get(body.locationId);
        const missing = [
          ...(product === undefined || !product.isLive ? ['/productId'] : []),
          ...(branch === undefined ? ['/branchId'] : []),
          ...(body.locationId !== undefined && (location === undefined || !location.isLive) ? ['/locationId'] : []),
        ];
        if (missing.length > 0) throw new InvReferenceNotFoundError(missing);
        const uom = body.uom === undefined || body.uom === product!.baseUom ? null : body.uom;
        const levels = await this.baseLevelsIn(tx, product!.id, uom, { minQty: body.minQty, reorderPointQty: body.reorderPointQty, maxQty: body.maxQty });
        if (!levels.ok) throw new ReorderRuleInvalidError(levels.broken);
        const broken = checkReorderLevels(
          { minQty: levels.base.minQty, reorderPointQty: levels.base.reorderPointQty, maxQty: levels.base.maxQty },
          body.expiryAlertDays ?? null,
        );
        if (product!.stockPolicy === 'NON_STOCK') broken.push({ field: '/productId', rule: 'NOT_A_STOCK_PRODUCT' });
        if (location !== undefined) {
          if (location.isVirtual || NOT_COUNTED_AT.has(location.kind)) broken.push({ field: '/locationId', rule: 'NOT_A_STOCK_LOCATION' });
          else if (location.branchId !== body.branchId) broken.push({ field: '/locationId', rule: 'NOT_IN_THE_BRANCH' });
        }
        if ((await this.store.ruleFor(tx, body.productId, body.branchId, body.locationId ?? null)) !== null) broken.push({ field: '/productId', rule: 'RULE_EXISTS' });
        if (broken.length > 0) throw new ReorderRuleInvalidError(broken);
        const id = this.nextId();
        await this.store.insertRule(
          tx,
          {
            id,
            productId: body.productId,
            branchId: body.branchId,
            locationId: body.locationId ?? null,
            minQty: levels.base.minQty.toDecimalString(),
            reorderPointQty: levels.base.reorderPointQty.toDecimalString(),
            maxQty: levels.base.maxQty.toDecimalString(),
            uom,
            minQtyUom: uom === null ? null : Quantity.parse(body.minQty).toDecimalString(),
            reorderPointQtyUom: uom === null ? null : Quantity.parse(body.reorderPointQty).toDecimalString(),
            maxQtyUom: uom === null ? null : Quantity.parse(body.maxQty).toDecimalString(),
            expiryAlertDays: body.expiryAlertDays ?? null,
          },
          actor!.principalId,
        );
        const after = (await this.store.rule(tx, id))!;
        await this.audit.record(tx, { module: 'inv', action: 'CREATE', entityType: 'ReorderRule', entityId: id, branchId: body.branchId, before: null, after: { ...after } });
        await this.evaluateIn(tx, actor!.principalId, [body.productId]);
        return { status: 201, body: (await this.ruleViews(tx, [after]))[0]! };
      },
    );
  }

  updateRule(actor: Actor | undefined, id: string, body: ReorderRuleUpdateRequest, idempotencyKey: string): Promise<StoredResponse<ReorderRuleView>> {
    return runStockCommand(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      'inv.reorder_rule.manage',
      'updateReorderRule',
      { id, ...body },
      idempotencyKey,
      async (tx) => {
        const rule = await this.store.rule(tx, id);
        if (rule === null) return {};
        return rule.locationId === null ? { branchId: rule.branchId } : { branchId: rule.branchId, locationId: rule.locationId };
      },
      async (tx) => {
        const before = await this.store.lockRule(tx, id);
        if (before === null) throw new NotFoundError(`no reorder rule ${id}`);
        if (before.version !== body.version) throw new VersionConflictError(`reorder rule ${id} is at version ${before.version}, not ${body.version}`);
        // The levels are counted in the rule's own unit; all three are converted again, as entered, by the live factor.
        const entered = {
          minQty: Quantity.parse(body.minQty ?? before.minQtyUom ?? before.minQty).toDecimalString(),
          reorderPointQty: Quantity.parse(body.reorderPointQty ?? before.reorderPointQtyUom ?? before.reorderPointQty).toDecimalString(),
          maxQty: Quantity.parse(body.maxQty ?? before.maxQtyUom ?? before.maxQty).toDecimalString(),
        };
        const converted = await this.baseLevelsIn(tx, before.productId, before.uom, entered);
        if (!converted.ok) throw new ReorderRuleInvalidError(converted.broken);
        const levels = {
          minQty: converted.base.minQty.toDecimalString(),
          reorderPointQty: converted.base.reorderPointQty.toDecimalString(),
          maxQty: converted.base.maxQty.toDecimalString(),
          minQtyUom: before.uom === null ? null : entered.minQty,
          reorderPointQtyUom: before.uom === null ? null : entered.reorderPointQty,
          maxQtyUom: before.uom === null ? null : entered.maxQty,
          expiryAlertDays: body.expiryAlertDays ?? before.expiryAlertDays,
        };
        const broken = checkReorderLevels(
          { minQty: converted.base.minQty, reorderPointQty: converted.base.reorderPointQty, maxQty: converted.base.maxQty },
          levels.expiryAlertDays,
        );
        if (broken.length > 0) throw new ReorderRuleInvalidError(broken);
        if (!(await this.store.updateRule(tx, id, body.version, levels, actor!.principalId))) {
          throw new VersionConflictError(`reorder rule ${id} changed while it was updated`);
        }
        const after = (await this.store.rule(tx, id))!;
        await this.audit.record(tx, { module: 'inv', action: 'UPDATE', entityType: 'ReorderRule', entityId: id, branchId: after.branchId, before: { ...before }, after: { ...after } });
        await this.evaluateIn(tx, actor!.principalId, [after.productId]);
        return { status: 200, body: (await this.ruleViews(tx, [after]))[0]! };
      },
    );
  }

  listAlerts(actor: Actor | undefined, filters: StockAlertFilters, cursor: string | undefined, limit: number): Promise<Page<StockAlertView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'inv.stock.read', filters.branchId === undefined ? {} : { branchId: filters.branchId });
      const scopes = readScopes(await this.authoriser.scopes(tx, actor!, 'inv.stock.read'));
      const binding = { operationId: 'listStockAlerts', principalId: actor!.principalId, filters: { ...filters } };
      const decoded = cursor === undefined ? null : this.cursors.decode(cursor, binding);
      const after = decoded === null ? null : { raisedAt: decoded['raisedAt'] as string, id: decoded['id'] as string };
      const found = await this.store.alerts(tx, filters, scopes, after, pageProbe(limit));
      const data = found.slice(0, limit);
      const last = data.at(-1);
      const hasMore = found.length > limit;
      return {
        data: await this.alertViews(tx, data),
        page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { raisedAt: last.raisedAt.toISOString(), id: last.id }) : null, limit, hasMore },
      };
    });
  }

  /**
   * A rule's three levels in the product's base unit: as entered when `uom` is null (the base unit), otherwise each
   * converted through `MasterDataRefs.toBaseIn`, never by a factor of the rule's own (B09e continued). A unit the
   * product does not convert from, or a level that would need a fourth decimal place, is refused.
   */
  private async baseLevelsIn(
    tx: Transaction,
    productId: string,
    uom: string | null,
    entered: { readonly minQty: string; readonly reorderPointQty: string; readonly maxQty: string },
  ): Promise<{ readonly ok: true; readonly base: { readonly minQty: Quantity; readonly reorderPointQty: Quantity; readonly maxQty: Quantity } } | { readonly ok: false; readonly broken: Array<{ field: string; rule: string }> }> {
    const fields = ['minQty', 'reorderPointQty', 'maxQty'] as const;
    if (uom === null) return { ok: true, base: { minQty: Quantity.parse(entered.minQty), reorderPointQty: Quantity.parse(entered.reorderPointQty), maxQty: Quantity.parse(entered.maxQty) } };
    const base: Partial<Record<(typeof fields)[number], Quantity>> = {};
    const broken: Array<{ field: string; rule: string }> = [];
    for (const field of fields) {
      const converted = await this.refs.toBaseIn(tx, productId, uom, Quantity.parse(entered[field]));
      if (converted.ok) base[field] = converted.value;
      else if (converted.error === 'INEXACT_QUANTITY') broken.push({ field: `/${field}`, rule: 'INEXACT_QUANTITY' });
      else return { ok: false, broken: [{ field: '/uom', rule: 'NO_CONVERSION' }] };
    }
    if (broken.length > 0) return { ok: false, broken };
    return { ok: true, base: { minQty: base.minQty!, reorderPointQty: base.reorderPointQty!, maxQty: base.maxQty! } };
  }

  private async raise(tx: Transaction, actorId: string, at: Date, alert: Omit<StockAlertRecord, 'raisedAt'>): Promise<boolean> {
    if (!(await this.store.raiseAlert(tx, alert, at, actorId))) return false;
    await this.events.publish<StockAlertRaised>(tx, {
      type: 'inv.StockAlertRaised',
      subjectType: 'StockAlert',
      subjectId: alert.id,
      branchId: alert.branchId,
      occurredAt: at,
      payload: {
        alertId: alert.id,
        kind: alert.kind,
        productId: alert.productId,
        locationId: alert.locationId,
        stockUnitId: alert.stockUnitId,
        qty: alert.qty,
        thresholdQty: alert.thresholdQty,
        suggestedQty: alert.suggestedQty,
        expiresOn: alert.expiresOn,
      },
    });
    return true;
  }

  private async ruleViews(tx: Transaction, rules: readonly ReorderRuleRecord[]): Promise<ReorderRuleView[]> {
    const products = await this.refs.productsIn(tx, rules.map((r) => r.productId));
    const locations = await this.refs.locationsIn(tx, rules.flatMap((r) => (r.locationId === null ? [] : [r.locationId])));
    return rules.map((r) => {
      const product = products.get(r.productId)!;
      return {
        id: r.id,
        product: productRef(product),
        branchId: r.branchId,
        location: r.locationId === null ? null : locationRef(locations.get(r.locationId)!),
        uom: r.uom ?? product.baseUom,
        minQty: r.minQtyUom ?? r.minQty,
        reorderPointQty: r.reorderPointQtyUom ?? r.reorderPointQty,
        maxQty: r.maxQtyUom ?? r.maxQty,
        baseUom: product.baseUom,
        minQtyBase: r.minQty,
        reorderPointQtyBase: r.reorderPointQty,
        maxQtyBase: r.maxQty,
        expiryAlertDays: r.expiryAlertDays,
        version: r.version,
      };
    });
  }

  /** Alerts with what stands now: available stock against a level, or the lot's on hand where it was alerted. */
  private async alertViews(tx: Transaction, alerts: readonly StockAlertRecord[]): Promise<StockAlertView[]> {
    const products = await this.refs.productsIn(tx, alerts.map((a) => a.productId));
    const locations = await this.refs.locationsIn(tx, alerts.flatMap((a) => (a.locationId === null ? [] : [a.locationId])));
    const units = await this.documentsStore.units(tx, alerts.flatMap((a) => (a.stockUnitId === null ? [] : [a.stockUnitId])));
    const levels = new Map((await this.store.levels(tx, alerts.filter((a) => a.reorderRuleId !== null).map((a) => a.productId))).map((l) => [l.reorderRuleId, l] as const));
    const onHand = await this.store.unitOnHand(tx, alerts.flatMap((a) => (a.stockUnitId === null || a.locationId === null ? [] : [{ stockUnitId: a.stockUnitId, locationId: a.locationId }])));
    const rules = new Map<string, ReorderRuleRecord>();
    for (const ruleId of new Set(alerts.flatMap((a) => (a.reorderRuleId === null ? [] : [a.reorderRuleId])))) {
      const rule = await this.store.rule(tx, ruleId);
      if (rule !== null) rules.set(ruleId, rule);
    }
    const today = toBusinessDate(this.clock.now());
    return alerts.map((a) => {
      const product = products.get(a.productId)!;
      const level = a.reorderRuleId === null ? undefined : levels.get(a.reorderRuleId);
      const current = level !== undefined ? level.availableQty : a.stockUnitId !== null ? (onHand.get(`${a.stockUnitId}:${a.locationId}`) ?? '0.000') : a.qty;
      const suggested = level === undefined ? null : suggestedQty(Quantity.parse(level.availableQty), Quantity.parse(level.maxQty));
      const rule = a.reorderRuleId === null ? undefined : rules.get(a.reorderRuleId);
      return {
        kind: a.kind,
        product: productRef(product),
        location: a.locationId === null ? null : locationRef(locations.get(a.locationId)!),
        stockUnit: a.stockUnitId === null ? null : unitRef(units.get(a.stockUnitId)),
        uom: product.baseUom,
        onHandQty: Quantity.parse(current).toDecimalString(),
        thresholdQty: a.thresholdQty,
        suggestedQty: suggested?.toDecimalString() ?? null,
        expiresOn: a.expiresOn,
        daysToExpiry: a.expiresOn === null ? null : daysToExpiry(a.expiresOn, today),
        inRuleUnit: rule === undefined ? null : ruleUnitQuantities(rule, Quantity.parse(current), a.thresholdQty, suggested),
        raisedAt: a.raisedAt.toISOString(),
      };
    });
  }
}

/**
 * A level alert's figures in its rule's selling unit (B09e continued, the owner's decision 6): on hand as whole units and
 * what is left over in the base unit, the level crossed as the rule counts it, and the suggested reorder in whole units
 * rounded up so the order reaches the maximum. The rule's own maximum, as entered and as stored, is the scale. Null for
 * a rule in the base unit, which the base figures already answer.
 */
function ruleUnitQuantities(rule: ReorderRuleRecord, available: Quantity, thresholdBase: string | null, suggestedBase: Quantity | null): RuleUnitQuantities | null {
  if (rule.uom === null || rule.maxQtyUom === null) return null;
  const scale: RuleScale = { uomQty: Quantity.parse(rule.maxQtyUom), baseQty: Quantity.parse(rule.maxQty) };
  const onHand = inRuleUnit(available, scale);
  return {
    uom: rule.uom,
    onHandQty: onHand.whole.toDecimalString(),
    onHandLooseQty: onHand.loose.toDecimalString(),
    // The level was entered in the unit, so it converts back exactly; one that does not stays null, never rounded.
    thresholdQty: thresholdBase === null ? null : (exactlyInRuleUnit(Quantity.parse(thresholdBase), scale)?.toDecimalString() ?? null),
    suggestedQty: suggestedBase === null ? null : wholeUnitsToReach(suggestedBase, scale).toDecimalString(),
  };
}

/**
 * The daily `stock-alerts` job (FR-INV-015, FR-INV-016; docs/OPERATIONS.md): every reorder rule judged again, so a
 * change no transaction saw (a hold ending by time) still raises or clears its alert, and every dated lot's expiry
 * alerts. Serializable, as the in-transaction checks it races with; it never touches stock.
 */
export class StockAlertSweep {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly alerts: StockAlerts,
  ) {}

  run(system: Pick<Actor, 'kind' | 'principalId'>): Promise<Record<string, number>> {
    if (system.kind !== 'SYSTEM') throw new Error('the stock alert sweep runs as a SYSTEM principal only');
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const levels = await this.alerts.evaluateIn(tx, system.principalId, null);
      const expiry = await this.alerts.evaluateExpiryIn(tx, system.principalId);
      return { levelRaised: levels.raised, levelCleared: levels.cleared, expiryRaised: expiry.raised, expiryCleared: expiry.cleared };
    });
  }
}
