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

export const ShiftOpen = z.strictObject({ id: z.uuid(), registerId: z.uuid(), openingFloatPesewas: Pesewas, openedAt: Instant });

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
