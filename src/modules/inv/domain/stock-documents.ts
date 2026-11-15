import { Quantity } from '@hakorem/kernel';
import type { Tracking } from './goods-receipt';

/** A rule a stock document breaks: the JSON pointer of the field and the rule's code (`details[].code`). */
export interface StockRuleBroken {
  readonly field: string;
  readonly rule: string;
}

/** What master data says about a line's product, narrowed to the rules here. */
export interface StockProduct {
  readonly tracking: Tracking;
  readonly stockPolicy: string;
  readonly isLive: boolean;
}

/** The stock unit a line names, as inventory holds it now. */
export interface StockUnitState {
  readonly productId: string;
  readonly tracking: 'SERIAL' | 'LOT';
  readonly status: string;
}

export interface StockLineDraft {
  readonly productId: string;
  readonly product: StockProduct;
  readonly qty: Quantity;
  readonly stockUnitId: string | null;
  /** Null when the line names no unit, or names one that does not exist (the caller refuses that as not found). */
  readonly unit: StockUnitState | null;
}

export type AdjustmentDirection = 'GAIN' | 'LOSS';

export interface AdjustmentLineDraft extends StockLineDraft {
  readonly direction: AdjustmentDirection;
}

const ONE = Quantity.ofUnits(1n);

/**
 * The rules every line that moves existing stock keeps (FR-INV-010, FR-INV-012): a stocked, active product; an
 * animal or a lot named by its unit, and nothing untracked named by one; the unit of the line's product; an animal
 * moved whole; each product and unit once in the document. A unit must be ACTIVE, unless `acceptsDepleted` says a
 * depleted lot may be named (a gain brings it back).
 */
function lineRules(line: StockLineDraft, index: number, acceptsDepleted: boolean): StockRuleBroken[] {
  const at = (field: string, rule: string): StockRuleBroken => ({ field: `/lines/${index}/${field}`, rule });
  if (line.product.stockPolicy === 'NON_STOCK') return [at('productId', 'PRODUCT_NOT_STOCKED')];
  if (!line.product.isLive) return [at('productId', 'PRODUCT_NOT_ACTIVE')];
  if (line.product.tracking === 'NONE') {
    return line.stockUnitId === null ? [] : [at('stockUnitId', 'PRODUCT_NOT_TRACKED')];
  }
  if (line.stockUnitId === null || line.unit === null) return [at('stockUnitId', 'STOCK_UNIT_REQUIRED')];
  if (line.unit.productId !== line.productId) return [at('stockUnitId', 'NOT_FOR_THIS_PRODUCT')];
  const usable = line.unit.status === 'ACTIVE' || (acceptsDepleted && line.unit.tracking === 'LOT' && line.unit.status === 'DEPLETED');
  if (!usable) return [at('stockUnitId', 'STOCK_UNIT_NOT_ACTIVE')];
  if (line.unit.tracking === 'SERIAL' && line.qty.compareTo(ONE) !== 0) return [at('qty', 'WHOLE_ANIMALS_ONLY')];
  return [];
}

function repeated(lines: readonly StockLineDraft[]): StockRuleBroken[] {
  const seen = new Set<string>();
  const broken: StockRuleBroken[] = [];
  lines.forEach((line, index) => {
    const key = `${line.productId}/${line.stockUnitId ?? ''}`;
    if (seen.has(key)) broken.push({ field: `/lines/${index}`, rule: 'LINE_REPEATED' });
    seen.add(key);
  });
  return broken;
}

/** The lines of a transfer (FR-INV-010): what is dispatched must be stock that exists and can move now. */
export function checkStockLines(lines: readonly StockLineDraft[]): StockRuleBroken[] {
  if (lines.length === 0) return [{ field: '/lines', rule: 'NO_LINES' }];
  return [...lines.flatMap((line, index) => lineRules(line, index, false)), ...repeated(lines)];
}

/**
 * The lines of an adjustment (FR-INV-012). A loss takes stock that is there; a gain of a lot may bring a depleted
 * lot back. An animal is never adjusted (A-139): it arrives by a receipt or a birth and leaves by a sale, a death or a
 * cull, each with its own controls (a death above the value threshold needs a photograph and a second person, B6), so
 * an adjustment cannot be the way round them.
 */
export function checkAdjustmentLines(lines: readonly AdjustmentLineDraft[]): StockRuleBroken[] {
  if (lines.length === 0) return [{ field: '/lines', rule: 'NO_LINES' }];
  const broken = lines.flatMap((line, index) => {
    if (line.product.tracking === 'SERIAL') {
      return [{ field: `/lines/${index}/productId`, rule: 'ANIMAL_NOT_ADJUSTED' }];
    }
    return lineRules(line, index, line.direction === 'GAIN');
  });
  return [...broken, ...repeated(lines)];
}

export interface DispatchedLine {
  readonly lineId: string;
  readonly qtyDispatched: Quantity;
  readonly serial: boolean;
}

export interface ReceivedLineInput {
  readonly lineId: string;
  readonly qtyReceived: Quantity;
  readonly varianceReasonCode?: string | undefined;
}

export interface PlannedReceipt {
  readonly lineId: string;
  readonly received: Quantity;
  readonly variance: Quantity;
  readonly reasonCode: string | null;
}

export type ReceiptPlan = { readonly ok: true; readonly lines: readonly PlannedReceipt[] } | { readonly ok: false; readonly broken: readonly StockRuleBroken[] };

/**
 * Receipt confirmation at the destination (FR-INV-011): every dispatched line is answered once; what arrived is
 * never more than was dispatched; the shortfall is the variance, and a variance has its reason while no variance has
 * none; an animal arrives whole or not at all.
 */
export function planTransferReceipt(dispatched: readonly DispatchedLine[], received: readonly ReceivedLineInput[]): ReceiptPlan {
  const byId = new Map(dispatched.map((line) => [line.lineId, line] as const));
  const answered = new Set<string>();
  const broken: StockRuleBroken[] = [];
  const lines: PlannedReceipt[] = [];
  for (const [index, input] of received.entries()) {
    const broke = (field: string, rule: string) => broken.push({ field: `/lines/${index}/${field}`, rule });
    const line = byId.get(input.lineId);
    if (line === undefined) {
      broke('lineId', 'LINE_UNKNOWN');
    } else if (answered.has(input.lineId)) {
      broke('lineId', 'LINE_REPEATED');
    } else {
      answered.add(input.lineId);
      const variance = line.qtyDispatched.minus(input.qtyReceived);
      const reason = input.varianceReasonCode ?? null;
      if (input.qtyReceived.compareTo(line.qtyDispatched) > 0) broke('qtyReceived', 'MORE_THAN_DISPATCHED');
      else if (line.serial && !input.qtyReceived.isZero() && input.qtyReceived.compareTo(ONE) !== 0) broke('qtyReceived', 'WHOLE_ANIMALS_ONLY');
      else if (!variance.isZero() && reason === null) broke('varianceReasonCode', 'VARIANCE_REASON_REQUIRED');
      else if (variance.isZero() && reason !== null) broke('varianceReasonCode', 'NO_VARIANCE');
      else lines.push({ lineId: line.lineId, received: input.qtyReceived, variance, reasonCode: reason });
    }
  }
  if (answered.size < dispatched.length) broken.push({ field: '/lines', rule: 'LINE_MISSING' });
  return broken.length === 0 ? { ok: true, lines } : { ok: false, broken };
}
