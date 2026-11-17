import { z } from 'zod';
import { MAX_ORDER_INPUTS, MAX_ORDER_OUTPUTS } from '../application/processing';

/** The contract's `Kilograms`, `Pesewas` (carried inward as a bigint so no float touches it) and `Percent`. */
const Kilograms = z.string().regex(/^(0|[1-9][0-9]{0,6})\.[0-9]{3}$/);
const Pesewas = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .transform((value) => BigInt(value));
const Percent = z.string().regex(/^(100|[0-9]{1,2})(\.[0-9]{1,4})?$/);
const WeightSource = z.enum(['SCALE', 'MANUAL', 'ESTIMATE']);
const OutputKind = z.enum(['MEAT', 'OFFAL', 'BY_PRODUCT', 'WASTE']);
const CalendarDate = z.iso.date();
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().min(1).max(512).optional();
const Bool = z.enum(['true', 'false']).transform((value) => value === 'true');

export const IdParam = z.uuid();

/** The contract's `ProcessingInputInput`, strict. */
const ProcessingInputInput = z.strictObject({ stockUnitId: z.uuid(), weightKg: Kilograms, weightSource: WeightSource });

export const ProcessingOrderCreate = z.strictObject({
  locationId: z.uuid(),
  outputLocationId: z.uuid(),
  inputs: z.array(ProcessingInputInput).max(MAX_ORDER_INPUTS),
});

export const ProcessingOrderUpdate = z.strictObject({
  version: z.number().int().min(1),
  outputLocationId: z.uuid().optional(),
  inputs: z.array(ProcessingInputInput).max(MAX_ORDER_INPUTS).optional(),
});

export const ProcessingOutputsReplace = z.strictObject({
  version: z.number().int().min(1),
  outputs: z
    .array(
      z.strictObject({
        productId: z.uuid(),
        outputKind: OutputKind,
        weightKg: Kilograms,
        weightSource: WeightSource,
        packCount: z.number().int().min(1).max(10_000).optional(),
        expiresOn: CalendarDate.optional(),
      }),
    )
    .max(MAX_ORDER_OUTPUTS),
});

export const ProcessingCostCreate = z.strictObject({
  costKind: z.enum(['LABOUR', 'CONSUMABLE', 'SERVICE', 'UTILITY']),
  amountPesewas: Pesewas,
  description: z.string().trim().min(1).max(200),
});

export const ReasonBody = z.strictObject({ reason: z.string().trim().min(1).max(500) });

export const ListProcessingOrdersQuery = z.object({
  status: z.enum(['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
  from: CalendarDate.optional(),
  to: CalendarDate.optional(),
  yieldVarianceFlag: Bool.optional(),
  reversalId: z.uuid().optional(),
  cursor: Cursor,
  limit: Limit,
});

export const PageQuery = z.object({ cursor: Cursor, limit: Limit });

export const YieldStandardCreate = z.strictObject({
  inputProductId: z.uuid(),
  outputProductId: z.uuid(),
  expectedPercent: Percent,
  tolerancePercent: Percent.optional(),
});

export const YieldStandardUpdate = z.strictObject({
  version: z.number().int().min(1),
  expectedPercent: Percent.optional(),
  tolerancePercent: Percent.optional(),
});

/** The contract's `PacksCreate`, strict (FR-PRC-009). */
export const PacksCreate = z.strictObject({
  outputLineNo: z.number().int().min(1).max(999),
  packs: z.array(z.strictObject({ weightKg: Kilograms, weightSource: WeightSource })).min(1).max(200),
});

/** The contract's `LabelPrintRequest`, strict (FR-PRC-010). The format names the label the client draws. */
export const LabelPrintRequest = z.strictObject({
  packIds: z.array(z.uuid()).min(1).max(200),
  format: z.enum(['PDF_LABEL_50x30', 'ZPL']).optional(),
});
