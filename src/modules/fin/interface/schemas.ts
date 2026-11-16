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
