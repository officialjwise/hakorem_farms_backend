import { z } from 'zod';

const BusinessDate = z.iso.date();
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().min(1).max(512).optional();

export const IdParam = z.uuid();
export const StatementPageQuery = z.object({ customerId: z.uuid().optional(), periodEnd: BusinessDate.optional(), cursor: Cursor, limit: Limit });
export const StatementCreate = z.strictObject({ customerId: z.uuid(), branchId: z.uuid().optional(), periodStart: BusinessDate, periodEnd: BusinessDate, issue: z.boolean() });
