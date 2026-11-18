import { Money, Quantity, Weight, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { ForbiddenError, NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import { extendPrice, type PriceBasis, type PricingService } from '../../mdm';
import { isUuidV7 } from '../domain/client-time';
import { heldSaleExpiry, indexOfLineNo, judgeHold, judgeRecall, lineNoOf } from '../domain/held-sale';
import { heldTotal } from '../domain/held-sale-total';
import type { Devices } from './devices';
import { HeldSaleInvalidError, ShiftNotOpenError, type TillRule } from './errors';
import { oneMore } from './paging';
import type { Page } from './shifts';
import type { HeldSalePayload, HeldSaleRecord, RegisterRecord, TillStore } from './till-store';

const SELL = 'pos.sale.create';

/** The contract's `HeldSalePricedLine`. */
export interface HeldSalePricedLineView {
  readonly lineNo: number;
  readonly productId: string;
  readonly quantity: string;
  readonly weightKg: string | null;
  readonly priceBasis: PriceBasis | null;
  readonly priceListEntryId: string | null;
  readonly listUnitPricePesewas: number | null;
  readonly lineTotalPesewas: number | null;
  readonly quoteRequiredReason: string | null;
}

/** The contract's `HeldSalePricing`: the lines as the engine prices them at `pricedAt`. */
export interface HeldSalePricingView {
  readonly pricedAt: string;
  readonly lines: readonly HeldSalePricedLineView[];
  readonly totalPesewas: number | null;
  readonly currency: 'GHS';
}

/** The contract's `HeldSale`. */
export interface HeldSaleView {
  readonly id: string;
  readonly registerId: string;
  readonly shiftId: string;
  readonly heldBy: PrincipalRef;
  readonly label: string | null;
  readonly payload: HeldSalePayload;
  readonly heldAt: string;
  readonly expiresAt: string;
  readonly status: 'HELD' | 'RECALLED';
  readonly heldTotalPesewas: number;
  readonly pricing: HeldSalePricingView | null;
  readonly currency: 'GHS';
}

export interface HoldRequest {
  readonly id: string;
  readonly label?: string | undefined;
  readonly payload: HeldSalePayload;
}

const scopeOf = (register: RegisterRecord | null | undefined) => (register === null || register === undefined ? {} : { branchId: register.branchId, locationId: register.locationId });

/**
 * Held sales (FR-POS-007, A-276): a sale in progress parked on the till's open shift by that shift's cashier, from an
 * enrolled device of the till, and recalled once, on that shift, by that cashier (ADR-0077: nobody, a manager included,
 * sells on another cashier's shift). The lines are kept as entered; no price is held: the hold answers the prices then,
 * the recall the prices now, and the counter sale re-resolves them again when it completes. A held sale reserves
 * nothing, so there is nothing to release; it lapses when its shift is declared or force-closed (`lapseIn`, held by the
 * database too) or twelve hours after it was held.
 */
export class HeldSales {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: TillStore,
    private readonly devices: Devices,
    private readonly pricing: PricingService,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {}

  /** `holdSale`: parks the lines on the till's open shift, priced now; 422 when a line has no price to sell at. */
  hold(actor: Actor | undefined, registerId: string, body: HoldRequest, idempotencyKey: string, deviceCredential: string | undefined): Promise<StoredResponse<HeldSaleView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const [register] = await this.store.registers(tx, [registerId]);
      await this.authoriser.authorise(tx, actor, SELL, scopeOf(register));
      if (register === undefined) throw new NotFoundError(`no register ${registerId}`);
      const unclosed = (await this.store.unclosedShifts(tx, [register.id])).get(register.id);
      const shift = unclosed === undefined ? null : await this.store.lockShift(tx, unclosed.id);
      const judged = judgeHold(shift, actor!.principalId);
      if (!judged.ok && judged.error === 'NOT_SHIFT_CASHIER') throw new ForbiddenError(`${SELL} refused: the till's open shift is another cashier's`);
      await this.devices.deviceOfIn(tx, deviceCredential, register.id);
      const claim = await this.idempotency.claim(tx, { operationId: 'holdSale', principalId: actor!.principalId, key: idempotencyKey, request: { registerId, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<HeldSaleView>;
      if (!judged.ok) throw new ShiftNotOpenError(shift?.status ?? 'CLOSED');

      const broken: TillRule[] = [];
      if (!isUuidV7(body.id)) broken.push({ field: '/id', rule: 'ID_NOT_UUID_V7' });
      if ((await this.store.heldSales(tx, [body.id])).length > 0) broken.push({ field: '/id', rule: 'ID_IN_USE' });
      body.payload.lines.forEach((l, i) => {
        if (l.weightKg !== undefined && l.weightSource === undefined) broken.push({ field: `/payload/lines/${i}/weightSource`, rule: 'WEIGHT_SOURCE_REQUIRED' });
      });
      if (broken.length > 0) throw new HeldSaleInvalidError(broken);
      const now = this.clock.now();
      const priced = await this.priceIn(tx, register.branchId, body.payload, now);
      // A sale is held only if every line has a price to sell at now: anything else is a quote (FR-POS-003).
      const unpriced = priced.lines.flatMap((l) => (l.lineTotalPesewas === null ? [{ field: `/payload/lines/${indexOfLineNo(l.lineNo)}`, rule: l.quoteRequiredReason === 'WEIGHT_REQUIRED' ? 'WEIGHT_REQUIRED' : 'QUOTE_REQUIRED' }] : []));
      if (unpriced.length > 0) throw new HeldSaleInvalidError(unpriced);

      await this.store.insertHeldSale(tx, {
        id: body.id,
        registerId: register.id,
        shiftId: shift!.id,
        branchId: register.branchId,
        heldBy: actor!.principalId,
        label: body.label ?? null,
        payload: body.payload,
        heldGrossPesewas: BigInt(priced.totalPesewas!),
        heldAt: now,
        expiresAt: heldSaleExpiry(now),
      });
      const [record] = await this.store.heldSales(tx, [body.id]);
      const view = await this.viewOf(tx, record!, priced);
      await this.audit.record(tx, { module: 'pos', action: 'HOLD_SALE', entityType: 'HeldSale', entityId: body.id, branchId: register.branchId, before: null, after: { ...view } });
      const response: StoredResponse<HeldSaleView> = { status: 201, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** `listHeldSales`: the sales still held on the till's open shift, newest first; no line is priced here. */
  list(actor: Actor | undefined, registerId: string, cursor: string | undefined, limit: number): Promise<Page<HeldSaleView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const [register] = await this.store.registers(tx, [registerId]);
      await this.authoriser.authorise(tx, actor, SELL, scopeOf(register));
      if (register === undefined) throw new NotFoundError(`no register ${registerId}`);
      const binding = { operationId: 'listHeldSales', principalId: actor!.principalId, filters: { registerId } };
      const before = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const rows = await this.store.heldSalesOfRegister(tx, registerId, this.clock.now(), before, oneMore(limit));
      const kept = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      const data: HeldSaleView[] = [];
      for (const row of kept) data.push(await this.viewOf(tx, row, null));
      return { data, page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: kept.at(-1)!.id }) : null, limit, hasMore } };
    });
  }

  /**
   * `recallHeldSale`: takes the held sale off the till, once, re-priced now. A hold recalled already, lapsed, expired or
   * on a shift no longer open is 404, as is one that never existed; the answer to the first recall is replayed for its
   * own idempotency key.
   */
  recall(actor: Actor | undefined, id: string, idempotencyKey: string, deviceCredential: string | undefined): Promise<StoredResponse<HeldSaleView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const [found] = await this.store.heldSales(tx, [id]);
      const register = found === undefined ? undefined : (await this.store.registers(tx, [found.registerId]))[0];
      await this.authoriser.authorise(tx, actor, SELL, scopeOf(register));
      if (found === undefined || register === undefined) throw new NotFoundError(`no held sale ${id}`);
      // The shift first, then the hold: the order a close takes them in, so the two never wait on each other.
      const shift = (await this.store.lockShift(tx, found.shiftId))!;
      const hold = (await this.store.heldSales(tx, [id], true))[0]!;
      if (shift.cashierId !== actor!.principalId) throw new ForbiddenError(`${SELL} refused: the held sale is on another cashier's shift`);
      await this.devices.deviceOfIn(tx, deviceCredential, register.id);
      const claim = await this.idempotency.claim(tx, { operationId: 'recallHeldSale', principalId: actor!.principalId, key: idempotencyKey, request: { id } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<HeldSaleView>;
      const now = this.clock.now();
      const judged = judgeRecall({ status: hold.status, expiresAt: hold.expiresAt, shift }, actor!.principalId, now);
      if (!judged.ok) throw new NotFoundError(`no held sale ${id}`);
      const before = await this.viewOf(tx, hold, null);
      await this.store.recallHeldSale(tx, id, { by: actor!.principalId, at: now });
      const priced = await this.priceIn(tx, hold.branchId, hold.payload, now);
      const [recalled] = await this.store.heldSales(tx, [id]);
      const view = await this.viewOf(tx, recalled!, priced);
      await this.audit.record(tx, { module: 'pos', action: 'RECALL_SALE', entityType: 'HeldSale', entityId: id, branchId: hold.branchId, before: { ...before }, after: { ...view } });
      const response: StoredResponse<HeldSaleView> = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * Lapses every sale still held on a shift as it leaves OPEN (its cashier's declaration, or a force close), in the
   * closing transaction, each audited; the database refuses the close otherwise (`ck_shift_held_sales_lapsed`).
   */
  async lapseIn(tx: Transaction, shift: { readonly id: string; readonly branchId: string }, reason: 'SHIFT_CLOSED' | 'SHIFT_FORCE_CLOSED', at: Date): Promise<void> {
    const lapsed = await this.store.lapseHeldSales(tx, shift.id, { reason, at });
    for (const heldSaleId of lapsed) {
      await this.audit.record(tx, { module: 'pos', action: 'LAPSE_HELD_SALE', entityType: 'HeldSale', entityId: heldSaleId, branchId: shift.branchId, before: { status: 'HELD' }, after: { status: 'LAPSED', reason, shiftId: shift.id } });
    }
  }

  /** The lines priced by the engine for channel POS at `at`, each extended and rounded once; null where none resolves. */
  private async priceIn(tx: Transaction, branchId: string, payload: HeldSalePayload, at: Date): Promise<HeldSalePricingView> {
    const resolved = await this.pricing.resolveIn(tx, {
      channel: 'POS',
      branchId,
      ...(payload.customerId === undefined ? {} : { customerId: payload.customerId }),
      at,
      lines: payload.lines.map((l, i) => ({
        lineRef: String(i),
        productId: l.productId,
        quantity: l.quantity,
        ...(l.stockUnitId === undefined ? {} : { stockUnitId: l.stockUnitId }),
        ...(l.gradeId === undefined ? {} : { gradeId: l.gradeId }),
        ...(l.weightKg === undefined ? {} : { weightKg: l.weightKg }),
      })),
    });
    const lines: HeldSalePricedLineView[] = payload.lines.map((l, i) => {
      const line = resolved.lines.find((r) => r.lineRef === String(i))!;
      const base = { lineNo: lineNoOf(i), productId: l.productId, quantity: l.quantity, weightKg: l.weightKg ?? null };
      if (line.outcome !== 'RESOLVED' || line.resolved === null) {
        return { ...base, priceBasis: null, priceListEntryId: null, listUnitPricePesewas: null, lineTotalPesewas: null, quoteRequiredReason: line.quoteRequiredReason ?? 'NO_RULE' };
      }
      const band = line.resolved;
      const total = extendPrice(BigInt(band.listPricePesewas), band.basis, { quantity: Quantity.parse(l.quantity), weight: l.weightKg === undefined ? null : Weight.parseKg(l.weightKg) });
      return {
        ...base,
        priceBasis: band.basis,
        priceListEntryId: band.priceListEntryId,
        listUnitPricePesewas: band.listPricePesewas,
        lineTotalPesewas: total.ok ? Money.ofPesewas(total.value).toJsonInteger() : null,
        quoteRequiredReason: total.ok ? null : total.error,
      };
    });
    const complete = lines.every((l) => l.lineTotalPesewas !== null);
    return {
      pricedAt: at.toISOString(),
      lines,
      totalPesewas: complete ? heldTotal(lines.map((l) => Money.fromJsonInteger(l.lineTotalPesewas!))).toJsonInteger() : null,
      currency: 'GHS',
    };
  }

  private async viewOf(tx: Transaction, h: HeldSaleRecord, pricing: HeldSalePricingView | null): Promise<HeldSaleView> {
    const names = await this.principals.refs(tx, [h.heldBy]);
    return {
      id: h.id,
      registerId: h.registerId,
      shiftId: h.shiftId,
      heldBy: names.get(h.heldBy) ?? { id: h.heldBy, displayName: '' },
      label: h.label,
      payload: h.payload,
      heldAt: h.heldAt.toISOString(),
      expiresAt: h.expiresAt.toISOString(),
      status: h.status === 'RECALLED' ? 'RECALLED' : 'HELD',
      heldTotalPesewas: Money.ofPesewas(h.heldGrossPesewas).toJsonInteger(),
      pricing,
      currency: 'GHS',
    };
  }
}
