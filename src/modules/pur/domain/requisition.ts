import { err, ok, type Result } from '@hakorem/kernel';

/**
 * Purchase requisitions (FR-PUR-004): raised as DRAFT, submitted, then rejected with a reason or converted into a
 * draft purchase order by a manager. Pure; the database holds the same lifecycle (migration 0099).
 */
export type RequisitionStatus = 'DRAFT' | 'SUBMITTED' | 'CONVERTED' | 'REJECTED' | 'CANCELLED';
export type RequisitionAction = 'UPDATE' | 'SUBMIT' | 'REJECT' | 'CONVERT';

const ACTION_FROM: Readonly<Record<RequisitionAction, { readonly from: RequisitionStatus; readonly to: RequisitionStatus }>> = {
  UPDATE: { from: 'DRAFT', to: 'DRAFT' },
  SUBMIT: { from: 'DRAFT', to: 'SUBMITTED' },
  REJECT: { from: 'SUBMITTED', to: 'REJECTED' },
  CONVERT: { from: 'SUBMITTED', to: 'CONVERTED' },
};

/** Whether an action may happen to a requisition in a status, and the status it leads to. */
export function judgeRequisitionAction(status: RequisitionStatus, action: RequisitionAction): Result<RequisitionStatus, 'WRONG_STATUS'> {
  const rule = ACTION_FROM[action];
  return status === rule.from ? ok(rule.to) : err('WRONG_STATUS');
}

export interface RequisitionLineFacts {
  readonly id: string;
  readonly productId: string;
  readonly qty: string;
}

export interface ConversionLine {
  readonly lineId: string;
  readonly unitPricePesewas: number;
  readonly qty?: string | undefined;
}

export interface PlannedOrderLine {
  readonly productId: string;
  readonly qtyOrdered: string;
  readonly unitPricePesewas: number;
}

/**
 * The order lines a conversion asks for: each names a line of the requisition once, at the price agreed with the
 * supplier and the requisitioned quantity unless another is given. A line left out is not ordered.
 */
export function planConversion(
  lines: readonly RequisitionLineFacts[],
  asked: readonly ConversionLine[],
): Result<PlannedOrderLine[], { readonly field: string; readonly rule: 'NO_LINES' | 'LINE_NOT_ON_REQUISITION' | 'LINE_REPEATED' }[]> {
  if (asked.length === 0) return err([{ field: '/lines', rule: 'NO_LINES' }]);
  const byId = new Map(lines.map((line) => [line.id, line] as const));
  const seen = new Set<string>();
  const broken: { field: string; rule: 'LINE_NOT_ON_REQUISITION' | 'LINE_REPEATED' }[] = [];
  const planned: PlannedOrderLine[] = [];
  asked.forEach((line, index) => {
    const found = byId.get(line.lineId);
    if (found === undefined) {
      broken.push({ field: `/lines/${index}/lineId`, rule: 'LINE_NOT_ON_REQUISITION' });
    } else if (seen.has(line.lineId)) {
      broken.push({ field: `/lines/${index}/lineId`, rule: 'LINE_REPEATED' });
    } else {
      planned.push({ productId: found.productId, qtyOrdered: line.qty ?? found.qty, unitPricePesewas: line.unitPricePesewas });
    }
    seen.add(line.lineId);
  });
  return broken.length > 0 ? err(broken) : ok(planned);
}
