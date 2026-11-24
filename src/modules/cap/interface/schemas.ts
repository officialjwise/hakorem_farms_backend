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

const PesewasOrNone = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).transform((n) => BigInt(n));
const Text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((text) => text.trim().length > 0, { message: 'cannot be blank' });
/** The contract's `PayoutInput` (FR-CAP-002): what each method needs is judged in the domain, unknown fields refused here. */
export const PayoutInput = z.strictObject({
  method: z.enum(['BANK', 'MOBILE_MONEY']),
  bankName: Text(120).optional(),
  accountName: Text(200).optional(),
  accountNumber: Text(40).optional(),
  momoNetwork: z.enum(['MTN', 'TELECEL', 'AIRTELTIGO']).optional(),
  momoNumber: Phone.optional(),
});

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
  idNumber: z.string().max(40).optional(),
  payout: PayoutInput.optional(),
  agreementFileId: z.uuid().optional(),
  createPortalLogin: z.boolean().optional(),
});
export const InvestorUpdate = z.strictObject({
  version: z.number().int().min(1),
  phone: Phone.optional(),
  email: Email.optional(),
  status: z.enum(['ACTIVE', 'EXITED']).optional(),
  payout: PayoutInput.optional(),
  idNumber: z.string().max(40).optional(),
  createPortalLogin: z.boolean().optional(),
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

export const PageQuery = z.object({ cursor: Cursor, limit: Limit });
export const InvestorDocumentCreate = z.strictObject({
  kind: z.enum(['AGREEMENT', 'IDENTIFICATION', 'STATEMENT', 'DISTRIBUTION_SCHEDULE', 'OTHER']),
  name: Text(200),
  fileId: z.uuid(),
});
export const AsOfQuery = z.object({ asOf: BusinessDate.optional() });
export const StatementQuery = z.object({ from: BusinessDate.optional(), to: BusinessDate.optional() });
export const MyStatementQuery = z.object({ from: BusinessDate, to: BusinessDate });

export const FinancingPageQuery = z.object({ kind: z.enum(['LOAN', 'GRANT']).optional(), status: z.enum(['DRAFT', 'ACTIVE', 'SETTLED', 'CANCELLED']).optional(), cursor: Cursor, limit: Limit });
export const FinancingCreate = z.strictObject({
  kind: z.enum(['LOAN', 'GRANT']),
  lenderInvestorId: z.uuid().optional(),
  lenderName: Text(200),
  principalPesewas: Pesewas,
  annualRatePercent: Percent.optional(),
  interestBasis: z.enum(['ACTUAL_365', 'FLAT']).optional(),
  startDate: BusinessDate,
  termMonths: z.number().int().min(1).max(600).optional(),
  bankAccountId: z.uuid(),
  agreementFileId: z.uuid().optional(),
});
export const RepaymentCreate = z.strictObject({
  principalPesewas: PesewasOrNone,
  interestPesewas: PesewasOrNone,
  bankAccountId: z.uuid(),
  externalReference: Reference.optional(),
  paidAt: z.iso.datetime({ offset: true }),
});
