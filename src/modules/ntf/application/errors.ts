import { BusinessRuleError, type ErrorDetail } from '../../../platform/errors/api-error';
import { registerMessages, translate } from '../../../platform/i18n/messages';

/** NTF's user-facing messages (docs/API.md section 10). Registered when the module loads. */
registerMessages({
  'ntf.template_invalid': 'This message template cannot be saved like this.',
  'ntf.template_not_activatable': 'This template version cannot be made active.',
  'ntf.message_not_retryable': 'This message cannot be sent again.',
  'ntf.preferences_invalid': 'These message preferences cannot be saved like this.',
  'ntf.trigger_invalid': 'This trigger cannot be changed like this.',
});

function details(rules: readonly { readonly field: string; readonly rule: string }[], messageKey: string): ErrorDetail[] {
  return rules.map((rule) => ({ field: rule.field, code: rule.rule, message: translate(messageKey) }));
}

/**
 * 422 TEMPLATE_INVALID: a draft breaks a template rule; `details[].code` names it (`UNKNOWN_TEMPLATE_CODE`,
 * `CATEGORY_MISMATCH`, `UNKNOWN_MERGE_FIELD`, `LINK_NOT_ALLOWED`, `SUBJECT_EMAIL_ONLY`, `SUBJECT_REQUIRED`, `EMPTY_BODY`,
 * `TOO_LONG`; FR-NTF-001, abuse case 57).
 */
export class TemplateInvalidError extends BusinessRuleError {
  readonly code = 'TEMPLATE_INVALID';
  readonly messageKey = 'ntf.template_invalid';
  constructor(rules: readonly { readonly field: string; readonly rule: string }[]) {
    super(`template breaks ${rules.map((r) => r.rule).join(', ')}`, details(rules, 'ntf.template_invalid'));
  }
}

/** 422 TEMPLATE_NOT_ACTIVATABLE: a version that is not a draft (`NOT_DRAFT`), or one the actor drafted (`OWN_DRAFT`). */
export class TemplateNotActivatableError extends BusinessRuleError {
  readonly code = 'TEMPLATE_NOT_ACTIVATABLE';
  readonly messageKey = 'ntf.template_not_activatable';
  constructor(rule: 'NOT_DRAFT' | 'OWN_DRAFT') {
    super(`template cannot be activated: ${rule}`, details([{ field: '/id', rule }], 'ntf.template_not_activatable'));
  }
}

/** 422 MESSAGE_NOT_RETRYABLE: only a FAILED message is queued again (`NOT_FAILED`); a suppressed one never (`SUPPRESSED`). */
export class MessageNotRetryableError extends BusinessRuleError {
  readonly code = 'MESSAGE_NOT_RETRYABLE';
  readonly messageKey = 'ntf.message_not_retryable';
  constructor(rule: 'NOT_FAILED' | 'SUPPRESSED') {
    super(`message cannot be retried: ${rule}`, details([{ field: '/id', rule }], 'ntf.message_not_retryable'));
  }
}

/**
 * 422 PREFERENCES_INVALID (B11 continued 11): `details[].code` names the rule (`DUPLICATE_PREFERENCE`,
 * `QUIET_HOURS_INCOMPLETE`, `QUIET_HOURS_EMPTY`, `QUIET_HOURS_NOT_DELAYED`).
 */
export class PreferencesInvalidError extends BusinessRuleError {
  readonly code = 'PREFERENCES_INVALID';
  readonly messageKey = 'ntf.preferences_invalid';
  constructor(rules: readonly { readonly field: string; readonly rule: string }[]) {
    super(`preferences break ${rules.map((r) => r.rule).join(', ')}`, details(rules, 'ntf.preferences_invalid'));
  }
}

/**
 * 422 TRIGGER_INVALID (B11 continued 11): `details[].code` names the rule (`NO_CHANNEL`, `DUPLICATE_CHANNEL`,
 * `CHANNEL_NOT_FOR_RECIPIENT`, `TEMPLATE_FIXED`).
 */
export class TriggerInvalidError extends BusinessRuleError {
  readonly code = 'TRIGGER_INVALID';
  readonly messageKey = 'ntf.trigger_invalid';
  constructor(rules: readonly { readonly field: string; readonly rule: string }[]) {
    super(`trigger change breaks ${rules.map((r) => r.rule).join(', ')}`, details(rules, 'ntf.trigger_invalid'));
  }
}
