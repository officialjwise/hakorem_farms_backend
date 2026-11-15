import { BusinessRuleError, type ErrorDetail } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';
import type { LivRuleBroken } from '../domain/rules';

/** LIV's user-facing messages (docs/API.md section 10). Registered when the module loads. */
registerMessages({
  'liv.livestock_record_invalid': 'This livestock record cannot be saved like this.',
  'liv.livestock_rule': 'This value is not valid on a livestock record.',
  'liv.reference_not_found': 'Something this record refers to does not exist.',
  'liv.mortality_photo_required': 'A photograph is required: the value written off is at or above the threshold.',
  'liv.ration_invalid': 'This ration is not valid.',
});

function details(fields: readonly LivRuleBroken[], messageKey: string): ErrorDetail[] {
  return fields.map((field) => ({ field: field.field, code: field.rule, message: translate(messageKey) }));
}

/**
 * 422 LIVESTOCK_RECORD_INVALID: a weight, health event, mortality or feed record breaks a livestock rule
 * (FR-LIV-004, FR-LIV-007 to FR-LIV-009, FR-LIV-012, FR-LIV-015). Each `details[].code` names it:
 * `ANIMAL_NOT_ALIVE`, `NOT_LIVESTOCK`, `ONE_HEAD_FOR_AN_ANIMAL`, `HEAD_ABOVE_FLOCK`, `IN_THE_FUTURE`,
 * `ANIMAL_OR_PEN_REQUIRED`, `PRODUCT_AND_QTY_TOGETHER`, `WITHDRAWAL_BELOW_PRODUCT`, `NOT_A_PEN`, `NO_ANIMALS_HERE`,
 * `NO_STORE`, `NOT_STOCKED_HERE`, `REASON_NOT_FOR_KIND`, `ALREADY_AWAITING_APPROVAL`, `SUBMITTER_NOT_REPORTER`, `PHOTO_NOT_USABLE`, `RECORD_REPEATED`, `ID_REUSED` and the
 * others in docs/API.md.
 */
export class LivestockRecordInvalidError extends BusinessRuleError {
  readonly code = 'LIVESTOCK_RECORD_INVALID';
  readonly messageKey = 'liv.livestock_record_invalid';

  constructor(fields: readonly LivRuleBroken[]) {
    super('the livestock record breaks a livestock rule', details(fields, 'liv.livestock_rule'));
  }
}

/** 422 MORTALITY_PHOTO_REQUIRED (FR-LIV-012, abuse case 2): at or above the threshold a photograph comes first. */
export class MortalityPhotoRequiredError extends BusinessRuleError {
  readonly code = 'MORTALITY_PHOTO_REQUIRED';
  readonly messageKey = 'liv.mortality_photo_required';

  constructor(valuePesewas: bigint, thresholdPesewas: bigint) {
    super(`a write-off of ${valuePesewas} pesewas is at or above the threshold of ${thresholdPesewas}`, [
      { field: '/photoFileId', code: 'PHOTO_REQUIRED', message: translate('liv.mortality_photo_required') },
    ]);
  }
}

/** 422 RATION_INVALID: `NOT_FEED`, `NAME_TAKEN` (FR-LIV-014). */
export class RationInvalidError extends BusinessRuleError {
  readonly code = 'RATION_INVALID';
  readonly messageKey = 'liv.ration_invalid';

  constructor(fields: readonly LivRuleBroken[]) {
    super('the ration breaks a rule', details(fields, 'liv.livestock_rule'));
  }
}

/** 422 REFERENCE_NOT_FOUND: an id in the request names no record (a stock unit, location, product, ration, file). */
export class LivReferenceNotFoundError extends BusinessRuleError {
  readonly code = 'REFERENCE_NOT_FOUND';
  readonly messageKey = 'liv.reference_not_found';

  constructor(fields: readonly string[]) {
    super('a referenced record does not exist', fields.map((field) => ({ field, code: 'REFERENCE_NOT_FOUND', message: translate('liv.reference_not_found') })));
  }
}
