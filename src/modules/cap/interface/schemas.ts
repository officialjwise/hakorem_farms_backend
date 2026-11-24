import { z } from 'zod';

const BusinessDate = z.iso.date();
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().min(1).max(512).optional();
const Pesewas = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).transform((n) => BigInt(n));
const Phone = z.string().regex(/^\+[1-9][0-9]{7,14}$/);
const Email = z.email().max(254);
const Reference = z
  .string()
  .max(120)
  .refine((text) => text.trim().length > 0, { message: 'cannot be blank' });
const Percent = z.string().regex(/^(100|[0-9]{1,2})(\.[0-9]{1,4})?$/);

export const IdParam = z.uuid();
export const InvestorPageQuery = z.object({ status: z.enum(['ACTIVE', 'EXITED']).optional(), cursor: Cursor, limit: Limit });
export const InvestorCreate = z.strictObject({
  kind: z.enum(['INDIVIDUAL', 'ENTITY']),
  legalName: z
    .string()
    .max(200)
    .refine((text) => text.trim().length > 0, { message: 'cannot be blank' }),
  phone: Phone.optional(),
  email: Email.optional(),
  joinedOn: BusinessDate,
  // The contract's, built in B12 continued: refused by the handler until then (FIELD_NOT_YET_SUPPORTED).
  idNumber: z.string().max(40).optional(),
  payout: z.record(z.string(), z.unknown()).optional(),
  agreementFileId: z.uuid().optional(),
  createPortalLogin: z.boolean().optional(),
});
export const InvestorUpdate = z.strictObject({
  version: z.number().int().min(1),
  phone: Phone.optional(),
  email: Email.optional(),
  status: z.enum(['ACTIVE', 'EXITED']).optional(),
  payout: z.record(z.string(), z.unknown()).optional(),
});

export const CapitalTransactionPageQuery = z.object({
  investorId: z.uuid().optional(),
  kind: z.enum(['CONTRIBUTION', 'WITHDRAWAL']).optional(),
  from: BusinessDate.optional(),
  to: BusinessDate.optional(),
  cursor: Cursor,
  limit: Limit,
});
export const CapitalTransactionCreate = z.strictObject({
  kind: z.enum(['CONTRIBUTION', 'WITHDRAWAL']),
  investorId: z.uuid(),
  amountPesewas: Pesewas,
  valueDate: BusinessDate,
  unitPricePesewas: Pesewas.optional(),
  bankAccountId: z.uuid(),
  externalReference: Reference.optional(),
});
export const RegisterQuery = z.object({ asOf: BusinessDate.optional(), cursor: Cursor, limit: Limit });

export const RunPageQuery = z.object({ status: z.enum(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'PAID', 'REJECTED']).optional(), cursor: Cursor, limit: Limit });
export const RunCreate = z.strictObject({ periodStart: BusinessDate, periodEnd: BusinessDate, retentionRatePercent: Percent.optional() });
export const PaymentCreate = z.strictObject({ amountPesewas: Pesewas, bankAccountId: z.uuid(), externalReference: Reference.optional(), paidAt: z.iso.datetime({ offset: true }).optional() });
