import { ApiError, BusinessRuleError } from '../../../platform/errors/api-error';
import { registerMessages } from '../../../platform/i18n/messages';

/** IAM's user-facing messages (docs/API.md section 10.3). Registered when the module loads. */
registerMessages({
  'iam.invalid_credentials': 'The email, phone number or password is not right.',
  'iam.totp_invalid': 'That code is not right, or it was already used. Wait for the next code and try again.',
  'iam.challenge_expired': 'This sign-in took too long or was already finished. Please start again.',
  'iam.password_breached': 'This password has appeared in a data breach. Choose a different one.',
  'iam.password_too_short': 'Use at least 12 characters.',
  'iam.password_too_long': 'Use at most 128 characters.',
  'iam.password_same_as_identifier': 'Do not use your email address or phone number as your password.',
  'iam.csrf_token_invalid': 'Your session check failed. Reload the page and try again.',
  'iam.step_up_required': 'Enter a code from your authenticator app to continue.',
  'iam.totp_enrolment_required': 'Set up an authenticator app before doing this.',
  'iam.totp_already_enrolled': 'An authenticator app is already set up for this account.',
  'iam.password_change_required': 'Change your temporary password first.',
  'iam.maker_cannot_check': 'You made this request, so someone else must approve it.',
  'iam.approval_already_decided': 'This request was already decided.',
  'iam.approval_expired': 'This request lapsed before anyone decided it.',
  'iam.approval_subject_changed': 'The record changed after approval was requested. Ask for approval again.',
});

export class InvalidCredentialsError extends ApiError {
  readonly status = 401;
  readonly code = 'INVALID_CREDENTIALS';
  readonly messageKey = 'iam.invalid_credentials';
}

export class TotpInvalidError extends ApiError {
  readonly status = 401;
  readonly code = 'TOTP_INVALID';
  readonly messageKey = 'iam.totp_invalid';
}

export class ChallengeExpiredError extends ApiError {
  readonly status = 401;
  readonly code = 'CHALLENGE_EXPIRED';
  readonly messageKey = 'iam.challenge_expired';
}

export class PasswordBreachedError extends BusinessRuleError {
  readonly code = 'PASSWORD_BREACHED';
  readonly messageKey = 'iam.password_breached';
}

export class CsrfTokenInvalidError extends ApiError {
  readonly status = 403;
  readonly code = 'CSRF_TOKEN_INVALID';
  readonly messageKey = 'iam.csrf_token_invalid';
}

export class StepUpRequiredError extends ApiError {
  readonly status = 403;
  readonly code = 'STEP_UP_REQUIRED';
  readonly messageKey = 'iam.step_up_required';
}

export class TotpEnrolmentRequiredError extends ApiError {
  readonly status = 403;
  readonly code = 'TOTP_ENROLMENT_REQUIRED';
  readonly messageKey = 'iam.totp_enrolment_required';
}

export class PasswordChangeRequiredError extends ApiError {
  readonly status = 403;
  readonly code = 'PASSWORD_CHANGE_REQUIRED';
  readonly messageKey = 'iam.password_change_required';
}

export class TotpAlreadyEnrolledError extends BusinessRuleError {
  readonly code = 'TOTP_ALREADY_ENROLLED';
  readonly messageKey = 'iam.totp_already_enrolled';
}

export class MakerCannotCheckError extends BusinessRuleError {
  readonly code = 'MAKER_CANNOT_CHECK';
  readonly messageKey = 'iam.maker_cannot_check';
}

export class ApprovalAlreadyDecidedError extends BusinessRuleError {
  readonly code = 'APPROVAL_ALREADY_DECIDED';
  readonly messageKey = 'iam.approval_already_decided';
}

export class ApprovalExpiredError extends BusinessRuleError {
  readonly code = 'APPROVAL_EXPIRED';
  readonly messageKey = 'iam.approval_expired';
}

export class ApprovalSubjectChangedError extends BusinessRuleError {
  readonly code = 'APPROVAL_SUBJECT_CHANGED';
  readonly messageKey = 'iam.approval_subject_changed';
}
