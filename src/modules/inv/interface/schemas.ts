import { z } from 'zod';

/** The contract's `Kilograms`, `Quantity` and `Pesewas` (carried inward as a bigint so no float touches it). */
const Kilograms = z.string().regex(/^(0|[1-9][0-9]{0,6})\.[0-9]{3}$/);
const Quantity = z.string().regex(/^(0|[1-9][0-9]{0,10})\.[0-9]{3}$/);
const Pesewas = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .transform((value) => BigInt(value));
const WeightSource = z.enum(['SCALE', 'MANUAL', 'ESTIMATE']);
const DateTime = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const CalendarDate = z.iso.date();
/** A tag number or a batch number, as `inv.stock_unit.identifier` takes it (migration 0044). */
const Identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/_-]{0,39}$/);

/** The most lines one receipt carries, and the most animals one line lists: a lorry of goats, a house of broilers. */
export const MAX_RECEIPT_LINES = 100;
export const MAX_LINE_ANIMALS = 200;

export const IdParam = z.uuid();
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().min(1).max(512).optional();
const Bool = z.enum(['true', 'false']).transform((value) => value === 'true');

/** The contract's `AnimalArrivalInput`, strict. */
const AnimalArrivalInput = z.strictObject({
  tagNo: Identifier,
  sex: z.enum(['MALE', 'FEMALE', 'UNKNOWN']),
  breed: z.string().trim().min(1).max(80).optional(),
  weightKg: Kilograms.optional(),
  weightSource: WeightSource.optional(),
  dateOfBirth: CalendarDate.optional(),
  purpose: z.enum(['GROWING', 'BREEDING']).optional(),
});

/** The contract's `GoodsReceiptLineInput`, strict. */
const GoodsReceiptLineInput = z.strictObject({
  productId: z.uuid(),
  purchaseOrderLineId: z.uuid().optional(),
  qtyReceived: Quantity.refine((value) => value !== '0.000', 'must be above zero'),
  qtyRejected: Quantity.optional(),
  weightKg: Kilograms.optional(),
  weightSource: WeightSource.optional(),
  valuePesewas: Pesewas,
  batchNo: Identifier.optional(),
  expiresOn: CalendarDate.optional(),
  animals: z.array(AnimalArrivalInput).max(MAX_LINE_ANIMALS).optional(),
});

/** The contract's `GoodsReceiptCreate`, strict. */
export const GoodsReceiptCreate = z.strictObject({
  kind: z.enum(['PURCHASE', 'HARVEST', 'OPENING']),
  supplierId: z.uuid().optional(),
  locationId: z.uuid(),
  purchaseOrderId: z.uuid().optional(),
  deliveryNoteRef: z.string().trim().min(1).max(60).optional(),
  receivedAt: DateTime,
  notes: z.string().max(2_000).optional(),
  lines: z.array(GoodsReceiptLineInput).max(MAX_RECEIPT_LINES),
});

/** The contract's `GoodsReceiptUpdate`, strict. */
export const GoodsReceiptUpdate = z.strictObject({
  version: z.number().int().min(1),
  deliveryNoteRef: z.string().trim().min(1).max(60).optional(),
  receivedAt: DateTime.optional(),
  notes: z.string().max(2_000).optional(),
  lines: z.array(GoodsReceiptLineInput).max(MAX_RECEIPT_LINES).optional(),
});

/** The contract's `ReasonRequest`. */
export const ReasonBody = z.strictObject({ reason: z.string().trim().min(1).max(500) });

/** listGoodsReceipts query. Unknown parameters are ignored (docs/API.md section 6). */
export const ListGoodsReceiptsQuery = z.object({
  status: z.enum(['DRAFT', 'POSTED', 'CANCELLED']).optional(),
  supplierId: z.uuid().optional(),
  purchaseOrderId: z.uuid().optional(),
  from: CalendarDate.optional(),
  to: CalendarDate.optional(),
  cursor: Cursor,
  limit: Limit,
});

/** listStockOnHand query. */
export const ListStockOnHandQuery = z.object({
  branchId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  productId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  stockUnitId: z.uuid().optional(),
  includeZero: Bool.optional(),
  expiringWithinDays: z.coerce.number().int().min(0).max(3_650).optional(),
  cursor: Cursor,
  limit: Limit,
});

/** The most lines one transfer or adjustment carries. */
export const MAX_DOCUMENT_LINES = 100;
const PositiveQuantity = Quantity.refine((value) => value !== '0.000', 'must be above zero');
const ReasonCode = z.string().regex(/^[A-Z][A-Z_]{1,39}$/);

/** The contract's `StockTransferCreate`, strict. */
export const StockTransferCreate = z.strictObject({
  fromLocationId: z.uuid(),
  toLocationId: z.uuid(),
  lines: z.array(z.strictObject({ productId: z.uuid(), stockUnitId: z.uuid().optional(), qty: PositiveQuantity })).max(MAX_DOCUMENT_LINES),
});

/** The contract's `TransferReceive`, strict. */
export const TransferReceive = z.strictObject({
  lines: z.array(z.strictObject({ lineId: z.uuid(), qtyReceived: Quantity, varianceReasonCode: ReasonCode.optional() })).max(MAX_DOCUMENT_LINES),
});

/** The contract's `StockAdjustmentCreate`, strict. */
export const StockAdjustmentCreate = z.strictObject({
  locationId: z.uuid(),
  reasonCode: ReasonCode,
  note: z.string().trim().min(1).max(1_000).optional(),
  exceptionId: z.uuid().optional(),
  lines: z
    .array(z.strictObject({ productId: z.uuid(), stockUnitId: z.uuid().optional(), direction: z.enum(['GAIN', 'LOSS']), qty: PositiveQuantity, weightKg: Kilograms.optional() }))
    .max(MAX_DOCUMENT_LINES),
});

/** The contract's `MovementReversalRequest`, strict. */
export const MovementReversal = z.strictObject({ reasonCode: ReasonCode, note: z.string().trim().min(1).max(1_000) });

export const PageQuery = z.object({ cursor: Cursor, limit: Limit });

/** listStockMovements query. */
export const ListStockMovementsQuery = z.object({
  productId: z.uuid().optional(),
  stockUnitId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  movementType: z.string().regex(/^[A-Z][A-Z_]{2,39}$/).optional(),
  sourceDocumentId: z.uuid().optional(),
  from: DateTime.optional(),
  to: DateTime.optional(),
  cursor: Cursor,
  limit: Limit,
});

/** listStockTransfers query. */
export const ListStockTransfersQuery = z.object({
  status: z.enum(['DRAFT', 'DISPATCHED', 'RECEIVED', 'CANCELLED']).optional(),
  fromLocationId: z.uuid().optional(),
  toLocationId: z.uuid().optional(),
  cursor: Cursor,
  limit: Limit,
});

/** listStockAdjustments query. */
export const ListStockAdjustmentsQuery = z.object({
  status: z.enum(['DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REJECTED']).optional(),
  locationId: z.uuid().optional(),
  reasonCode: ReasonCode.optional(),
  createdBy: z.uuid().optional(),
  cursor: Cursor,
  limit: Limit,
});
