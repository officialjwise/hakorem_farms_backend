import { z } from 'zod';

const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().min(1).max(512).optional();
const Pesewas = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Quantity = z.string().regex(/^(0|[1-9][0-9]{0,10})\.[0-9]{3}$/);
const Kilograms = z.string().regex(/^(0|[1-9][0-9]{0,6})\.[0-9]{3}$/);
const ReasonCode = z.string().regex(/^[A-Z][A-Z_]{1,39}$/);
const Text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((text) => text.trim().length > 0, { message: 'cannot be blank' });

export const IdParam = z.uuid();

const STATUSES = [
  'PLACED',
  'CONFIRMED',
  'PICKING',
  'AWAITING_CUSTOMER',
  'PACKED',
  'READY_FOR_COLLECTION',
  'DISPATCHED',
  'DELIVERED',
  'DELIVERY_FAILED',
  'RETURNED',
  'COMPLETED',
  'CANCELLED',
  'VOIDED',
] as const;

export const OrderPageQuery = z.object({
  channel: z.enum(['POS', 'ONLINE', 'WHOLESALE', 'QUOTE']).optional(),
  status: z.enum(STATUSES).optional(),
  customerId: z.uuid().optional(),
  shiftId: z.uuid().optional(),
  salespersonId: z.uuid().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  q: z.string().min(1).max(60).optional(),
  cursor: Cursor,
  limit: Limit,
});

export const PageQuery = z.object({ cursor: Cursor, limit: Limit });

export const OrderCreateBody = z.strictObject({
  channel: z.enum(['WHOLESALE', 'ONLINE']),
  customerId: z.uuid(),
  fulfilmentMode: z.enum(['COLLECTION', 'DELIVERY']),
  paymentTerms: z.enum(['PREPAID', 'COD', 'CREDIT']),
  deliveryAddressId: z.uuid().optional(),
  deliverySlotId: z.uuid().optional(),
  lines: z
    .array(
      z.strictObject({
        productId: z.uuid(),
        stockUnitId: z.uuid().optional(),
        quantity: Quantity.refine((q) => !/^0\.000$/.test(q), { message: 'must be above zero' }),
        uom: z.string().regex(/^[A-Z]{2,10}$/).optional(),
        gradeId: z.uuid().optional(),
        weightKg: Kilograms.optional(),
        agreedUnitPricePesewas: Pesewas.optional(),
        varianceReasonCode: ReasonCode.optional(),
      }),
    )
    .max(100),
  couponCode: z.string().min(1).max(40).optional(),
  notes: Text(500).optional(),
});

/** The contract's `ReasonCodeRequest` (cancelOrder, voidOrder). */
/** confirmOrder's optional body (CR-046): a written reason asks for a credit override when the order is refused for credit. */
export const OrderConfirmBody = z.strictObject({ creditOverrideReason: Text(500).optional() }).optional();
export const ReasonCodeBody = z.strictObject({ reasonCode: ReasonCode, note: Text(500).optional() });

/** The contract's `ReturnCreate` (createReturn): quantities in the sold line's base unit, each above zero. */
export const ReturnCreateBody = z.strictObject({
  orderId: z.uuid(),
  kind: z.enum(['RETURN', 'EXCHANGE']),
  reasonCode: ReasonCode,
  refundDestination: z.enum(['ORIGINAL_METHOD', 'STORE_CREDIT', 'CASH']),
  lines: z
    .array(
      z.strictObject({
        orderLineId: z.uuid(),
        qty: Quantity.refine((q) => !/^0\.000$/.test(q), { message: 'must be above zero' }),
        weightKg: Kilograms.optional(),
        disposition: z.enum(['RESTOCK', 'RETURNS_HOLD', 'WRITE_OFF']),
      }),
    )
    .max(100),
  note: Text(500).optional(),
});

/** A tracking token as the link carries it (`trk_` and base64url); the handler looks it up by its hash (ADR-0074). */
export const TrackingTokenParam = z.string().min(1).max(100);
