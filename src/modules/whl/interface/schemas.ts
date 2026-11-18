import { z } from 'zod';

const BusinessDate = z.iso.date();
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().min(1).max(512).optional();

export const IdParam = z.uuid();
export const StatementPageQuery = z.object({ customerId: z.uuid().optional(), periodEnd: BusinessDate.optional(), cursor: Cursor, limit: Limit });
export const StatementCreate = z.strictObject({ customerId: z.uuid(), branchId: z.uuid().optional(), periodStart: BusinessDate, periodEnd: BusinessDate, issue: z.boolean() });

const Days = z.number().int().min(0).max(365);
const Reason = z
  .string()
  .max(500)
  .refine((text) => text.trim().length > 0, { message: 'cannot be blank' });
const PesewasNumber = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).transform((n) => BigInt(n));

export const CustomerIdParam = z.uuid();
export const AccountPageQuery = z.object({
  status: z.enum(['ACTIVE', 'ON_HOLD', 'CLOSED']).optional(),
  accountManagerId: z.uuid().optional(),
  overLimit: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  cursor: Cursor,
  limit: Limit,
});
export const AccountCreate = z.strictObject({
  customerId: z.uuid(),
  branchId: z.uuid().optional(),
  creditLimitPesewas: PesewasNumber,
  paymentTermsDays: Days,
  accountManagerId: z.uuid().optional(),
  overdueHoldDays: Days.min(1).optional(),
  reason: Reason.optional(),
  priceListId: z.uuid().optional(),
});
export const AccountUpdate = z.strictObject({
  version: z.number().int().min(1),
  creditLimitPesewas: PesewasNumber.optional(),
  paymentTermsDays: Days.optional(),
  accountManagerId: z.uuid().nullable().optional(),
  overdueHoldDays: Days.min(1).optional(),
  status: z.enum(['ACTIVE', 'CLOSED']).optional(),
  reason: Reason.optional(),
  priceListId: z.uuid().optional(),
});
export const ReasonBody = z.strictObject({ reason: Reason });
export const CreditOverridePageQuery = z.object({ customerId: z.uuid().optional(), from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(), cursor: Cursor, limit: Limit });
