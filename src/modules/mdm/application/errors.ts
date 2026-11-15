import { BusinessRuleError, ValidationFailedError, type ErrorDetail } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';
import type { FieldRule } from '../domain/product';

/** MDM's user-facing messages (docs/API.md section 10.3). Registered when the module loads. */
registerMessages({
  'mdm.reference_not_found': 'Something this record refers to does not exist.',
  'mdm.reference_unknown': 'There is no such record.',
  'mdm.stock_policy_conflict': "These settings do not fit the product's stock-keeping policy.",
  'mdm.stock_policy_rule': 'This value does not fit the stock-keeping policy.',
  'mdm.duplicate_value': 'Another product already uses this value.',
  'mdm.duplicate_field': 'Already in use.',
});

function details(fields: readonly FieldRule[], messageKey: string): ErrorDetail[] {
  return fields.map((field) => ({ field: field.field, code: field.rule, message: translate(messageKey) }));
}

/** 422: an id in the request names no record (an unknown category, species, tax category or unit). */
export class ReferenceNotFoundError extends BusinessRuleError {
  readonly code = 'REFERENCE_NOT_FOUND';
  readonly messageKey = 'mdm.reference_not_found';

  constructor(fields: readonly FieldRule[]) {
    super('product refers to records that do not exist', details(fields, 'mdm.reference_unknown'));
  }
}

/** 422: the product's fields contradict its stock-keeping policy. */
export class StockPolicyConflictError extends BusinessRuleError {
  readonly code = 'STOCK_POLICY_CONFLICT';
  readonly messageKey = 'mdm.stock_policy_conflict';

  constructor(fields: readonly FieldRule[]) {
    super('product fields contradict its stock-keeping policy', details(fields, 'mdm.stock_policy_rule'));
  }
}

/** 422: a unique value (SKU, barcode, storefront slug) is already used by another live product. */
export class DuplicateValueError extends BusinessRuleError {
  readonly code = 'DUPLICATE_VALUE';
  readonly messageKey = 'mdm.duplicate_value';

  constructor(fields: readonly string[]) {
    super('a unique product value is taken', details(fields.map((field) => ({ field, rule: 'TAKEN' })), 'mdm.duplicate_field'));
  }
}

registerMessages({
  'mdm.duplicate_record': 'Another record already uses this value.',
  'mdm.price_entry_invalid': 'Some price list entries are not valid.',
  'mdm.price_entry_rule': 'This value is not valid for a price list entry.',
  'mdm.price_entry_duplicate': 'Two entries are for the same product, grade, weight band and quantity.',
  'mdm.price_entry_duplicate_field': 'An earlier entry already covers this product, grade, band and quantity.',
  'mdm.price_list_rule': 'This value does not fit this kind of price list.',
});

/** 422: a unique value of a record other than a product (a price list code, a resolution slot) is taken. */
export class DuplicateRecordError extends BusinessRuleError {
  readonly code = 'DUPLICATE_VALUE';
  readonly messageKey = 'mdm.duplicate_record';

  constructor(fields: readonly string[]) {
    super('a unique value is taken', details(fields.map((field) => ({ field, rule: 'TAKEN' })), 'mdm.duplicate_field'));
  }
}

/** 422 REFERENCE_NOT_FOUND for any record, with the request's JSON pointers. */
export function referencesNotFound(fields: readonly string[]): ReferenceNotFoundError {
  return new ReferenceNotFoundError(fields.map((field) => ({ field, rule: 'UNKNOWN' })));
}

/** 422: entries break a price rule (floor above list, list above ceiling, a zero floor, a grade of another species). */
export class PriceEntryInvalidError extends BusinessRuleError {
  readonly code = 'PRICE_ENTRY_INVALID';
  readonly messageKey = 'mdm.price_entry_invalid';

  constructor(fields: readonly FieldRule[]) {
    super('price list entries break a price rule', details(fields, 'mdm.price_entry_rule'));
  }
}

/** 422: two entries of one version would match the same request. */
export class PriceEntryDuplicateError extends BusinessRuleError {
  readonly code = 'PRICE_ENTRY_DUPLICATE';
  readonly messageKey = 'mdm.price_entry_duplicate';

  constructor(fields: readonly FieldRule[]) {
    super('two price list entries match the same request', details(fields, 'mdm.price_entry_duplicate_field'));
  }
}

registerMessages({
  'mdm.tax_matrix_incomplete': 'The tax scheme needs a cell for every tax category and levy.',
  'mdm.tax_matrix_gap': 'This category has no cell for this levy.',
  'mdm.tax_cell_invalid': 'Some tax cells are not valid.',
  'mdm.tax_cell_rule': 'This cell breaks a tax rule.',
  'mdm.tax_scheme_not_in_force': 'No approved tax scheme applies on this tax date.',
});

/** 422: a tax scheme version lacks a cell for some live category and levy (FR-MDM-012). Missing never means zero. */
export class TaxMatrixIncompleteError extends BusinessRuleError {
  readonly code = 'TAX_MATRIX_INCOMPLETE';
  readonly messageKey = 'mdm.tax_matrix_incomplete';

  constructor(missing: readonly { readonly categoryCode: string; readonly levyCode: string }[]) {
    super(
      'the tax matrix lacks cells',
      missing.map((gap) => ({ field: '/cells', code: `${gap.categoryCode}/${gap.levyCode}`, message: translate('mdm.tax_matrix_gap') })),
    );
  }
}

/** 422: a cell breaks a rule of ADR-0020: a rate on a non-standard treatment, a wrong or circular base, a repeated order. */
export class TaxCellInvalidError extends BusinessRuleError {
  readonly code = 'TAX_CELL_INVALID';
  readonly messageKey = 'mdm.tax_cell_invalid';

  constructor(fields: readonly FieldRule[]) {
    super('a tax cell breaks a tax rule', details(fields, 'mdm.tax_cell_rule'));
  }
}

/** 422: no ACTIVE tax scheme version covers the tax date asked for. */
export class TaxSchemeNotInForceError extends BusinessRuleError {
  readonly code = 'TAX_SCHEME_NOT_IN_FORCE';
  readonly messageKey = 'mdm.tax_scheme_not_in_force';

  constructor(taxDate: string) {
    super(`no tax scheme version is in force on ${taxDate}`, [{ field: '/taxDate', code: 'NOT_IN_FORCE', message: translate('mdm.tax_scheme_not_in_force') }]);
  }
}

registerMessages({
  'mdm.promotion_invalid': 'This promotion is not valid.',
  'mdm.promotion_rule': 'This value breaks a promotion rule.',
  'mdm.coupon_invalid': 'This coupon is not valid.',
  'mdm.coupon_rule': 'This value breaks a coupon rule.',
  'mdm.coupon_unavailable': 'This coupon cannot be used.',
});

/** 422: a promotion breaks a rule of FR-MDM-018: a value that does not fit its kind, a window, a target. */
export class PromotionInvalidError extends BusinessRuleError {
  readonly code = 'PROMOTION_INVALID';
  readonly messageKey = 'mdm.promotion_invalid';

  constructor(fields: readonly FieldRule[]) {
    super('a promotion breaks a promotion rule', details(fields, 'mdm.promotion_rule'));
  }
}

/** 422: a coupon breaks a rule: its code's form, or limits that are not positive or exceed one another. */
export class CouponInvalidError extends BusinessRuleError {
  readonly code = 'COUPON_INVALID';
  readonly messageKey = 'mdm.coupon_invalid';

  constructor(fields: readonly FieldRule[]) {
    super('a coupon breaks a coupon rule', details(fields, 'mdm.coupon_rule'));
  }
}

/** 422: a coupon exists but cannot be used now; `details[0].code` says why (EXPIRED, LIMIT_REACHED, NOT_APPLICABLE, ALREADY_USED). */
export class CouponUnavailableError extends BusinessRuleError {
  readonly code = 'COUPON_UNAVAILABLE';
  readonly messageKey = 'mdm.coupon_unavailable';

  constructor(field: string, reason: string) {
    super(`the coupon cannot be used: ${reason}`, [{ field, code: reason, message: translate('mdm.coupon_unavailable') }]);
  }
}

registerMessages({
  'mdm.record_in_use': 'This record is still in use, so it cannot be changed this way.',
  'mdm.record_in_use_rule': 'Still in use.',
  'mdm.weight_band_invalid': 'This weight band is not valid.',
  'mdm.weight_band_rule': 'Not a valid range for a weight band.',
});

/** 422: a category with live products or children, or a grade or band a live price uses, is archived or moved. */
export class RecordInUseError extends BusinessRuleError {
  readonly code = 'RECORD_IN_USE';
  readonly messageKey = 'mdm.record_in_use';

  constructor(rules: ReadonlyArray<{ readonly field: string | null; readonly rule: string }>) {
    super('the record is still in use', rules.map((rule) => ({ field: rule.field, code: rule.rule, message: translate('mdm.record_in_use_rule') })));
  }
}

/** 422: a weight band's range is empty, not three-place kilograms, or meets another band of the species. */
export class WeightBandInvalidError extends BusinessRuleError {
  readonly code = 'WEIGHT_BAND_INVALID';
  readonly messageKey = 'mdm.weight_band_invalid';

  constructor(rules: ReadonlyArray<{ readonly field: string | null; readonly rule: string }>) {
    super('the weight band is not valid', rules.map((rule) => ({ field: rule.field, code: rule.rule, message: translate('mdm.weight_band_rule') })));
  }
}

registerMessages({
  'mdm.location_invalid': 'This location does not fit the rules for locations.',
  'mdm.location_rule': 'Not allowed for this location.',
  'mdm.price_list_assignment_invalid': 'This price list cannot be assigned this way.',
  'mdm.price_list_assignment_rule': 'Not allowed for a customer price list.',
  'mdm.field_format': 'Not in a format we accept.',
});

/** 422: a location's parent is in another branch or virtual, a virtual location is created or changed, or a cold room lacks its range. */
export class LocationInvalidError extends BusinessRuleError {
  readonly code = 'LOCATION_INVALID';
  readonly messageKey = 'mdm.location_invalid';

  constructor(rules: ReadonlyArray<{ readonly field: string | null; readonly rule: string }>) {
    super('the location breaks a location rule', rules.map((rule) => ({ field: rule.field, code: rule.rule, message: translate('mdm.location_rule') })));
  }
}

/** 422: the list assigned to a customer is not a live CUSTOMER list, or the window ends before it starts. */
export class PriceListAssignmentInvalidError extends BusinessRuleError {
  readonly code = 'PRICE_LIST_ASSIGNMENT_INVALID';
  readonly messageKey = 'mdm.price_list_assignment_invalid';

  constructor(rules: ReadonlyArray<{ readonly field: string | null; readonly rule: string }>) {
    super('the price list cannot be assigned', rules.map((rule) => ({ field: rule.field, code: rule.rule, message: translate('mdm.price_list_assignment_rule') })));
  }
}

/** 400: a value the contract's pattern admits but MDM cannot store, such as a phone number that is no Ghanaian or E.164 number. */
export function invalidFormat(rules: ReadonlyArray<{ readonly field: string | null; readonly rule: string }>): ValidationFailedError {
  return new ValidationFailedError(
    'a value is not in an accepted format',
    rules.map((rule) => ({ field: rule.field, code: rule.rule, message: translate('mdm.field_format') })),
  );
}
