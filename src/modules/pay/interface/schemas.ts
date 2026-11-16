import { z } from 'zod';

const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().min(1).max(512).optional();
const Pesewas = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const ReasonCode = z.string().regex(/^[A-Z][A-Z_]{1,39}$/);
const Text = (max: number) => z.string().max(max).refine((text) => text.trim().length > 0, { message: 'cannot be blank' });
const Flag = z.enum(['true', 'false']).transform((v) => v === 'true');

export const IdParam = z.uuid();
export const ProviderParam = z.string().regex(/^[A-Z][A-Z_]{1,29}$/);

export const PaymentPageQuery = z.object({
  status: z.enum(['PENDING', 'CLEARED', 'FAILED', 'REVERSED']).optional(),
  methodKind: z.enum(['CASH', 'MOBILE_MONEY', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'STORE_CREDIT']).optional(),
  customerId: z.uuid().optional(),
  orderId: z.uuid().optional(),
  shiftId: z.uuid().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  unallocatedOnly: Flag.optional(),
  cursor: Cursor,
  limit: Limit,
});

export const PageQuery = z.object({ cursor: Cursor, limit: Limit });

export const MobileMoneyChargeBody = z.strictObject({
  id: z.uuid(),
  amountPesewas: Pesewas,
  payerPhone: z.string().regex(/^\+233[0-9]{9}$/, 'a Ghanaian mobile number in E.164'),
  network: z.enum(['MTN', 'TELECEL', 'AIRTELTIGO']),
  orderId: z.uuid().optional(),
  shiftId: z.uuid().optional(),
  customerId: z.uuid().optional(),
});

export const AllocationBody = z.strictObject({
  allocations: z.array(z.strictObject({ billingDocumentId: z.uuid(), amountPesewas: Pesewas })).min(1).max(50),
});

export const RecordPaymentBody = z.strictObject({
  id: z.uuid(),
  paymentMethodId: z.uuid(),
  amountPesewas: Pesewas,
  customerId: z.uuid().optional(),
  orderId: z.uuid().optional(),
  shiftId: z.uuid().optional(),
  bankAccountId: z.uuid().optional(),
  externalReference: z.string().min(1).max(100).refine((text) => text === text.trim(), { message: 'no surrounding spaces' }).optional(),
  chequeDueOn: z.iso.date().optional(),
  receivedAt: z.iso.datetime(),
  allocations: z.array(z.strictObject({ billingDocumentId: z.uuid(), amountPesewas: Pesewas })).max(50).optional(),
});

export const ReversalBody = z.strictObject({ reasonCode: ReasonCode, note: Text(500).optional() });

export const ChequeClearanceBody = z.strictObject({ clearedOn: z.iso.date() });

export const OpenItemQuery = z.object({
  customerId: z.uuid().optional(),
  overdueOnly: Flag.optional(),
  asOf: z.iso.date().optional(),
  cursor: Cursor,
  limit: Limit,
});

export const UnallocateBody = z.strictObject({ allocationId: z.uuid(), reason: Text(500) });

export const RefundPageQuery = z.object({
  status: z.enum(['REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'PAID', 'FAILED', 'REJECTED']).optional(),
  createdBy: z.uuid().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  cursor: Cursor,
  limit: Limit,
});

export const RefundBody = z.strictObject({
  originalPaymentId: z.uuid(),
  amountPesewas: Pesewas,
  destination: z.enum(['ORIGINAL_METHOD', 'STORE_CREDIT', 'CASH']),
  reasonCode: ReasonCode,
  creditNoteId: z.uuid().optional(),
  note: Text(500).optional(),
});

export const RefundMarkPaidBody = z.strictObject({ paidAt: z.iso.datetime(), externalReference: Text(100).optional() });

/**
 * A provider's webhook body: the route takes it as it came, because the signature is over the raw bytes and every
 * request is logged whatever it holds; the adapter reads its fields only after the signature is checked.
 */
export const ProviderWebhookBody = z.unknown();
