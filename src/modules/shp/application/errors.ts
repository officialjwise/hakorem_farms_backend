import { ApiError, BusinessRuleError, type ErrorDetail } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';

/** SHP's user-facing messages (docs/API.md section 10), shown to shoppers. Registered when the module loads. */
registerMessages({
  'shp.request_to_buy_only': 'This item is sold by request only. Ask us for a quote and we will confirm the animal and its price.',
  'shp.product_unavailable': 'This item cannot be bought online right now.',
  'shp.quantity_invalid': 'Choose a whole number of items, and at most 50 different items in one cart.',
  'shp.cart_not_active': 'This cart is already at checkout or closed. Start a new cart or finish the checkout.',
  'shp.cart_empty': 'Your cart is empty.',
  'shp.coupon_already_applied': 'Only one coupon can be used. Remove the one in your cart first.',
  'shp.stock_unavailable': 'Some items in your cart are no longer available in the quantity you chose.',
  'shp.delivery_unavailable': 'We do not deliver to this address yet. You can collect your order from the farm instead.',
  'shp.slot_unavailable': 'This delivery slot cannot be chosen. Pick another one.',
  'shp.checkout_invalid': 'This checkout cannot be started or changed like this.',
  'shp.checkout_not_open': 'This checkout has ended. Your cart is still there: start the checkout again.',
  'shp.reference_not_found': 'Something this request refers to does not exist.',
  'shp.final_charge_rule': 'You pay GHS {estimate} for these items. Each pack is weighed before dispatch and you pay for the weighed amount, never more than GHS {maximum} in total without asking you first. If it weighs less we {difference}.',
  'shp.final_charge_rule_fixed': 'You pay GHS {estimate}. The price of every item is fixed.',
  'shp.momo_instructions': 'Approve GHS {amount} to HaKorem Farms on your {network} phone when the prompt appears.',
  'shp.difference_refund': 'refund the difference',
  'shp.difference_store_credit': 'keep the difference as store credit for your next order',
  'shp.product_charge_rule': 'Priced at GHS {price} per kg. Each pack is weighed before dispatch and you pay for the weighed amount, at most {tolerance}% above the estimate. If it weighs less we refund the difference.',
});

function detail(field: string | null, code: string, messageKey: string): ErrorDetail {
  return { field, code, message: translate(messageKey) };
}

/** 422 REQUEST_TO_BUY_ONLY: a live animal (or any request-to-buy product) cannot go in a cart (FR-SHP-003, ADR-0019). */
export class RequestToBuyOnlyError extends BusinessRuleError {
  readonly code = 'REQUEST_TO_BUY_ONLY';
  readonly messageKey = 'shp.request_to_buy_only';
  constructor(field: string) {
    super('request-to-buy products open a quote request', [detail(field, 'REQUEST_TO_BUY_ONLY', 'shp.request_to_buy_only')]);
  }
}

/** 422 PRODUCT_UNAVAILABLE: not listed online, or the pricing engine has no online price for it (it needs a quote). */
export class ProductUnavailableError extends BusinessRuleError {
  readonly code = 'PRODUCT_UNAVAILABLE';
  readonly messageKey = 'shp.product_unavailable';
  constructor(field: string, rule: 'NOT_LISTED' | 'NO_ONLINE_PRICE' | 'NOT_TAX_INCLUSIVE') {
    super(`product unavailable: ${rule}`, [detail(field, rule, 'shp.product_unavailable')]);
  }
}

/** 422 QUANTITY_INVALID: a storefront quantity is whole sale units above zero (A-178). */
export class QuantityInvalidError extends BusinessRuleError {
  readonly code = 'QUANTITY_INVALID';
  readonly messageKey = 'shp.quantity_invalid';
  constructor(rule: 'WHOLE_UNITS' | 'TOO_MANY_LINES') {
    super(`cart quantity: ${rule}`, [detail('/quantity', rule, 'shp.quantity_invalid')]);
  }
}

/** 409 CART_NOT_ACTIVE: a cart at checkout or closed takes no change and no second checkout. */
export class CartNotActiveError extends ApiError {
  readonly status = 409;
  readonly code = 'CART_NOT_ACTIVE';
  readonly messageKey = 'shp.cart_not_active';
}

/** 422 CART_EMPTY: a checkout needs at least one line. */
export class CartEmptyError extends BusinessRuleError {
  readonly code = 'CART_EMPTY';
  readonly messageKey = 'shp.cart_empty';
}

/** 422 COUPON_ALREADY_APPLIED: one coupon per cart (FR-SHP-004). */
export class CouponAlreadyAppliedError extends BusinessRuleError {
  readonly code = 'COUPON_ALREADY_APPLIED';
  readonly messageKey = 'shp.coupon_already_applied';
}

/** 422 STOCK_UNAVAILABLE: a line cannot be reserved, so the checkout reserves nothing (FR-SHP-005). */
export class StockUnavailableError extends BusinessRuleError {
  readonly code = 'STOCK_UNAVAILABLE';
  readonly messageKey = 'shp.stock_unavailable';
  constructor(cartLineIds: readonly string[]) {
    super(`not enough stock for ${cartLineIds.join(', ')}`, cartLineIds.map((id) => detail(`/lines/${id}`, 'NOT_ENOUGH_STOCK', 'shp.stock_unavailable')));
  }
}

/** 422 DELIVERY_UNAVAILABLE: the address is in no zone this shop delivers to (FR-SHP-008): collection only. */
export class DeliveryUnavailableError extends BusinessRuleError {
  readonly code = 'DELIVERY_UNAVAILABLE';
  readonly messageKey = 'shp.delivery_unavailable';
  constructor() {
    super('no delivery zone covers the address', [detail('/address', 'COLLECTION_ONLY', 'shp.delivery_unavailable')]);
  }
}

/** 422 SLOT_UNAVAILABLE: no such slot, another zone's, or one that has started (FR-SHP-009, SA-13). */
export class SlotUnavailableError extends BusinessRuleError {
  readonly code = 'SLOT_UNAVAILABLE';
  readonly messageKey = 'shp.slot_unavailable';
  constructor(rule: 'UNKNOWN' | 'OTHER_ZONE' | 'STARTED' | 'NOT_FOR_COLLECTION') {
    super(`slot unavailable: ${rule}`, [detail('/deliverySlotId', rule, 'shp.slot_unavailable')]);
  }
}

/** 422 CHECKOUT_INVALID: the checkout's details break a rule; `details[].code` names it. */
export class CheckoutInvalidError extends BusinessRuleError {
  readonly code = 'CHECKOUT_INVALID';
  readonly messageKey = 'shp.checkout_invalid';
  constructor(rules: readonly { readonly field: string | null; readonly rule: string }[]) {
    super('checkout breaks a rule', rules.map((r) => detail(r.field, r.rule, 'shp.checkout_invalid')));
  }
}

/** 409 CHECKOUT_NOT_OPEN: an expired, cancelled or completed checkout takes no change. */
export class CheckoutNotOpenError extends ApiError {
  readonly status = 409;
  readonly code = 'CHECKOUT_NOT_OPEN';
  readonly messageKey = 'shp.checkout_not_open';
}

/** Fills a registered message's `{placeholders}`. */
export function fill(key: string, values: Readonly<Record<string, string>>): string {
  return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), translate(key));
}
