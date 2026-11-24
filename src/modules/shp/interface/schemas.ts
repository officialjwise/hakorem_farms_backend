import { z } from 'zod';

const Quantity = z.string().regex(/^(0|[1-9][0-9]{0,10})\.[0-9]{3}$/);
const Phone = z.string().trim().min(7).max(20);
const Text = (max: number) => z.string().trim().min(1).max(max);

/** The most of one item a cart line holds (abuse limit, A-178). */
export const MAX_LINE_UNITS = 999;

export const IdParam = z.uuid();
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().min(1).max(512).optional();
export const PageQuery = z.object({ cursor: Cursor, limit: Limit });
export const SlugParam = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(80);

export const CatalogueQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  category: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/).optional(),
  productLine: z.enum(['LIVE', 'MEAT', 'PRODUCE', 'BY_PRODUCT', 'FEED', 'SUPPLY', 'SERVICE']).optional(),
  availability: z.enum(['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'ON_REQUEST']).optional(),
  // Any text up to 40: a value outside the contract's list is refused by the shared sort (400 SORT_NOT_ALLOWED).
  sort: z.string().min(1).max(40).optional(),
  cursor: Cursor,
  limit: Limit,
});

const LineQuantity = Quantity.refine((value) => Number.parseInt(value, 10) <= MAX_LINE_UNITS, `at most ${MAX_LINE_UNITS}`);
/** CR-039: `uom`, the unit added (a crate or a single egg); left out, the product's sale unit. */
export const CartLineAdd = z.strictObject({ productId: z.uuid(), quantity: LineQuantity, uom: z.string().regex(/^[A-Z][A-Z0-9_]{0,19}$/).optional() });
export const CartLineUpdate = z.strictObject({ quantity: LineQuantity });
export const CouponApply = z.strictObject({ code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/) });

const AddressInput = z.strictObject({
  recipientName: Text(120),
  recipientPhone: Phone,
  line1: Text(200),
  area: Text(80),
  city: Text(80),
  region: Text(40),
  digitalAddress: z.string().trim().max(20).optional(),
  directions: z.string().trim().max(300).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

export const CheckoutStart = z.strictObject({
  contactName: Text(120),
  contactPhone: Phone,
  fulfilmentMode: z.enum(['COLLECTION', 'DELIVERY']),
  deliveryAddressId: z.uuid().optional(),
  address: AddressInput.optional(),
  deliverySlotId: z.uuid().optional(),
  paymentTerms: z.enum(['PREPAID', 'COD']),
  differencePreference: z.enum(['REFUND', 'STORE_CREDIT']).optional(),
});

export const CheckoutUpdate = z.strictObject({
  deliveryAddressId: z.uuid().optional(),
  address: AddressInput.optional(),
  deliverySlotId: z.uuid().optional(),
  paymentTerms: z.enum(['PREPAID', 'COD']).optional(),
  differencePreference: z.enum(['REFUND', 'STORE_CREDIT']).optional(),
});

export const SlotOptionQuery = z.object({ zoneId: z.uuid(), from: z.iso.date().optional(), cursor: Cursor, limit: Limit });

/** The contract's `PlaceOrderRequest`. */
export const PlaceOrder = z.strictObject({
  paymentMethod: z.enum(['MOBILE_MONEY', 'CARD', 'COD']),
  payerPhone: Phone.optional(),
  network: z.enum(['MTN', 'TELECEL', 'AIRTELTIGO']).optional(),
});
