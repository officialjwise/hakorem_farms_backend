import { createUuidV7Generator, toBusinessDate, Weight, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from '../../iam';
import type { StockUnits } from '../../inv';
import type { MasterDataRefs } from '../../mdm';
import { checkPacks, packBarcode, packLabelText, type PackBarcode } from '../domain/packing';
import { pageProbe } from './counting';
import { ProcessingOrderInvalidError } from './errors';
import type { OrderRecord, PackRecord, PackStatus, ProcessingStore, WeightSource } from './processing-store';

export interface PacksCreateRequest {
  readonly outputLineNo: number;
  readonly packs: ReadonlyArray<{ readonly weightKg: string; readonly weightSource: WeightSource }>;
}

export interface LabelPrintRequest {
  readonly packIds: readonly string[];
  readonly format?: 'PDF_LABEL_50x30' | 'ZPL' | undefined;
}

/** The contract's `Pack`. */
export interface PackView {
  readonly id: string;
  readonly stockUnit: { readonly id: string; readonly identifier: string; readonly tracking: 'LOT' };
  readonly outputLineNo: number;
  readonly packNo: number;
  readonly weightKg: string;
  readonly weightSource: WeightSource;
  readonly barcode: string;
  readonly status: PackStatus;
  readonly labelPrintedAt: string | null;
}

/** The contract's `PackLabel`: what one label prints, for the client to draw (A-151, A-161). */
export interface PackLabelView {
  readonly pack: { readonly id: string; readonly packNo: number };
  readonly stockUnit: { readonly id: string; readonly identifier: string; readonly tracking: 'LOT' };
  readonly product: { readonly id: string; readonly sku: string; readonly name: string };
  readonly lotNo: string;
  readonly weightKg: string;
  readonly weightSource: WeightSource;
  readonly producedOn: string;
  readonly expiresOn: string | null;
  readonly storageTempClass: 'AMBIENT' | 'CHILLED' | 'FROZEN' | null;
  readonly line: string;
  readonly barcode: PackBarcode;
  readonly labelPrintedAt: string;
  readonly reprint: boolean;
}

export interface PackLabelSheetView {
  readonly format: 'PDF_LABEL_50x30' | 'ZPL';
  readonly labels: readonly PackLabelView[];
}

interface Page<V> {
  readonly data: readonly V[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

/** The most packs one label call prints: a cold room's morning. */
export const MAX_LABELS_PER_CALL = 200;
const DEFAULT_FORMAT = 'PDF_LABEL_50x30';
const PRINTABLE: ReadonlySet<PackStatus> = new Set(['IN_STOCK', 'PICKED']);

/**
 * PRC's `Packs` (FR-PRC-009, FR-PRC-010; A-161): packing a completed order's saleable output into weighed packs whose
 * weights sum exactly to the output's lot, listing them, and the label data each pack prints, whose barcode carries the
 * lot and the weight in grams. Packing moves no stock and no cost: the lot's kilograms stay where they are, now in
 * labelled pieces. Each write authorises first at the order's branch and processing location, as the order's own writes
 * do, then claims its idempotency key, in one serializable transaction.
 */
export class Packs {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: ProcessingStore,
    private readonly refs: MasterDataRefs,
    private readonly units: StockUnits,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, orderId: string, cursor: string | undefined, limit: number): Promise<Page<PackView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const order = await this.store.order(tx, orderId);
      await this.authoriser.authorise(tx, actor, 'prc.order.read', order === null ? {} : { branchId: order.branchId, locationId: order.locationId });
      if (order === null) throw new NotFoundError(`no processing order ${orderId}`);
      const binding = { operationId: 'listPacks', principalId: actor!.principalId, filters: { orderId } };
      const position = cursor === undefined ? null : this.cursors.decode(cursor, binding);
      const after = position === null ? null : { lineNo: Number(position['line']), packNo: Number(position['pack']) };
      const found = await this.store.packsOf(tx, orderId, after, pageProbe(limit));
      const data = found.slice(0, limit);
      const last = data.at(-1);
      const hasMore = found.length > limit;
      return {
        data: await this.views(tx, data),
        page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { line: String(last.outputLineNo), pack: String(last.packNo) }) : null, limit, hasMore },
      };
    });
  }

  create(actor: Actor | undefined, orderId: string, body: PacksCreateRequest, idempotencyKey: string): Promise<StoredResponse<{ packs: PackView[] }>> {
    return this.write(actor, 'createPacks', { orderId, ...body }, idempotencyKey, orderId, async (tx, who, order) => {
      const output = order.outputs.find((o) => o.lineNo === body.outputLineNo);
      if (output === undefined) throw new ProcessingOrderInvalidError([{ field: '/outputLineNo', rule: 'OUTPUT_NOT_FOUND' }]);
      if (output.outputKind === 'WASTE' || output.stockUnitId === null) throw new ProcessingOrderInvalidError([{ field: '/outputLineNo', rule: 'OUTPUT_IS_WASTE' }]);
      if ((await this.store.packsOf(tx, orderId, null, 1_000_000)).some((p) => p.processingOutputId === output.id)) {
        throw new ProcessingOrderInvalidError([{ field: '/outputLineNo', rule: 'ALREADY_PACKED' }]);
      }
      // The lot is packed whole, before any of it is sold or moved: its packs are what it weighs.
      const onHand = await this.units.onHandOfIn(tx, [output.stockUnitId]);
      const lotWeight = Weight.parseKg(output.weightKg);
      const here = onHand.filter((u) => u.locationId === order.outputLocationId).map((u) => Weight.parseKg(u.onHandQty));
      if (onHand.length !== here.length || !Weight.sum(here).equals(lotWeight)) {
        throw new ProcessingOrderInvalidError([{ field: '/outputLineNo', rule: 'LOT_NOT_WHOLE' }]);
      }
      const checked = checkPacks(lotWeight, body.packs.map((p) => Weight.parseKg(p.weightKg)), output.packCount);
      if (!checked.ok) throw new ProcessingOrderInvalidError(checked.error);
      const lot = (await this.units.factsIn(tx, [output.stockUnitId], this.clock.now())).get(output.stockUnitId)!;
      const ids: string[] = [];
      for (const [index, pack] of body.packs.entries()) {
        const id = this.nextId();
        const weight = checked.value[index]!;
        await this.store.insertPack(
          tx,
          { id, stockUnitId: output.stockUnitId, processingOutputId: output.id, packNo: index + 1, weightKg: weight.toKgString(), weightSource: pack.weightSource, barcode: packBarcode(lot.identifier, weight).payload },
          who.principalId,
        );
        ids.push(id);
      }
      const packs = await this.views(tx, await this.store.lockPacks(tx, ids));
      await this.audit.record(tx, {
        module: 'prc',
        action: 'PACK',
        entityType: 'ProcessingOutput',
        entityId: output.id,
        branchId: order.branchId,
        before: null,
        after: { processingOrderId: orderId, outputLineNo: output.lineNo, lot: lot.identifier, weightKg: output.weightKg, packs: packs.map((p) => ({ id: p.id, packNo: p.packNo, weightKg: p.weightKg, barcode: p.barcode })) },
      });
      return { status: 201, body: { packs } };
    });
  }

  print(actor: Actor | undefined, orderId: string, body: LabelPrintRequest, idempotencyKey: string): Promise<StoredResponse<PackLabelSheetView>> {
    return this.write(actor, 'printPackLabels', { orderId, ...body }, idempotencyKey, orderId, async (tx, who, order) => {
      const wanted = [...new Set(body.packIds)];
      if (wanted.length === 0) throw new ProcessingOrderInvalidError([{ field: '/packIds', rule: 'NO_PACKS' }]);
      if (wanted.length > MAX_LABELS_PER_CALL) throw new ProcessingOrderInvalidError([{ field: '/packIds', rule: 'TOO_MANY_PACKS' }]);
      const packs = await this.store.lockPacks(tx, wanted);
      const outputs = new Map(order.outputs.map((o) => [o.id, o]));
      const found = new Set(packs.filter((p) => outputs.has(p.processingOutputId)).map((p) => p.id));
      const strangers = wanted.flatMap((id, index) => (found.has(id) ? [] : [{ field: `/packIds/${index}`, rule: 'PACK_NOT_IN_ORDER' }]));
      if (strangers.length > 0) throw new ProcessingOrderInvalidError(strangers);
      const unprintable = wanted.flatMap((id, index) => (PRINTABLE.has(packs.find((p) => p.id === id)!.status) ? [] : [{ field: `/packIds/${index}`, rule: 'PACK_NOT_IN_STOCK' }]));
      if (unprintable.length > 0) throw new ProcessingOrderInvalidError(unprintable);
      const now = this.clock.now();
      await this.store.markPrinted(tx, wanted, now, who.principalId);
      const lots = await this.units.factsIn(tx, [...new Set(packs.map((p) => p.stockUnitId))], now);
      const products = await this.refs.productsIn(tx, [...new Set(packs.map((p) => outputs.get(p.processingOutputId)!.productId))]);
      const producedOn = toBusinessDate(order.completedAt!);
      const labels = packs.map((pack): PackLabelView => {
        const output = outputs.get(pack.processingOutputId)!;
        const product = products.get(output.productId)!;
        const lotNo = lots.get(pack.stockUnitId)!.identifier;
        const weight = Weight.parseKg(pack.weightKg);
        return {
          pack: { id: pack.id, packNo: pack.packNo },
          stockUnit: { id: pack.stockUnitId, identifier: lotNo, tracking: 'LOT' },
          product: { id: product.id, sku: product.sku, name: product.name },
          lotNo,
          weightKg: pack.weightKg,
          weightSource: pack.weightSource,
          producedOn,
          expiresOn: output.expiresOn,
          storageTempClass: product.storageTempClass,
          line: packLabelText(lotNo, weight),
          barcode: packBarcode(lotNo, weight),
          labelPrintedAt: (pack.labelPrintedAt ?? now).toISOString(),
          reprint: pack.labelPrintedAt !== null,
        };
      });
      await this.audit.record(tx, {
        module: 'prc',
        action: 'PRINT_LABELS',
        entityType: 'ProcessingOrder',
        entityId: orderId,
        branchId: order.branchId,
        before: null,
        after: { labels: labels.map((l) => ({ packId: l.pack.id, payload: l.barcode.payload, reprint: l.reprint })) },
      });
      return { status: 200, body: { format: body.format ?? DEFAULT_FORMAT, labels } };
    });
  }

  private write<T>(
    actor: Actor | undefined,
    operationId: string,
    request: object,
    idempotencyKey: string,
    orderId: string,
    work: (tx: Transaction, who: Actor, order: OrderRecord) => Promise<StoredResponse<T>>,
  ): Promise<StoredResponse<T>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const order = await this.store.order(tx, orderId);
      await this.authoriser.authorise(tx, actor, 'prc.order.process', order === null ? {} : { branchId: order.branchId, locationId: order.locationId });
      const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key: idempotencyKey, request });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<T>;
      if (order === null) throw new NotFoundError(`no processing order ${orderId}`);
      const state = (await this.store.lock(tx, orderId))!;
      if (state.status !== 'COMPLETED') throw new ProcessingOrderInvalidError([{ field: '/id', rule: 'ORDER_NOT_COMPLETED' }]);
      const response = await work(tx, actor!, order);
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  private async views(tx: Transaction, packs: readonly PackRecord[]): Promise<PackView[]> {
    const lots = await this.units.factsIn(tx, [...new Set(packs.map((p) => p.stockUnitId))], this.clock.now());
    return packs.map((p) => ({
      id: p.id,
      stockUnit: { id: p.stockUnitId, identifier: lots.get(p.stockUnitId)!.identifier, tracking: 'LOT' },
      outputLineNo: p.outputLineNo,
      packNo: p.packNo,
      weightKg: p.weightKg,
      weightSource: p.weightSource,
      barcode: p.barcode,
      status: p.status,
      labelPrintedAt: p.labelPrintedAt?.toISOString() ?? null,
    }));
  }
}
