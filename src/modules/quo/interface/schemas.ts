import { z } from 'zod';

const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().min(1).max(512).optional();
const Pesewas = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).transform((n) => BigInt(n));
const Quantity = z.string().regex(/^(0|[1-9][0-9]{0,10})\.[0-9]{3}$/);
const Phone = z.string().regex(/^\+[1-9][0-9]{7,14}$/);
const Uom = z.string().regex(/^[A-Z][A-Z0-9_]{0,15}$/);
const BusinessDate = z.iso.date();
const Instant = z.iso.datetime({ offset: true }).transform((t) => new Date(t));
const Text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((text) => text.trim().length > 0, { message: 'cannot be blank' });
const PriceBasis = z.enum(['PER_HEAD', 'PER_KG', 'PER_UNIT']);
const QuoteStatus = z.enum(['DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CONVERTED', 'CANCELLED']);

export const IdParam = z.uuid();
/** A quote link's token as typed in a URL: checked for its form by the handler, so a guess and a malformed text read alike. */
export const LinkTokenParam = z.string().min(1).max(200);

/** The contract's `PublicQuoteRequest`, strict, with item 4's quantity and unit (both or neither, and only with a product). */
export const PublicQuoteRequest = z
  .strictObject({
    contactName: Text(160),
    contactPhone: Phone,
    contactEmail: z.email().max(254).optional(),
    requirements: Text(2000),
    productId: z.uuid().optional(),
    stockUnitId: z.uuid().optional(),
    quantity: Quantity.optional(),
    uom: Uom.optional(),
    neededBy: BusinessDate.optional(),
    deliveryArea: Text(120).optional(),
    consentToContact: z.literal(true),
  })
  .refine((r) => (r.quantity === undefined) === (r.uom === undefined), { message: 'a quantity names its unit', path: ['uom'] })
  .refine((r) => r.quantity === undefined || r.productId !== undefined, { message: 'a quantity is of a product', path: ['productId'] })
  .refine((r) => r.stockUnitId === undefined || r.productId !== undefined, { message: 'an animal is of a product', path: ['productId'] });

export const RfqCreate = z
  .strictObject({
    source: z.enum(['PHONE', 'WHATSAPP', 'COUNTER', 'WHOLESALE_ORDER']),
    customerId: z.uuid().optional(),
    contactName: Text(160),
    contactPhone: Phone,
    requirements: Text(2000),
    productId: z.uuid().optional(),
    quantity: Quantity.optional(),
    uom: Uom.optional(),
    neededBy: BusinessDate.optional(),
    deliveryArea: Text(120).optional(),
  })
  .refine((r) => (r.quantity === undefined) === (r.uom === undefined), { message: 'a quantity names its unit', path: ['uom'] })
  .refine((r) => r.quantity === undefined || r.productId !== undefined, { message: 'a quantity is of a product', path: ['productId'] });

export const RfqUpdate = z.strictObject({ assignedToId: z.uuid().optional(), customerId: z.uuid().optional(), status: z.enum(['IN_PROGRESS', 'CLOSED', 'SPAM']).optional() });

export const RfqPageQuery = z.object({
  status: z.enum(['NEW', 'IN_PROGRESS', 'QUOTED', 'CLOSED', 'SPAM']).optional(),
  source: z.enum(['PUBLIC_FORM', 'REQUEST_TO_BUY', 'PHONE', 'WHATSAPP', 'COUNTER', 'WHOLESALE_ORDER']).optional(),
  assignedToId: z.uuid().optional(),
  cursor: Cursor,
  limit: Limit,
});

/** The contract's `QuoteLineInput`, strict, with CR-045's unit. */
const QuoteLineInput = z.strictObject({
  productId: z.uuid().optional(),
  description: Text(500),
  gradeId: z.uuid().optional(),
  weightBandId: z.uuid().optional(),
  stockUnitId: z.uuid().optional(),
  quantity: Quantity.refine((q) => q !== '0.000', { message: 'must be above zero' }),
  uom: Uom.optional(),
  priceBasis: PriceBasis,
  unitPricePesewas: Pesewas,
});

export const QuoteCreate = z.strictObject({
  rfqId: z.uuid().optional(),
  customerId: z.uuid().optional(),
  contactName: Text(160),
  contactPhone: Phone,
  validUntil: Instant,
  terms: Text(2000).optional(),
  deliveryEstimate: Text(500).optional(),
  deliveryFeePesewas: Pesewas.optional(),
  taxInclusive: z.boolean(),
  lines: z.array(QuoteLineInput).min(1).max(100),
});

export const QuotePageQuery = z.object({
  status: QuoteStatus.optional(),
  customerId: z.uuid().optional(),
  salespersonId: z.uuid().optional(),
  from: Instant.optional(),
  to: Instant.optional(),
  cursor: Cursor,
  limit: Limit,
});

export const PageQuery = z.object({ cursor: Cursor, limit: Limit });
export const QuoteVersionCreate = z.strictObject({ changeNote: Text(500), copyFromVersionId: z.uuid().optional() });
export const QuoteVersionUpdate = z.strictObject({
  version: z.number().int().min(1),
  validUntil: Instant.optional(),
  terms: Text(2000).optional(),
  deliveryEstimate: Text(500).optional(),
  deliveryFeePesewas: Pesewas.optional(),
  lines: z.array(QuoteLineInput).min(1).max(100).optional(),
});
export const QuoteIssue = z.strictObject({ channels: z.array(z.enum(['SMS', 'WHATSAPP', 'EMAIL'])).max(3) });
export const QuoteAcceptanceRecord = z.strictObject({ method: z.enum(['IN_PERSON', 'PHONE_CONFIRMED']), acceptedName: Text(160), note: Text(1000).optional() });
export const ReasonRequest = z.strictObject({ reason: Text(500) });
export const QuoteConvert = z.strictObject({
  fulfilmentMode: z.enum(['COLLECTION', 'DELIVERY']),
  paymentTerms: z.enum(['PREPAID', 'COD', 'CREDIT']),
  deliveryAddressId: z.uuid().optional(),
  deliverySlotId: z.uuid().optional(),
  stockUnitIds: z.array(z.uuid()).max(200).optional(),
});
export const QuoteAcceptByLink = z.strictObject({ acceptedName: Text(160) });
export const QuoteDeclineByLink = z.strictObject({ reason: Text(500).optional() });
