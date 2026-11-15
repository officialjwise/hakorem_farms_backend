import { z } from 'zod';

/** The contract's `Quantity` (above zero where a line needs it), `Pesewas` and `Percent`. */
const Quantity = z.string().regex(/^(0|[1-9][0-9]{0,10})\.[0-9]{3}$/);
const PositiveQuantity = Quantity.refine((value) => value !== '0.000', 'must be above zero');
const Pesewas = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** The contract's `Percent`, held to 100 at most by the pattern itself, never by a float comparison. */
const Percent = z.string().regex(/^(100(\.0{1,4})?|[0-9]{1,2}(\.[0-9]{1,4})?)$/);
const CalendarDate = z.iso.date();
const UomCode = z.string().regex(/^[A-Z]{2,10}$/);
const Text = (max: number) => z.string().trim().min(1).max(max);

/** The most lines one purchase order or supplier invoice carries, and the most invoices one payment settles. */
export const MAX_DOCUMENT_LINES = 100;
export const MAX_ALLOCATIONS = 50;

export const IdParam = z.uuid();
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().min(1).max(512).optional();
const Bool = z.enum(['true', 'false']).transform((value) => value === 'true');
export const PageQuery = z.object({ cursor: Cursor, limit: Limit });
export const ReasonBody = z.strictObject({ reason: z.string().trim().min(1).max(500) });

/** The contract's `PurchaseOrderLineInput`, strict; `uom` is the unit the line is bought by, the base unit when absent. */
const PurchaseOrderLineInput = z.strictObject({
  productId: z.uuid(),
  description: Text(200).optional(),
  uom: UomCode.optional(),
  qtyOrdered: PositiveQuantity,
  unitPricePesewas: Pesewas,
  overReceiptTolerancePercent: Percent.optional(),
  expenseCategory: Text(60).optional(),
});

export const PurchaseOrderCreate = z.strictObject({
  supplierId: z.uuid(),
  deliverToLocationId: z.uuid(),
  orderDate: CalendarDate,
  expectedOn: CalendarDate.optional(),
  taxInclusive: z.boolean().optional(),
  lines: z.array(PurchaseOrderLineInput).max(MAX_DOCUMENT_LINES),
});

export const PurchaseOrderUpdate = z.strictObject({
  version: z.number().int().min(1),
  expectedOn: CalendarDate.optional(),
  lines: z.array(PurchaseOrderLineInput).max(MAX_DOCUMENT_LINES).optional(),
});

export const PurchaseOrderSend = z.strictObject({
  channels: z.array(z.enum(['EMAIL', 'WHATSAPP'])).max(2),
  recipient: Text(200).optional(),
});

const OrderStatus = z.enum(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED']);
export const PurchaseOrderPageQuery = PageQuery.extend({
  status: OrderStatus.optional(),
  supplierId: z.uuid().optional(),
  from: CalendarDate.optional(),
  to: CalendarDate.optional(),
});

/** The contract's `SupplierInvoiceLineInput`, strict. */
const SupplierInvoiceLineInput = z.strictObject({
  productId: z.uuid().optional(),
  description: Text(200),
  purchaseOrderLineId: z.uuid().optional(),
  goodsReceiptLineId: z.uuid().optional(),
  qty: PositiveQuantity,
  unitPricePesewas: Pesewas,
  taxCategoryId: z.uuid(),
  leviesCharged: z.array(z.strictObject({ levyId: z.uuid(), amountPesewas: Pesewas })).max(10).optional(),
  expenseCategory: Text(60).optional(),
});

const InvoiceNo = Text(60);

export const SupplierInvoiceCreate = z.strictObject({
  kind: z.enum(['INVOICE', 'CREDIT_NOTE']),
  supplierId: z.uuid(),
  supplierInvoiceNo: InvoiceNo,
  invoiceDate: CalendarDate,
  dueDate: CalendarDate.optional(),
  purchaseOrderId: z.uuid().optional(),
  originalInvoiceId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  fileId: z.uuid().optional(),
  statedGrossPesewas: Pesewas.optional(),
  lines: z.array(SupplierInvoiceLineInput).max(MAX_DOCUMENT_LINES),
});

export const SupplierInvoiceUpdate = z.strictObject({
  version: z.number().int().min(1),
  supplierInvoiceNo: InvoiceNo.optional(),
  invoiceDate: CalendarDate.optional(),
  dueDate: CalendarDate.optional(),
  fileId: z.uuid().optional(),
  statedGrossPesewas: Pesewas.optional(),
  lines: z.array(SupplierInvoiceLineInput).max(MAX_DOCUMENT_LINES).optional(),
});

export const SupplierInvoicePageQuery = PageQuery.extend({
  status: z.enum(['DRAFT', 'MATCHED', 'MISMATCH', 'APPROVED', 'PAID', 'CANCELLED']).optional(),
  supplierId: z.uuid().optional(),
  matchStatus: z.enum(['UNMATCHED', 'MATCHED', 'MISMATCH', 'NOT_REQUIRED']).optional(),
  dueBefore: CalendarDate.optional(),
  outstandingOnly: Bool.optional(),
});

const PaymentMethod = z.enum(['BANK', 'MOBILE_MONEY', 'CASH', 'CHEQUE']);

export const SupplierPaymentCreate = z.strictObject({
  supplierId: z.uuid(),
  method: PaymentMethod,
  bankAccountId: z.uuid().optional(),
  scheduledFor: CalendarDate.optional(),
  allocations: z.array(z.strictObject({ supplierInvoiceId: z.uuid(), amountPesewas: Pesewas.refine((value) => value > 0, 'must be above zero') })).max(MAX_ALLOCATIONS),
});

export const SupplierPaymentMarkPaid = z.strictObject({
  paidAt: z.iso.datetime({ offset: true }),
  externalReference: Text(80),
});

export const SupplierPaymentPageQuery = PageQuery.extend({
  status: z.enum(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAID', 'REJECTED', 'CANCELLED']).optional(),
  supplierId: z.uuid().optional(),
  scheduledBefore: CalendarDate.optional(),
});
