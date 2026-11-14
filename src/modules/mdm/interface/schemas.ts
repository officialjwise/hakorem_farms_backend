import { z } from 'zod';

/** The contract's `Kilograms`: three decimal places, a string so no float ever touches it. */
const Kilograms = z.string().regex(/^(0|[1-9][0-9]{0,6})\.[0-9]{3}$/);
/** The contract's `Percent`: 0 to 100, up to four decimal places. */
const Percent = z.string().regex(/^(100|[0-9]{1,2})(\.[0-9]{1,4})?$/);
const StockPolicy = z.enum(['SERIALISED', 'CATCH_WEIGHT', 'COUNTABLE', 'NON_STOCK']);
const OnlineMode = z.enum(['HIDDEN', 'LISTED', 'REQUEST_TO_BUY']);
const ProductStatus = z.enum(['DRAFT', 'ACTIVE', 'DISCONTINUED']);

/**
 * The contract's `ProductCreate` (createProduct), strict. Length and pattern limits are the ones migration 0009
 * enforces, so a value the database would refuse is a 400 with the field named, not a 500.
 */
export const ProductCreate = z.strictObject({
  sku: z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,39}$/),
  name: z.string().trim().min(1).max(120),
  categoryId: z.uuid(),
  stockPolicy: StockPolicy,
  speciesId: z.uuid().optional(),
  baseUom: z.string().regex(/^[A-Z]{2,10}$/),
  saleUom: z.string().regex(/^[A-Z]{2,10}$/),
  nominalPackKg: Kilograms.optional(),
  weightTolerancePercent: Percent.optional(),
  taxCategoryId: z.uuid().optional(),
  shelfLifeDays: z.number().int().min(1).max(3_650).optional(),
  storageTempClass: z.enum(['AMBIENT', 'CHILLED', 'FROZEN']).optional(),
  withdrawalDays: z.number().int().min(0).max(365).optional(),
  barcode: z.string().regex(/^[0-9A-Za-z-]{4,40}$/).optional(),
  description: z.string().max(2_000).optional(),
  onlineMode: OnlineMode,
  seo: z
    .strictObject({
      slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(80).optional(),
      title: z.string().max(120).optional(),
      description: z.string().max(300).optional(),
    })
    .optional(),
  isPurchasable: z.boolean().optional(),
  isSellable: z.boolean().optional(),
});

/** listProducts query. Unknown parameters are ignored (docs/API.md section 6). */
export const ListProductsQuery = z.object({
  q: z.string().trim().min(1).max(80).optional(),
  categoryId: z.uuid().optional(),
  stockPolicy: StockPolicy.optional(),
  onlineMode: OnlineMode.optional(),
  status: ProductStatus.optional(),
  barcode: z.string().min(1).max(40).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const ProductIdParam = z.uuid();

/** The contract's `Quantity`: three decimal places, a string. */
const Quantity = z.string().regex(/^(0|[1-9][0-9]{0,10})\.[0-9]{3}$/);
/** The contract's `Pesewas`: a JSON integer, carried inward as a bigint so no float touches it. */
const Pesewas = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .transform((value) => BigInt(value));
const Channel = z.enum(['POS', 'ONLINE', 'WHOLESALE', 'QUOTE']);
const PriceListKind = z.enum(['BASE', 'CHANNEL', 'TIER', 'CUSTOMER']);
const PriceBasis = z.enum(['PER_HEAD', 'PER_KG', 'PER_UNIT']);
const DateTime = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

/** The most lines one resolvePrices call prices: a large wholesale order. */
export const MAX_RESOLVE_LINES = 200;
/** The most entries one version holds: the whole catalogue in every band, with room to spare. */
export const MAX_PRICE_LIST_ENTRIES = 5_000;

/** The contract's `PriceResolveRequest`, strict. */
export const PriceResolveRequest = z.strictObject({
  channel: Channel,
  branchId: z.uuid(),
  customerId: z.uuid().optional(),
  at: DateTime.optional(),
  couponCode: z.string().trim().min(1).max(40).optional(),
  lines: z
    .array(
      z.strictObject({
        lineRef: z.string().min(1).max(40),
        productId: z.uuid(),
        stockUnitId: z.uuid().optional(),
        gradeId: z.uuid().optional(),
        weightKg: Kilograms.optional(),
        quantity: Quantity,
      }),
    )
    .min(1)
    .max(MAX_RESOLVE_LINES),
});

/** The contract's `PriceListCreate`, strict. Slot rules (which kinds take a channel or tier) are the domain's. */
export const PriceListCreate = z.strictObject({
  code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/),
  name: z.string().trim().min(1).max(120),
  kind: PriceListKind,
  channel: Channel.optional(),
  customerTierId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  taxInclusive: z.boolean(),
});

/** The contract's `PriceListVersionCreate`, strict. */
export const PriceListVersionCreate = z.strictObject({
  validFrom: DateTime,
  validTo: DateTime.optional(),
  copyFromVersionId: z.uuid().optional(),
  notes: z.string().trim().min(1).max(500).optional(),
});

/** The contract's `PriceListEntriesReplace`, strict. */
export const PriceListEntriesReplace = z.strictObject({
  version: z.number().int().min(1),
  entries: z
    .array(
      z.strictObject({
        productId: z.uuid(),
        gradeId: z.uuid().optional(),
        weightBandId: z.uuid().optional(),
        basis: PriceBasis,
        listPricePesewas: Pesewas,
        floorPricePesewas: Pesewas,
        ceilingPricePesewas: Pesewas,
        quoteOnly: z.boolean().optional(),
        minQty: Quantity.optional(),
      }),
    )
    .max(MAX_PRICE_LIST_ENTRIES),
});

export const IdParam = z.uuid();
