import { z } from 'zod';

const BusinessDate = z.iso.date();
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().min(1).max(512).optional();
const Pesewas = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).transform((n) => BigInt(n));

export const IdParam = z.uuid();
export const ObjectTypeParam = z.enum(['STOCK_UNIT', 'PEN', 'BATCH', 'PROCESSING_ORDER']);
export const PageQuery = z.object({ cursor: Cursor, limit: Limit });
/** The contract's `OverheadAllocationCreate` (FR-CST-002); `branchId` is required when no pen is named. */
export const OverheadAllocationCreate = z.strictObject({
  periodStart: BusinessDate,
  periodEnd: BusinessDate,
  costElement: z.enum(['LABOUR', 'OVERHEAD']),
  basis: z.enum(['HEAD_DAYS', 'WEIGHT_GAIN', 'EQUAL']),
  scopeLocationId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  totalPesewas: Pesewas,
});
export const MarginQuery = z.object({
  groupBy: z.enum(['PRODUCT', 'PRODUCT_LINE', 'CHANNEL', 'CUSTOMER', 'SALESPERSON', 'BRANCH']),
  from: BusinessDate,
  to: BusinessDate,
  branchId: z.uuid().optional(),
  cursor: Cursor,
  limit: Limit,
});
export const BreakEvenQuery = z.object({ from: BusinessDate, to: BusinessDate, branchId: z.uuid().optional() });
export const LossQuery = z.object({ groupBy: z.enum(['CAUSE', 'LOCATION', 'HANDLER', 'PRODUCT']), from: BusinessDate, to: BusinessDate, cursor: Cursor, limit: Limit });
