import { z } from 'zod';

/** The contract's `Pesewas`, parsed as an exact integer. */
const Pesewas = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).transform((n) => BigInt(n));
const ReasonCode = z.string().regex(/^[A-Z][A-Z_]{1,39}$/);
const Instant = z.iso.datetime().transform((t) => new Date(t));
const Text = (max: number) => z.string().trim().min(1).max(max);
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().min(1).max(512).optional();
/** The most payment methods one close declares. */
export const MAX_DECLARED_METHODS = 10;

export const IdParam = z.uuid();
export const PageQuery = z.object({ cursor: Cursor, limit: Limit });
export const RegisterPageQuery = z.object({ branchId: z.uuid().optional(), cursor: Cursor, limit: Limit });
export const ShiftPageQuery = z.object({
  registerId: z.uuid().optional(),
  cashierId: z.uuid().optional(),
  status: z.enum(['OPEN', 'CLOSING', 'CLOSED']).optional(),
  from: Instant.optional(),
  to: Instant.optional(),
  cursor: Cursor,
  limit: Limit,
});

export const RegisterCreate = z.strictObject({ branchId: z.uuid(), locationId: z.uuid(), code: z.string().regex(/^[A-Z0-9]{1,4}$/), name: Text(120) });
export const RegisterUpdate = z.strictObject({ version: z.number().int().min(1), name: Text(120).optional(), locationId: z.uuid().optional(), status: z.enum(['ACTIVE', 'RETIRED']).optional() });

export const ShiftOpen = z.strictObject({ id: z.uuid(), registerId: z.uuid(), openingFloatPesewas: Pesewas, openedAt: Instant, shiftSeq: z.number().int().min(1).max(1_000_000).optional() });

export const CashMovementCreate = z.strictObject({
  id: z.uuid(),
  kind: z.enum(['CASH_DROP', 'PAY_OUT', 'PAY_IN']),
  amountPesewas: Pesewas,
  reasonCode: ReasonCode.optional(),
  note: Text(500).optional(),
  witnessId: z.uuid().optional(),
  occurredAt: Instant,
});

export const ShiftClose = z.strictObject({
  declared: z.array(z.strictObject({ paymentMethodId: z.uuid(), declaredPesewas: Pesewas })).min(1).max(MAX_DECLARED_METHODS),
  lastDeviceCounter: z.number().int().min(0).optional(),
});

export const ReasonBody = z.strictObject({ reason: Text(500) });

/** The contract's `ForceClosedShiftCount`: the cash counted in a force-closed shift's drawer, and why (A-275). */
export const ForceClosedShiftCount = z.strictObject({ declaredCashPesewas: Pesewas, reason: Text(500) });

export const DeviceEnrolmentCreate = z.strictObject({ deviceLabel: Text(80) });

/** The contract's `Quantity` and `Kilograms`: decimal strings with exactly three places. */
const Quantity = z.string().regex(/^(0|[1-9][0-9]{0,10})\.[0-9]{3}$/);
const Kilograms = z.string().regex(/^(0|[1-9][0-9]{0,6})\.[0-9]{3}$/);
/** The contract's `PhoneNumber` (E.164). */
const PhoneNumber = z.string().regex(/^\+[1-9][0-9]{7,14}$/);

export const CounterSale = z.strictObject({
  id: z.uuid(),
  shiftId: z.uuid(),
  customerId: z.uuid().optional(),
  customerPhone: PhoneNumber.optional(),
  lines: z
    .array(
      z.strictObject({
        productId: z.uuid(),
        stockUnitId: z.uuid().optional(),
        quantity: Quantity,
        /** The unit the line is sold in (CR-038); absent, the unit the product is sold by first. */
        uom: z.string().regex(/^[A-Z]{2,10}$/).optional(),
        weightKg: Kilograms.optional(),
        weightSource: z.enum(['SCALE', 'MANUAL', 'ESTIMATE']).optional(),
        gradeId: z.uuid().optional(),
        agreedUnitPricePesewas: Pesewas,
        varianceReasonCode: ReasonCode.optional(),
      }),
    )
    .min(1)
    .max(100),
  tenders: z
    .array(
      z.strictObject({
        paymentMethodId: z.uuid(),
        amountPesewas: Pesewas,
        paymentId: z.uuid().optional(),
        tenderedPesewas: Pesewas.optional(),
        unverifiedMobileMoney: z
          .strictObject({ payerPhone: PhoneNumber, network: z.enum(['MTN', 'TELECEL', 'AIRTELTIGO']), providerReference: Text(100).optional(), approvedById: z.uuid() })
          .optional(),
      }),
    )
    .min(1)
    .max(10),
  occurredAt: Instant,
});

/** A held sale's line: what a counter sale's line carries, before its price is agreed (FR-POS-007, A-276). */
const HeldSaleLine = z.strictObject({
  productId: z.uuid(),
  stockUnitId: z.uuid().optional(),
  quantity: Quantity,
  weightKg: Kilograms.optional(),
  weightSource: z.enum(['SCALE', 'MANUAL', 'ESTIMATE']).optional(),
  gradeId: z.uuid().optional(),
});

/** The contract's `HeldSaleCreate`: its `payload` is the lines as entered and the customer, if one is named. */
export const HeldSaleCreate = z.strictObject({
  id: z.uuid(),
  label: Text(120).optional(),
  payload: z.strictObject({ customerId: z.uuid().optional(), lines: z.array(HeldSaleLine).min(1).max(100) }),
});

/**
 * The contract's `OfflineSyncBatch` (B09b continued 2b). A queued sale is kept exactly as the till sent it, amounts as
 * JSON integers and its time as the string it sent, because its hash is recomputed over it (OFFLINE_SYNC 4.4). Up to
 * 500 sales a batch: more is refused by the handler as `SYNC_BATCH_TOO_LARGE`, after the caller is authorised.
 */
const JsonPesewas = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** The most sales parsed from one body; the handler answers more than 500 with `SYNC_BATCH_TOO_LARGE`. */
const MAX_PARSED_SALES = 2_000;
const OfflineSale = z.strictObject({
  id: z.uuid(),
  deviceCounter: z.number().int().min(1).max(1_000_000),
  provisionalRef: z.string().min(1).max(40),
  occurredAt: z.iso.datetime(),
  customerPhone: PhoneNumber.optional(),
  lines: z
    .array(
      z.strictObject({
        productId: z.uuid(),
        stockUnitId: z.uuid().optional(),
        quantity: Quantity,
        uom: z.string().regex(/^[A-Z]{2,10}$/).optional(),
        weightKg: Kilograms.optional(),
        weightSource: z.enum(['SCALE', 'MANUAL', 'ESTIMATE']).optional(),
        gradeId: z.uuid().optional(),
        agreedUnitPricePesewas: JsonPesewas,
        varianceReasonCode: ReasonCode.optional(),
      }),
    )
    .min(1)
    .max(100),
  tenders: z
    .array(
      z.strictObject({
        paymentMethodId: z.uuid(),
        amountPesewas: JsonPesewas,
        paymentId: z.uuid().optional(),
        tenderedPesewas: JsonPesewas.optional(),
        unverifiedMobileMoney: z
          .strictObject({ payerPhone: PhoneNumber, network: z.enum(['MTN', 'TELECEL', 'AIRTELTIGO']), providerReference: Text(100).optional(), approvedById: z.uuid() })
          .optional(),
      }),
    )
    .min(1)
    .max(10),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export const OfflineSyncBatch = z.strictObject({
  deviceId: z.uuid(),
  shiftId: z.uuid(),
  sales: z.array(OfflineSale).max(MAX_PARSED_SALES),
  cashMovements: z.array(CashMovementCreate).max(500).optional(),
});
