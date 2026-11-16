import { z } from 'zod';

const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().min(1).max(512).optional();
const AccountType = z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'COST_OF_SALES', 'EXPENSE']);
const SubledgerKind = z.enum(['CUSTOMER', 'SUPPLIER', 'INVESTOR', 'TAX_LEVY', 'REGISTER', 'DRIVER', 'BANK_ACCOUNT', 'PROVIDER']);
const CashFlowCategory = z.enum(['OPERATING', 'INVESTING', 'FINANCING']);
const AccountName = z
  .string()
  .max(120)
  .refine((name) => name.trim().length > 0, { message: 'a name is required' });

export const IdParam = z.uuid();

export const AccountPageQuery = z.object({ type: AccountType.optional(), postableOnly: booleanQuery.optional(), cursor: Cursor, limit: Limit });

export const AccountCreate = z.strictObject({
  code: z.string().regex(/^[1-6][0-9]{3}$/),
  name: AccountName,
  type: AccountType,
  parentId: z.uuid().optional(),
  isPostable: z.boolean(),
  subledgerKind: SubledgerKind.optional(),
  cashFlowCategory: CashFlowCategory.optional(),
});

export const AccountUpdate = z.strictObject({ version: z.number().int().min(1), name: AccountName.optional(), status: z.enum(['ACTIVE', 'CLOSED']).optional() });

export const PeriodPageQuery = z.object({
  fiscalYear: z.coerce.number().int().min(2020).max(2100).optional(),
  status: z.enum(['FUTURE', 'OPEN', 'LOCKED', 'CLOSED']).optional(),
  cursor: Cursor,
  limit: Limit,
});

export const ReasonRequest = z.strictObject({
  reason: z
    .string()
    .max(500)
    .refine((reason) => reason.trim().length > 0, { message: 'a reason is required' }),
});

const CalendarDate = z.iso.date();
const Side = z.enum(['D', 'C']);
const Uuid = z.uuid();
const Pesewas = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Text300 = z
  .string()
  .max(300)
  .refine((text) => text.trim().length > 0, { message: 'a description is required' });
const DeterminantType = z.enum(['GL_GROUP', 'PAYMENT_METHOD_KIND', 'TAX_LEVY', 'LOSS_GROUP', 'EXPENSE_CATEGORY', 'ASSET_CATEGORY']);
const Role = z.enum(['INVENTORY', 'SALES', 'COST_OF_SALES', 'TENDER', 'PAYOUT', 'OUTPUT', 'INPUT', 'LOSS', 'EXPENSE']);
const EventCode = z.string().regex(/^[a-z]{3}\.[A-Z][A-Za-z]+$/);

export const EntryPageQuery = z.object({
  from: CalendarDate.optional(),
  to: CalendarDate.optional(),
  accountId: Uuid.optional(),
  sourceDocumentId: Uuid.optional(),
  postingGroupId: Uuid.optional(),
  eventCode: EventCode.optional(),
  kind: z.enum(['AUTO', 'MANUAL', 'OPENING', 'CLOSING', 'REVERSAL']).optional(),
  cursor: Cursor,
  limit: Limit,
});

export const ActivityQuery = z
  .object({ from: CalendarDate, to: CalendarDate, subledgerPartyId: Uuid.optional(), branchId: Uuid.optional(), cursor: Cursor, limit: Limit })
  .refine((q) => q.from <= q.to, { message: 'from must not be after to', path: ['to'] });

export const ManualJournalPageQuery = z.object({
  status: z.enum(['DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REJECTED']).optional(),
  kind: z.enum(['MANUAL', 'OPENING']).optional(),
  cursor: Cursor,
  limit: Limit,
});

const ManualJournalLineInput = z.strictObject({ accountId: Uuid, side: Side, amountPesewas: Pesewas, subledgerPartyId: Uuid.optional(), memo: z.string().max(300).optional() });
const ManualLines = z.array(ManualJournalLineInput).min(2).max(200);

export const ManualJournalCreate = z.strictObject({ kind: z.enum(['MANUAL', 'OPENING']), postingDate: CalendarDate, description: Text300, lines: ManualLines });

export const ManualJournalUpdate = z.strictObject({ version: z.number().int().min(1), postingDate: CalendarDate.optional(), description: Text300.optional(), lines: ManualLines.optional() });

export const RulePageQuery = z.object({ eventCode: EventCode.optional(), at: CalendarDate.optional(), cursor: Cursor, limit: Limit });

export const DeterminationPageQuery = z.object({ determinantType: DeterminantType.optional(), cursor: Cursor, limit: Limit });

export const EventTypePageQuery = z.object({ cursor: Cursor, limit: Limit });

export const PostingRuleCreate = z.strictObject({
  eventCode: EventCode,
  amountKey: z.string().regex(/^[a-z][A-Za-z]{0,39}$/),
  side: Side,
  accountId: Uuid.optional(),
  determinantType: DeterminantType.optional(),
  determinantRole: Role.optional(),
  subledgerFrom: z.string().min(1).max(60).optional(),
  validFrom: CalendarDate,
});

export const AccountDeterminationCreate = z.strictObject({
  determinantType: DeterminantType,
  determinantKey: z.string().regex(/^(\*|[A-Z][A-Z0-9_]{0,59})$/),
  role: Role,
  accountId: Uuid,
  validFrom: CalendarDate,
});

const Text120 = z
  .string()
  .max(120)
  .refine((text) => text.trim().length > 0, { message: 'a value is required' });

export const BankAccountPageQuery = z.object({ cursor: Cursor, limit: Limit });

/** `accountNo` is checked by its kind in the domain, so a refusal never echoes it; here only its length is bounded. */
export const BankAccountCreate = z.strictObject({
  kind: z.enum(['BANK', 'MOBILE_MONEY']),
  name: Text120,
  institution: Text120,
  accountNo: z.string().min(1).max(40),
  branchId: z.uuid().optional(),
});

export const BankAccountUpdate = z.strictObject({ version: z.number().int().min(1), name: Text120.optional(), isActive: z.boolean().optional() });

const fromNotAfterTo = { message: 'from must not be after to', path: ['to'] };

export const TrialBalanceQuery = z
  .object({ from: CalendarDate, to: CalendarDate, branchId: Uuid.optional(), includeZero: booleanQuery.optional(), cursor: Cursor, limit: Limit })
  .refine((q) => q.from <= q.to, fromNotAfterTo);

export const StatementRangeQuery = z.object({ from: CalendarDate, to: CalendarDate, branchId: Uuid.optional() }).refine((q) => q.from <= q.to, fromNotAfterTo);

export const BalanceSheetQuery = z.object({ asOf: CalendarDate, branchId: Uuid.optional() });

const AssetCategory = z.enum(['VEHICLE', 'COLD_ROOM', 'HOUSING', 'EQUIPMENT']);
const PesewasOrNil = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const FixedAssetPageQuery = z.object({ category: AssetCategory.optional(), status: z.enum(['IN_USE', 'FULLY_DEPRECIATED', 'DISPOSED']).optional(), cursor: Cursor, limit: Limit });

export const FixedAssetCreate = z.strictObject({
  name: Text120,
  category: AssetCategory,
  branchId: Uuid,
  acquiredOn: CalendarDate,
  costPesewas: Pesewas,
  residualPesewas: PesewasOrNil.optional(),
  usefulLifeMonths: z.number().int(),
});

export const FixedAssetUpdate = z.strictObject({ version: z.number().int().min(1), name: Text120.optional(), usefulLifeMonths: z.number().int().optional(), residualPesewas: PesewasOrNil.optional() });

export const FixedAssetDisposal = z.strictObject({ disposedOn: CalendarDate, proceedsPesewas: PesewasOrNil, bankAccountId: Uuid.optional(), note: Text300 });

export const DepreciationRunPageQuery = z.object({ cursor: Cursor, limit: Limit });

export const DepreciationRunCreate = z.strictObject({ periodId: Uuid });
