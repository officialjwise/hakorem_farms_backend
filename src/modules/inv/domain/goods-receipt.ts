import type { Money, Quantity } from '@hakorem/kernel';

export type ReceiptKind = 'PURCHASE' | 'HARVEST' | 'OPENING';
export type Tracking = 'SERIAL' | 'LOT' | 'NONE';

/** A rule a receipt line breaks: the JSON pointer of the field and the rule's code (`details[].code`). */
export interface ReceiptRuleBroken {
  readonly field: string;
  readonly rule: string;
}

export interface ReceiptLineDraft {
  readonly qtyReceived: Quantity;
  readonly value: Money;
  readonly batchNo: string | null;
  /** A calendar date, `YYYY-MM-DD`. */
  readonly expiresOn: string | null;
  readonly animalTags: readonly string[];
}

/** What master data says about a line's product (MDM's `ProductFacts`, narrowed to the rules here). */
export interface ReceiptProductFacts {
  readonly tracking: Tracking;
  readonly stockPolicy: string;
  readonly shelfLifeDays: number | null;
  readonly isPurchasable: boolean;
  readonly isLive: boolean;
}

export interface ReceiptLinePlanInput {
  readonly kind: ReceiptKind;
  /** The receipt's business date in Africa/Accra, `YYYY-MM-DD`. */
  readonly receivedOn: string;
  readonly lines: ReadonlyArray<{ readonly draft: ReceiptLineDraft; readonly product: ReceiptProductFacts; readonly productId: string }>;
}

const UNIT = 1_000n;

/**
 * The rules a goods receipt's lines must keep before it is saved or posted (FR-INV-005, FR-INV-009): an animal for
 * every head of a serialised product, each tag once in the receipt; a batch number for a lot, once per product in
 * the receipt, and an expiry date when the product has a shelf life, not before the stock arrives; nothing tracked
 * on an untracked product; a value on every purchase line. The database refuses the same shapes again.
 */
export function checkReceiptLines(input: ReceiptLinePlanInput): ReceiptRuleBroken[] {
  const broken: ReceiptRuleBroken[] = [];
  const tags = new Set<string>();
  const batches = new Set<string>();
  input.lines.forEach(({ draft, product, productId }, index) => {
    const at = (field: string) => `/lines/${index}${field}`;
    const fail = (field: string, rule: string) => broken.push({ field: at(field), rule });
    if (!product.isLive) fail('/productId', 'PRODUCT_NOT_ACTIVE');
    if (product.stockPolicy === 'NON_STOCK') fail('/productId', 'PRODUCT_NOT_STOCKED');
    if (input.kind === 'PURCHASE' && !product.isPurchasable) fail('/productId', 'PRODUCT_NOT_PURCHASABLE');
    if (input.kind === 'PURCHASE' && draft.value.isZero()) fail('/valuePesewas', 'VALUE_REQUIRED');

    if (product.tracking === 'SERIAL') {
      if (draft.qtyReceived.thousandths % UNIT !== 0n) fail('/qtyReceived', 'WHOLE_ANIMALS_ONLY');
      if (BigInt(draft.animalTags.length) * UNIT !== draft.qtyReceived.thousandths) fail('/animals', 'ONE_ANIMAL_PER_HEAD');
      if (draft.batchNo !== null) fail('/batchNo', 'NOT_FOR_SERIAL_PRODUCT');
      if (draft.expiresOn !== null) fail('/expiresOn', 'NOT_FOR_SERIAL_PRODUCT');
      draft.animalTags.forEach((tag, animal) => {
        if (tags.has(tag)) broken.push({ field: at(`/animals/${animal}/tagNo`), rule: 'TAG_REPEATED' });
        tags.add(tag);
      });
      return;
    }
    if (draft.animalTags.length > 0) fail('/animals', 'NOT_FOR_THIS_PRODUCT');
    if (product.tracking === 'NONE') {
      if (draft.batchNo !== null) fail('/batchNo', 'PRODUCT_NOT_TRACKED');
      if (draft.expiresOn !== null) fail('/expiresOn', 'PRODUCT_NOT_TRACKED');
      return;
    }
    if (draft.batchNo === null) {
      fail('/batchNo', 'BATCH_REQUIRED');
    } else {
      const batchKey = `${productId}:${draft.batchNo.toUpperCase()}`;
      if (batches.has(batchKey)) fail('/batchNo', 'BATCH_REPEATED');
      batches.add(batchKey);
    }
    if (draft.expiresOn === null) {
      if (product.shelfLifeDays !== null) fail('/expiresOn', 'EXPIRY_REQUIRED');
    } else if (draft.expiresOn < input.receivedOn) {
      fail('/expiresOn', 'EXPIRED_ON_ARRIVAL');
    }
  });
  return broken;
}
