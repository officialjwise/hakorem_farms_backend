import { z } from 'zod';

const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().min(1).max(512).optional();
const Quantity = z.string().regex(/^(0|[1-9][0-9]{0,10})\.[0-9]{3}$/);
const Pesewas = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const ReasonCode = z.string().regex(/^[A-Z][A-Z_]{1,39}$/);
const Note = z.string().max(500).optional();
const Description = z
  .string()
  .max(200)
  .refine((text) => text.trim().length > 0, { message: 'a description is required' });

export const IdParam = z.uuid();

export const BillingDocumentPageQuery = z.object({
  kind: z.enum(['PROFORMA', 'INVOICE', 'RECEIPT', 'CREDIT_NOTE', 'DEBIT_NOTE']).optional(),
  customerId: z.uuid().optional(),
  orderId: z.uuid().optional(),
  documentNo: z.string().min(1).max(40).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  paymentStatus: z.enum(['UNPAID', 'PART_PAID', 'PAID', 'CREDITED', 'NOT_APPLICABLE']).optional(),
  cursor: Cursor,
  limit: Limit,
});

export const CreditNoteCreate = z.strictObject({
  reasonCode: ReasonCode,
  note: Note,
  lines: z
    .array(z.strictObject({ lineId: z.uuid(), quantity: Quantity.optional(), amountPesewas: Pesewas.optional() }))
    .min(1)
    .max(200),
});

export const DebitNoteCreate = z.strictObject({
  reasonCode: ReasonCode,
  note: Note,
  lines: z
    .array(z.strictObject({ description: Description, amountPesewas: Pesewas, taxCategoryId: z.uuid() }))
    .min(1)
    .max(200),
});

export const ReprintRequest = z.strictObject({ channel: z.enum(['THERMAL', 'PDF']) });

export const ReprintPageQuery = z.object({ cursor: Cursor, limit: Limit });

/** `sendBillingDocument` (B11 continued 13): the channels in order, each once; `recipient` is only checked, never kept. */
export const DocumentSendRequest = z.strictObject({
  channels: z
    .array(z.enum(['SMS', 'WHATSAPP', 'EMAIL']))
    .min(1)
    .max(3)
    .refine((c) => new Set(c).size === c.length, { message: 'each channel once' }),
  recipient: z.string().min(1).max(254).optional(),
});
