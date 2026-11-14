import { BusinessRuleError, type ErrorDetail } from '../../../platform/errors/api-error';
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
